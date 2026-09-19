import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { chooseParts, normaliseQuote } from '../src/server/brain/market';
import { marketPrompt } from '../src/server/brain/providers/prompts';

/**
 * Writes the market reading the Brain has already done as training data.
 *
 *   npm run export:training -- radico-khaitan [--out data/training]
 *
 * Every market signal in the database is an answer GPT gave to a question CIP
 * asked, and every one of them was checked against the report before it was
 * stored. That is a marked exam paper: the question, the answer, and a marker
 * who has already thrown out the wrong ones. It is the only reason a smaller
 * model is worth trying at all, and it costs nothing to take.
 *
 * The parts are cut with `chooseParts`, the quotes matched with
 * `normaliseQuote`, and the question asked with `marketPrompt` - the same three
 * functions the reading itself used. A fine-tuned model stands behind the same
 * OPENAI_BASE_URL and is handed the identical prompt, so training it on the
 * bare text instead would teach it to answer a question CIP never asks.
 *
 * WHAT IS DELIBERATELY THROWN AWAY
 *
 * A signal whose quote cannot be found in any part of its own report. It was
 * stored because it matched the part it was read from, and the part chosen for
 * it here is not that part - overlapping windows and a re-run of `chooseParts`
 * do not always agree. Keeping it would teach the model to quote text it was
 * never shown, which is the one failure this whole pipeline exists to prevent.
 *
 * The count of those is printed, because it is the number that says whether
 * this data is worth training on.
 *
 * THE SPLIT
 *
 * Eighty/twenty by report, not by part. Parts overlap, so two parts of one
 * report share sentences; splitting by part would put the same words in both
 * halves and the evaluation would flatter itself.
 */

const PRIVACY = `
  This writes the company's own documents to disk in plain text. The files it
  makes are training data, not something to share: they contain the report text
  and what was read from it.
`;

type Row = {
  source_id: string;
  file_id: string;
  file_name: string;
};

type Signal = {
  source_id: string;
  kind: string;
  subject: string;
  subject_type: string;
  market: string | null;
  category: string | null;
  metric: string | null;
  value: string | null;
  unit: string | null;
  period: string | null;
  statement: string;
  excerpt: string;
};

/** One training example: the part that was sent, and the signals it supported. */
type Example = {
  sourceId: string;
  fileName: string;
  part: number;
  parts: number;
  /** The whole question, exactly as CIP sends it. */
  prompt: string;
  signals: unknown[];
};

function signalForTraining(s: Signal): unknown {
  // Field order matters: the model learns to emit them in this order, and
  // `excerpt` comes last so the quote is written after the claim it supports
  // rather than before it.
  return {
    kind: s.kind,
    subject: s.subject,
    subject_type: s.subject_type,
    ...(s.market ? { market: s.market } : {}),
    ...(s.category ? { category: s.category } : {}),
    ...(s.metric ? { metric: s.metric } : {}),
    ...(s.value !== null ? { value: Number(s.value) } : {}),
    ...(s.unit ? { unit: s.unit } : {}),
    ...(s.period ? { period: s.period } : {}),
    statement: s.statement,
    excerpt: s.excerpt,
  };
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  const outArg = process.argv.indexOf('--out');
  const outDir = outArg > -1 ? process.argv[outArg + 1]! : 'data/training';

  if (!slug || slug.startsWith('--')) {
    console.error('\n  npm run export:training -- <company-slug> [--out data/training]\n');
    process.exit(1);
  }

  // Reading 27 reports out of the pooler takes a couple of minutes, and a
  // silent script that takes minutes is indistinguishable from a hung one.
  const say = (line: string): void => {
    process.stderr.write(line + '\n');
  };

  const connect = (): postgres.Sql =>
    postgres(process.env.DATABASE_ADMIN_URL!, {
      ssl: 'require',
      max: 1,
      onnotice: () => {},
      connect_timeout: 30,
    });

  let sql = connect();

  /**
   * Runs a query, and survives the connection dying under it.
   *
   * The pooler drops a connection somewhere in the middle of reading 5 MB of
   * report text - not always at the same report - and when it does, the pending
   * query neither resolves nor rejects. Nothing is then left holding the event
   * loop open, so node exits, quietly, with status 0: no error, no summary, no
   * files, and 27 reports of progress printed above it looking like success.
   *
   * That was mistaken three times for a hang, and once for a finished run.
   *
   * The timeout is what makes it visible. It must not be unref'd: the timer is
   * the only thing keeping the process alive while the dead query is waited on.
   */
  const withDb = async <T>(what: string, run: (db: postgres.Sql) => Promise<T>): Promise<T> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('no answer in 45s')), 45_000);
        });
        return await Promise.race([run(sql), expired]);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        say(`  ! ${what}: ${why} (attempt ${attempt} of 3) - reconnecting`);
        await sql.end({ timeout: 2 }).catch(() => {});
        sql = connect();
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new Error(`${what}: failed three times`);
  };

  try {
    const [company] = await withDb('company', (db) => db<{ id: string; name: string }[]>`
      select id, name from companies where slug = ${slug}
    `);
    if (!company) throw new Error(`no company "${slug}"`);

    // The roster and the markets as they stand now. They were not stored with
    // each reading, so a brand added since is named in a prompt that did not
    // name it then. That is the right way round: the prompt has to match what
    // CIP sends today, which is what the model will be asked tomorrow.
    const brands = await withDb('brands', (db) => db<{ name: string; note: string | null }[]>`
      select name, note from company_brands where company_id = ${company.id} order by name
    `);
    const markets = await withDb('markets', (db) => db<{ market: string }[]>`
      select distinct market from market_signals
       where company_id = ${company.id} and market is not null order by market
    `);
    const marketNames = markets.map((m) => m.market);
    say(`  ${brands.length} brands, ${marketNames.length} markets`);

    const sources = await withDb('reports', (db) => db<Row[]>`
      select s.id as source_id, s.file_id, f.name as file_name
        from market_sources s
        join drive_files f on f.id = s.file_id and f.company_id = s.company_id
       where s.company_id = ${company.id} and s.status = 'ready'
       order by s.created_at
    `);

    /**
     * The same text the reading saw, one report at a time.
     *
     * Two things were tried before this. Fetching every report's text in one
     * query returns `read ECONNRESET` after a minute of looking like it works,
     * and building the page text with string_agg stalls on the first annual
     * report. One file at a time, joined here, comes back steadily.
     *
     * It is not fast. Five and a half megabytes of report text crosses from
     * Tokyo a file at a time, and the whole export takes several minutes. That
     * is why it says which report it is on: silence for four minutes looks
     * exactly like a hang, and the first three attempts at this were abandoned
     * as hung when they were only slow.
     */
    const textFor = async (fileId: string): Promise<string> => {
      const companyId = company.id;
      const [row] = await withDb('text', (db) => db<{ content: string | null }[]>`
        select e.content
          from drive_file_extractions e
         where e.company_id = ${companyId} and e.file_id = ${fileId}
           and e.kind in ('text', 'ocr', 'transcript')
         order by e.content_chars desc, e.created_at desc
         limit 1
      `);
      const content = (row?.content ?? '').trim();
      if (content.length >= 40) return content;

      // No text layer. What the Brain read off the pages stands in for it.
      //
      // Joined here rather than with string_agg: an annual report's pages add up
      // to megabytes, and asking the pooler to build that string and hand it
      // back in one value stalls the connection until it is dropped. A row per
      // page comes back steadily.
      const pages = await withDb('pages', (db) => db<{ page_text: string | null; summary: string | null }[]>`
        select page_text, summary
          from pdf_page_understanding
         where company_id = ${companyId} and file_id = ${fileId} and status = 'ready'
         order by page_number
      `);
      const fromPages = pages
        .map((p) => [p.page_text, p.summary].filter(Boolean).join('\n'))
        .filter(Boolean)
        .join('\n\n')
        .trim();
      if (fromPages.length >= 40) return fromPages;

      const [asset] = await withDb('asset', (db) => db<{ extracted_text: string | null; summary: string | null }[]>`
        select extracted_text, summary
          from asset_understanding
         where company_id = ${companyId} and file_id = ${fileId} and status = 'ready'
         order by updated_at desc
         limit 1
      `);
      return [asset?.extracted_text, asset?.summary].filter(Boolean).join('\n').trim();
    };


    say(`  ${sources.length} reports`);

    // Rejected signals are the ones a person threw out. Training on them would
    // teach the model to produce exactly what somebody took the trouble to say
    // was wrong.
    /**
     * In pages of 300.
     *
     * All 1,823 in one go is a couple of megabytes of statements and quotes,
     * and the pooler answers it with `write CONNECTION_CLOSED` - then times out
     * on both retries, because whatever is wrong is with the size of the answer
     * and not with the connection carrying it. Smaller answers come back.
     */
    const signals: Signal[] = [];
    for (let page = 0; ; page += 1) {
      const batch = await withDb(`signals ${page * 300}+`, (db) => db<Signal[]>`
        select source_id, kind, subject, subject_type, market, category, metric,
               value, unit, period, statement, excerpt
          from market_signals
         where company_id = ${company.id} and status = 'active'
         order by source_id, created_at, id
         limit 300 offset ${page * 300}
      `);
      signals.push(...batch);
      if (batch.length < 300) break;
    }

    say(`  ${signals.length} signals`);

    const bySource = new Map<string, Signal[]>();
    for (const s of signals) {
      const list = bySource.get(s.source_id) ?? [];
      list.push(s);
      bySource.set(s.source_id, list);
    }

    const examples: Example[] = [];
    let orphaned = 0;
    let noText = 0;
    let placed = 0;

    for (const [n, source] of sources.entries()) {
      say(`  [${n + 1}/${sources.length}] ${source.file_name.slice(0, 50)}`);
      const text = await textFor(source.file_id);
      if (text.length < 40) {
        noText += 1;
        continue;
      }

      const mine = bySource.get(source.source_id) ?? [];
      if (mine.length === 0) continue;

      const { parts } = chooseParts(text);
      const haystacks = parts.map(normaliseQuote);
      const perPart: Signal[][] = parts.map(() => []);

      for (const signal of mine) {
        const needle = normaliseQuote(signal.excerpt);
        // The first part that contains the quote. Parts overlap, so a quote can
        // be in two; the earlier one is the one it would have been read from.
        const index = haystacks.findIndex((h) => h.includes(needle));
        if (index === -1) {
          orphaned += 1;
          continue;
        }
        perPart[index]!.push(signal);
        placed += 1;
      }

      for (let i = 0; i < parts.length; i += 1) {
        if (perPart[i]!.length === 0) continue;
        examples.push({
          sourceId: source.source_id,
          fileName: source.file_name,
          part: i + 1,
          parts: parts.length,
          prompt: marketPrompt({
            text: parts[i]!,
            filename: source.file_name,
            brands: brands.map((b) => ({ name: b.name, note: b.note })),
            markets: marketNames,
            part: i + 1,
            parts: parts.length,
          }),
          signals: perPart[i]!.map(signalForTraining),
        });
      }
    }

    say(`  built ${examples.length} examples`);

    // Split by report, so no two parts of one document straddle the split.
    const sourceIds = [...new Set(examples.map((e) => e.sourceId))];
    const cut = Math.max(1, Math.floor(sourceIds.length * 0.8));
    const trainIds = new Set(sourceIds.slice(0, cut));

    const train = examples.filter((e) => trainIds.has(e.sourceId));
    const test = examples.filter((e) => !trainIds.has(e.sourceId));

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'train.jsonl'), train.map(asJsonl).join('\n') + '\n');
    writeFileSync(join(outDir, 'test.jsonl'), test.map(asJsonl).join('\n') + '\n');

    say(`  wrote ${train.length} + ${test.length} to ${outDir}`);

    const chars = examples.reduce((n, e) => n + e.prompt.length, 0);

    console.log(`
  ${company.name}

    reports read              ${sources.length}
    reports with no text      ${noText}
    signals in the database   ${signals.length}
    signals placed in a part  ${placed}
    signals with no part      ${orphaned}${orphaned ? '   <- thrown away' : ''}

    training examples         ${examples.length}
      train.jsonl             ${train.length}   (${trainIds.size} reports)
      test.jsonl              ${test.length}   (${sourceIds.length - trainIds.size} reports)

    input text                ${(chars / 1000).toFixed(0)}k characters
    rough training tokens     ${((chars / 4) * 3).toFixed(0)} at 3 epochs

  Written to ${outDir}/
${PRIVACY}`);

    if (orphaned > signals.length * 0.15) {
      console.log(
        `  More than 15% of signals could not be placed. Before training on this,\n` +
          `  find out why: a changed extraction would do it, and so would a report\n` +
          `  that has been re-read since.\n`,
      );
    }
  } finally {
    await sql.end();
  }
}

function asJsonl(e: Example): string {
  return JSON.stringify({
    messages: [
      { role: 'user', content: e.prompt },
      { role: 'assistant', content: JSON.stringify({ signals: e.signals }) },
    ],
    meta: { file: e.fileName, part: e.part, of: e.parts },
  });
}

main().catch((error) => {
  console.error('\nexport failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

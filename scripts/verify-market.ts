/**
 * Checks market signals against the reports they were read from.
 *
 *   npm run verify:market -- <company-slug> [--sample 40] [--all] [--kind share] [--strict]
 *
 * Every signal is stored with the report's own words, and those words were
 * checked against the text at the moment it was read. This checks them again,
 * now, against what is stored — which is the only way to find out whether the
 * *reading* holds up, rather than whether the code did on the day.
 *
 * Two questions per signal, and the second is the one worth running this for:
 *
 *   1. Is the quote in the report, word for word?
 *   2. Is the number attached to it anywhere in that quote?
 *
 * A signal that passes the first and fails the second is a real sentence with
 * an invented figure beside it, which is exactly the failure this product
 * exists not to produce, and nothing until now would have found it.
 *
 * Read-only. It writes nothing, changes nothing and costs nothing: no model is
 * called, because the answer is in the text CIP already stored.
 */
import postgres from 'postgres';
import { normaliseQuote } from '../src/server/brain/market';

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {} });

const args = process.argv.slice(2);
const slug = args.find((arg) => !arg.startsWith('--'));
const ALL = args.includes('--all');
const STRICT = args.includes('--strict');
const SAMPLE = Number(valueOf('--sample') ?? 40);
const KIND = valueOf('--kind');

function valueOf(flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : null;
}

type Signal = {
  id: string;
  kind: string;
  subject: string;
  metric: string | null;
  value: string | null;
  unit: string | null;
  statement: string;
  excerpt: string;
  file_id: string;
  file_name: string;
};

/**
 * A sentence with the separators taken out of its numbers.
 *
 * Reports group digits every way there is: "518,812.12" in one, "5,18,812.12"
 * in an Indian filing, "37 102" in a WHO table, and "31 ,325.05" where a PDF
 * put a space after the comma. None of those is a different number, and a
 * check that called them missing would report seventy failures that are all
 * the check being wrong about the report.
 */
function compactNumbers(text: string): string {
  return text
    // Grouping commas, including "31 ,325.05" where a PDF put a space before
    // one. Never a comma with a space after it: "In 2019, 17% of people" is
    // two numbers and a sentence, not one number.
    .replace(/(?<=\d)\s*,(?=\d)/g, '')
    // A single space between a group of up to three digits and a group of
    // exactly three, which is how a WHO table writes 37 102. Not after a
    // decimal point, where "2.6 321.3" is two figures in a table row.
    .replace(/(?<![\d.,])(\d{1,3}) (\d{3})(?![\d.])/g, '$1$2')
    // A space before the decimal point, as "5,18,812 .14" arrived from a PDF.
    .replace(/(?<=\d) +(?=\.\d)/g, '');
}

/**
 * Whether the quote carries this number.
 *
 * Compared as numbers rather than as text, which is the only comparison that
 * is about the figure instead of about the typesetting: "17,480.70" is 17480.7,
 * "(92.9)" is -92.9 on a balance sheet, and "17%" carries 17. Matching strings
 * meant arguing with every convention a report might use, and losing.
 *
 * The magnitude counts as well as the signed value, because a fall written as
 * "(56.92%)" or "decreased by 56.92%" is the same fall stored as -56.92.
 */
function carries(excerpt: string, value: string): boolean {
  const wanted = Number(value);
  if (!Number.isFinite(wanted)) return excerpt.includes(value);

  // Both spellings: joining "37 102" into one number is right in a sentence
  // and wrong in a table, where "187 181" is two columns. Reading both ways
  // can only find a number that is there, never invent one that is not.
  const tokens = [
    ...(excerpt.match(/\d+(?:\.\d+)?/g) ?? []),
    ...(compactNumbers(excerpt).match(/\d+(?:\.\d+)?/g) ?? []),
  ];
  const magnitude = Math.abs(wanted);

  return tokens.some((token) => {
    const found = Number(token);
    if (!Number.isFinite(found)) return false;
    const tolerance = Math.max(Math.abs(found), magnitude, 1) * 1e-9;
    return Math.abs(found - magnitude) <= tolerance || Math.abs(found - wanted) <= tolerance;
  });
}

async function main(): Promise<void> {
  if (!slug) {
    console.error('Usage: npm run verify:market -- <company-slug> [--sample 40] [--all] [--kind share] [--strict]');
    process.exitCode = 1;
    return;
  }

  const [company] = await admin<{ id: string; name: string }[]>`
    select id, name from companies where slug = ${slug}
  `;
  if (!company) {
    console.error(`No company with the slug "${slug}".`);
    process.exitCode = 1;
    return;
  }

  // Spread across the whole set rather than taken from the top: the first
  // signals of a report are its summary pages, which are the easiest to quote
  // correctly and would flatter the result. md5 of the id is stable, so two
  // runs check the same signals and a fix is measurable.
  const signals = await admin<Signal[]>`
    select s.id, s.kind, s.subject, s.metric, s.value::text as value, s.unit,
           s.statement, s.excerpt, s.file_id, f.name as file_name
      from market_signals s
      join drive_files f on f.id = s.file_id
     where s.company_id = ${company.id}
       and s.status = 'active'
       ${KIND ? admin`and s.kind = ${KIND}` : admin``}
     order by md5(s.id::text)
     ${ALL ? admin`` : admin`limit ${Math.max(1, SAMPLE)}`}
  `;

  if (signals.length === 0) {
    console.log(`${company.name}: no active market signals to check.`);
    return;
  }

  const text = new Map<string, string>();
  const readFile = async (fileId: string): Promise<string> => {
    const cached = text.get(fileId);
    if (cached !== undefined) return cached;

    // Every reading of the file, in one haystack: a scanned report's words are
    // in its OCR extraction and a born-digital one's are in its text, and a
    // report can have both when only some of its pages were pictures.
    const rows = await admin<{ content: string }[]>`
      select content from drive_file_extractions where file_id = ${fileId}
    `;
    const haystack = normaliseQuote(rows.map((row) => row.content).join('\n'));
    text.set(fileId, haystack);
    return haystack;
  };

  let quoted = 0;
  let numbered = 0;
  let numeric = 0;
  let unreadable = 0;
  const failures: string[] = [];

  for (const signal of signals) {
    const haystack = await readFile(signal.file_id);
    if (haystack.length === 0) {
      unreadable += 1;
      failures.push(`  no stored text  ${signal.file_name}\n      ${signal.statement}`);
      continue;
    }

    const excerpt = normaliseQuote(signal.excerpt);
    const quoteOk = excerpt.length > 0 && haystack.includes(excerpt);
    if (quoteOk) quoted += 1;
    else failures.push(`  quote not in the report  ${signal.file_name}\n      said: ${signal.excerpt.slice(0, 160)}`);

    if (signal.value !== null) {
      numeric += 1;
      const found = carries(excerpt, signal.value);
      if (found) numbered += 1;
      else {
        failures.push(
          `  number not in its own quote  ${signal.file_name}\n` +
            `      ${signal.metric ?? signal.kind} = ${signal.value}${signal.unit ?? ''} for ${signal.subject}\n` +
            `      quote: ${signal.excerpt.slice(0, 160)}`,
        );
      }
    }
  }

  const pct = (n: number, of: number): string => (of === 0 ? '—' : `${Math.round((n / of) * 100)}%`);

  console.log(`\n${company.name} — ${signals.length} signal(s) checked${KIND ? ` (kind: ${KIND})` : ''}\n`);
  console.log(`  quote found in the report   ${quoted}/${signals.length}  (${pct(quoted, signals.length)})`);
  console.log(`  number found in its quote   ${numbered}/${numeric}  (${pct(numbered, numeric)})`);
  if (unreadable > 0) console.log(`  source text missing         ${unreadable}`);

  if (failures.length > 0) {
    console.log(`\nWhat did not hold up (${failures.length}):\n`);
    for (const failure of failures.slice(0, 25)) console.log(`${failure}\n`);
    if (failures.length > 25) console.log(`  ...and ${failures.length - 25} more.\n`);
  } else {
    console.log('\nEvery signal checked quotes its report and carries a number that quote supports.\n');
  }

  // A report, not a gate, unless somebody asks for a gate.
  if (STRICT && failures.length > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await admin.end();
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await admin.end();
    process.exitCode = 1;
  });

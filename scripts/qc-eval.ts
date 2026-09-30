import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import postgres from 'postgres';
import type { CompanyScope } from '../src/server/db';

/**
 * How right the QC checker is, measured against creatives whose answers are known.
 *
 *   npm run qc:eval -- <company-slug> <test-set.csv>           list what would run
 *   npm run qc:eval -- <company-slug> <test-set.csv> --run     run it (costs model calls)
 *
 * Every change to the checker so far was judged on made-up creatives. This is
 * how it is judged on real ones: a person writes down, for each file, whether
 * it should pass and which rules it breaks, and the checker is scored against
 * that - not against what it says about itself.
 *
 * THE TEST SET, one row per creative (a CSV with a header row):
 *
 *   file            the file's name exactly as it is in CIP (add it first)
 *   brand           optional; empty lets CIP work it out, as a reviewer would
 *   market          optional
 *   page            optional; which page of a PDF
 *   expected        pass | fix
 *   should_flag     the faults it has, separated by ";" - each a rule code
 *                   (RADICO-GLOBAL-002) or a few words of the rule or the
 *                   fault ("drink responsibly", "logo top-right")
 *   notes           anything; ignored
 *
 * WHAT IS REPORTED
 *
 *   verdict         how often "needs fixing / fine" was right
 *   recall          of the faults the creatives have, how many were flagged
 *   precision       of the flags raised, how many were real faults
 *
 * A flag counts as a real fault when it matches something in should_flag - by
 * code, or by those words appearing in its message or its rule. Written to a
 * results CSV beside the test set, one row per creative, so a miss can be
 * looked at rather than just counted.
 */

type Row = {
  file: string;
  brand: string;
  market: string;
  page: number;
  expected: 'pass' | 'fix';
  shouldFlag: string[];
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function readTestSet(path: string): Row[] {
  const [header, ...body] = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  if (!header) throw new Error('the test set is empty');
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const at = { file: col('file'), brand: col('brand'), market: col('market'), page: col('page'), expected: col('expected'), should: col('should_flag') };
  if (at.file < 0 || at.expected < 0) throw new Error('the test set needs at least "file" and "expected" columns');
  return body
    .map((r) => ({
      file: (r[at.file] ?? '').trim(),
      brand: at.brand >= 0 ? (r[at.brand] ?? '').trim() : '',
      market: at.market >= 0 ? (r[at.market] ?? '').trim() : '',
      page: Math.max(1, Number(at.page >= 0 ? r[at.page] : 1) || 1),
      expected: ((r[at.expected] ?? '').trim().toLowerCase() === 'pass' ? 'pass' : 'fix') as Row['expected'],
      shouldFlag: at.should >= 0 ? (r[at.should] ?? '').split(';').map((s) => s.trim()).filter(Boolean) : [],
    }))
    .filter((r) => r.file && !r.file.toLowerCase().startsWith('example'));
}

const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

async function main(): Promise<void> {
  const [slug, setPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const run = process.argv.includes('--run');
  if (!slug || !setPath) {
    console.error('\n  npm run qc:eval -- <company-slug> <test-set.csv> [--run]\n');
    process.exit(1);
  }
  const rows = readTestSet(setPath);

  const sql = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {}, connect_timeout: 30 });
  let scope: CompanyScope;
  const found: { row: Row; fileId: string | null }[] = [];
  const codes = new Map<string, string>();
  try {
    const [company] = await sql<{ id: string; name: string }[]>`select id, name from companies where slug = ${slug}`;
    if (!company) throw new Error(`no company "${slug}"`);
    const [owner] = await sql<{ user_id: string }[]>`
      select user_id from memberships where company_id = ${company.id} order by (role = 'owner') desc limit 1
    `;
    if (!owner) throw new Error('that company has nobody to run the checks as');
    scope = { companyId: company.id, userId: owner.user_id, role: 'owner' };

    for (const row of rows) {
      const [file] = await sql<{ id: string }[]>`
        select id from drive_files where company_id = ${company.id} and name = ${row.file} and archived_at is null limit 1
      `;
      found.push({ row, fileId: file?.id ?? null });
    }
    for (const r of await sql<{ id: string; rule_code: string }[]>`
      select id, rule_code from compliance_rules where company_id = ${company.id} and rule_code is not null
    `) codes.set(r.id, r.rule_code);

    console.log(`\n  ${company.name}: ${rows.length} creative(s) in the test set`);
    const missing = found.filter((f) => !f.fileId);
    if (missing.length > 0) {
      console.log(`\n  Not in CIP, so not checked - add them first:\n${missing.map((m) => `    ${m.row.file}`).join('\n')}`);
    }
  } finally {
    await sql.end();
  }

  const ready = found.filter((f) => f.fileId);
  if (!run) {
    console.log(`\n  ${ready.length} would be checked. Each is a real check and costs model calls.`);
    console.log('  Add --run to run them.\n');
    return;
  }

  const { runCheck } = await import('../src/server/brain/checker');
  const { reportOn } = await import('../src/server/brain/qc');

  let verdictRight = 0;
  let faults = 0;
  let caught = 0;
  let flagsRaised = 0;
  let flagsReal = 0;
  const lines = [['file', 'expected', 'got', 'verdict right', 'faults', 'caught', 'missed', 'flags', 'false flags', 'check id'].map(csvCell).join(',')];

  for (const [i, { row, fileId }] of ready.entries()) {
    process.stdout.write(`  [${i + 1}/${ready.length}] ${row.file} … `);
    try {
      const check = await runCheck(scope!, { fileId, brand: row.brand || null, market: row.market || null, page: row.page });
      const report = await reportOn(scope!, check);
      const flags = [...report.mustFix, ...report.toReview];
      const got = report.mustFix.length > 0 ? 'fix' : flags.some((f) => f.severity !== 'note') ? 'fix' : 'pass';

      // A flag matches an expected fault by code, or by its words.
      const text = (f: (typeof flags)[number]) =>
        [f.message, f.citedRule?.rule, ...(f.alsoRules ?? []).map((r) => r.rule), f.citedRule ? codes.get(f.citedRule.id) : null,
          ...(f.alsoRules ?? []).map((r) => codes.get(r.id))].filter(Boolean).join(' | ').toLowerCase();
      const matches = (f: (typeof flags)[number], expected: string) => text(f).includes(expected.toLowerCase());

      const hit = row.shouldFlag.filter((e) => flags.some((f) => matches(f, e)));
      const missed = row.shouldFlag.filter((e) => !hit.includes(e));
      const falseFlags = flags.filter((f) => f.severity !== 'note' && !row.shouldFlag.some((e) => matches(f, e)));
      const serious = flags.filter((f) => f.severity !== 'note');

      verdictRight += got === row.expected ? 1 : 0;
      faults += row.shouldFlag.length;
      caught += hit.length;
      flagsRaised += serious.length;
      flagsReal += serious.length - falseFlags.length;
      console.log(`${got === row.expected ? 'right' : 'WRONG'} (${got}), caught ${hit.length}/${row.shouldFlag.length}, ${falseFlags.length} false`);
      lines.push([row.file, row.expected, got, got === row.expected ? 'yes' : 'no', row.shouldFlag.length, hit.join('; '),
        missed.join('; '), serious.length, falseFlags.map((f) => f.message).join(' || '), check.id].map(csvCell).join(','));
    } catch (error) {
      console.log(`failed: ${error instanceof Error ? error.message : error}`);
      lines.push([row.file, row.expected, 'error', 'no', row.shouldFlag.length, '', row.shouldFlag.join('; '), 0, '', ''].map(csvCell).join(','));
    }
  }

  const out = join(dirname(setPath), `${basename(setPath).replace(/\.csv$/i, '')} - results ${new Date().toISOString().slice(0, 10)}.csv`);
  writeFileSync(out, `﻿${lines.join('\r\n')}\r\n`);
  console.log(`\n  verdict right   ${verdictRight}/${ready.length}  (${pct(verdictRight, ready.length)})`);
  console.log(`  recall          ${caught}/${faults} real faults flagged  (${pct(caught, faults)})`);
  console.log(`  precision       ${flagsReal}/${flagsRaised} flags were real faults  (${pct(flagsReal, flagsRaised)})`);
  console.log(`\n  Per creative: ${out}\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error('\neval failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { createFolder, uploadFile } from '../drive/service';
import { brain } from './providers';
import { BrainFailed, MARKET_SIGNAL_KINDS } from './providers/types';
import type { MarketSignalDraft, MarketSignalKind } from './providers/types';
import { brandForText, companyBrands } from './brands';
import type { Brand } from './brands';
import { companyMarkets } from './markets';

/**
 * Market intelligence: reports in, grounded signals out.
 *
 * A report becomes a source - uploaded on the Market Intelligence page, or
 * dropped in a Drive folder with "market intelligence" in its name. The Brain
 * reads its text in parts and reports what it states: shares, growth, prices,
 * competitor moves, consumer insight, regulation.
 *
 * Nothing is kept on the model's say-so. Every signal has to quote the report,
 * and the quote is looked for in the text that was actually sent; a signal
 * whose words are not there was made up, and is dropped. Whether a name is one
 * of the house's own brands is decided against the roster, not by the model -
 * a competitor filed as one of our brands would turn their numbers into ours.
 */

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Characters of report sent in one read. */
const PART_CHARS = envNumber('CIP_MARKET_PART_CHARS', 12_000);
/**
 * Reads per report. A 300-page annual report is mostly governance and notes to
 * the accounts; the reads go to the sections densest with market numbers.
 */
const MAX_PARTS = envNumber('CIP_MARKET_MAX_PARTS', 12);
/** Overlap between parts, so a sentence cut in two is whole in one of them. */
const OVERLAP = 400;
const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 15;
const ZERO_USER = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MARKET_FOLDER = 'Market Intelligence';

export class MarketRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketRejected';
  }
}

export type MarketSourceStatus = 'pending' | 'reading' | 'ready' | 'failed' | 'no_text';

export type MarketSourceDTO = {
  id: string;
  fileId: string;
  fileName: string;
  status: MarketSourceStatus;
  signals: number;
  summary: string | null;
  errorMessage: string | null;
  readAt: string | null;
  createdAt: string;
};

export type MarketSignalDTO = {
  id: string;
  kind: MarketSignalKind;
  subject: string;
  subjectType: 'own_brand' | 'competitor' | 'category';
  market: string | null;
  category: string | null;
  metric: string | null;
  value: number | null;
  unit: string | null;
  period: string | null;
  statement: string;
  excerpt: string;
  status: 'active' | 'rejected';
  fileId: string;
  fileName: string;
  createdAt: string;
};

export type GroundedSignal = Omit<MarketSignalDTO, 'id' | 'status' | 'fileId' | 'fileName' | 'createdAt'>;

/** Text compared as a person reads it: case, curly quotes and spacing aside. */
export function normaliseQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function clean(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Keeps the signals a report actually supports.
 *
 * Drops any whose quote is not in the text, decides own brand against the
 * roster, and folds a statement made twice into one.
 */
export function groundSignals(
  drafts: readonly MarketSignalDraft[],
  text: string,
  roster: readonly Brand[],
  markets: readonly string[],
  house: string,
): GroundedSignal[] {
  const haystack = normaliseQuote(text);
  const houseKey = normaliseQuote(house);
  const seen = new Set<string>();
  const kept: GroundedSignal[] = [];

  for (const draft of drafts) {
    const excerpt = (draft.excerpt ?? '').trim();
    const statement = (draft.statement ?? '').trim();
    const subjectRaw = (draft.subject ?? '').trim();
    if (excerpt.length < 12 || !statement || !subjectRaw) continue;
    if (!haystack.includes(normaliseQuote(excerpt))) continue;

    const key = normaliseQuote(statement);
    if (seen.has(key)) continue;
    seen.add(key);

    const ownBrand = brandForText(subjectRaw, roster);
    const subjectKey = normaliseQuote(subjectRaw);
    const isHouse = houseKey.length > 2 && (subjectKey.includes(houseKey) || houseKey.includes(subjectKey));

    let subject = subjectRaw.slice(0, 120);
    let subjectType: GroundedSignal['subjectType'];
    if (ownBrand) {
      subject = ownBrand;
      subjectType = 'own_brand';
    } else if (isHouse) {
      subject = house;
      subjectType = 'own_brand';
    } else if (draft.subjectType === 'category') {
      subjectType = 'category';
    } else {
      // Including a name the model called ours that is not on the roster.
      subjectType = 'competitor';
    }

    const kind = (MARKET_SIGNAL_KINDS as readonly string[]).includes(draft.kind) ? draft.kind : 'other';
    const value = typeof draft.value === 'number' && Number.isFinite(draft.value) ? draft.value : null;
    const rawMarket = clean(draft.market, 80);
    const market = rawMarket
      ? (markets.find((m) => m.toLowerCase() === rawMarket.toLowerCase()) ?? rawMarket)
      : null;

    kept.push({
      kind,
      subject,
      subjectType,
      market,
      category: clean(draft.category, 80),
      metric: clean(draft.metric, 120),
      value,
      unit: value === null ? null : clean(draft.unit, 40),
      period: clean(draft.period, 40),
      statement: statement.slice(0, 500),
      excerpt: excerpt.slice(0, 800),
    });
  }
  return kept;
}

const MARKET_WORDS =
  /\b(market share|share|volumes?|cases|growth|grew|declin\w*|premium|prestige|category|segment|whisk(?:e)?y|vodka|rum|brandy|gin|competitors?|consumers?|pric(?:e|es|ing)|distribution|excise|CAGR|YoY|market)\b/gi;
const MARKET_NUMBERS = /\d+(?:\.\d+)?\s?(?:%|per ?cent|crore|lakh|million|mn|bn|billion|cases)/gi;

/** How much a stretch of text says about the market: numbers count most. */
function marketDensity(text: string): number {
  return (text.match(MARKET_NUMBERS)?.length ?? 0) * 3 + (text.match(MARKET_WORDS)?.length ?? 0);
}

/**
 * The parts of a report worth reading, in document order.
 *
 * A short report is read whole. A long one is split into overlapping parts and
 * the ones densest with market numbers are read - reading only the first parts
 * of a prospectus meant reading its legal preamble and never its industry
 * section. `total` is how many parts there were, so the reading can say how
 * much of the document it covered.
 */
export function chooseParts(text: string): { parts: string[]; total: number } {
  const all: string[] = [];
  for (let start = 0; start < text.length; start += PART_CHARS - OVERLAP) {
    all.push(text.slice(start, start + PART_CHARS));
    if (start + PART_CHARS >= text.length) break;
  }
  if (all.length <= MAX_PARTS) return { parts: all, total: all.length };

  const chosen = all
    .map((part, index) => ({ index, score: marketDensity(part) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_PARTS)
    .sort((a, b) => a.index - b.index);
  return { parts: chosen.map((c) => all[c.index]!), total: all.length };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Marks a file as market data. Idempotent.
 *
 * It stops being brand material in the same breath: a market report is read for
 * what it says about the market, never for what this brand looks and sounds
 * like, so any brand reading still waiting for it is cancelled.
 */
export async function registerSource(scope: CompanyScope, fileId: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      insert into market_sources (company_id, file_id, added_by)
      values (${scope.companyId}, ${fileId}, ${scope.userId === ZERO_USER ? null : scope.userId})
      on conflict (company_id, file_id) do nothing
    `;
    await tx`
      update drive_files set knowledge_role = 'market', updated_at = now()
       where id = ${fileId} and company_id = ${scope.companyId} and knowledge_role <> 'market'
    `;
    await tx`
      delete from asset_understanding
       where company_id = ${scope.companyId} and file_id = ${fileId} and status = 'pending'
    `;
  });
}

/** The company's "Market Intelligence" folder, made the first time it is needed. */
async function marketFolderId(scope: CompanyScope): Promise<string> {
  const find = () =>
    withCompanyScope(scope, (tx) =>
      tx<{ id: string }[]>`
        select id from drive_folders
         where company_id = ${scope.companyId} and parent_id is null and archived_at is null
           and lower(name) = lower(${MARKET_FOLDER})
         limit 1
      `,
    );
  const existing = await find();
  if (existing[0]) return existing[0].id;
  try {
    return (await createFolder(scope, null, MARKET_FOLDER)).id;
  } catch (error) {
    const again = await find();
    if (again[0]) return again[0].id;
    throw error;
  }
}

/** Stores an uploaded report in the Market Intelligence folder and queues it. */
export async function addMarketFile(
  scope: CompanyScope,
  input: { filename: string; mimeType: string | null; body: Buffer },
): Promise<{ fileId: string; fileName: string }> {
  const folderId = await marketFolderId(scope);
  const file = await uploadFile(scope, { folderId, filename: input.filename, mimeType: input.mimeType, body: input.body });
  await registerSource(scope, file.id);
  return { fileId: file.id, fileName: file.name };
}

/**
 * Registers every file in a folder named for market intelligence, and in the
 * folders under it. Returns how many were new.
 */
export async function sweepMarketFolders(scope: CompanyScope): Promise<number> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      with recursive tree as (
        select id from drive_folders
         where company_id = ${scope.companyId} and archived_at is null
           and lower(name) like '%market%intel%'
        union
        select d.id from drive_folders d
          join tree t on d.parent_id = t.id
         where d.company_id = ${scope.companyId} and d.archived_at is null
      )
      insert into market_sources (company_id, file_id)
      select ${scope.companyId}, f.id
        from drive_files f
       where f.company_id = ${scope.companyId}
         and f.archived_at is null
         and f.folder_id in (select id from tree)
      on conflict (company_id, file_id) do nothing
      returning id
    `;
    // What is market data is not brand material; nothing waiting reads it as such.
    await tx`
      update drive_files f set knowledge_role = 'market', updated_at = now()
       where f.company_id = ${scope.companyId} and f.knowledge_role = 'brand'
         and exists (select 1 from market_sources m where m.company_id = f.company_id and m.file_id = f.id)
    `;
    await tx`
      delete from asset_understanding u
       where u.company_id = ${scope.companyId} and u.status = 'pending'
         and exists (select 1 from market_sources m where m.company_id = u.company_id and m.file_id = u.file_id)
    `;
    return rows.length;
  });
}

/** The same sweep, for every company, scoped properly for each. */
export async function sweepMarketFoldersEverywhere(): Promise<number> {
  const sql = adminSql();
  let companies: { id: string }[];
  try {
    companies = await sql<{ id: string }[]>`select id from companies`;
  } finally {
    await sql.end();
  }
  let added = 0;
  for (const company of companies) {
    added += await sweepMarketFolders({ companyId: company.id, userId: ZERO_USER, role: 'owner' });
  }
  return added;
}

/** Puts a report back in the queue, to be read again from the start. */
export async function rereadSource(scope: CompanyScope, sourceId: string): Promise<boolean> {
  if (!UUID.test(sourceId)) return false;
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update market_sources
         set status = 'pending', attempts = 0, error_message = null, updated_at = now()
       where id = ${sourceId} and company_id = ${scope.companyId}
      returning id
    `;
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ClaimedMarketSource = {
  id: string;
  companyId: string;
  companyName: string;
  fileId: string;
  attempts: number;
};

export type MarketReadOutcome =
  | { status: 'ready'; signals: number }
  | { status: 'no_text' }
  | { status: 'retry' | 'failed'; message: string };

/**
 * Claims the next report to read, across companies.
 *
 * Waits for text extraction to finish first, except for files text extraction
 * never touches - an image is claimed straight away and told it has no text,
 * rather than waiting for ever.
 */
export async function claimMarketSource(): Promise<ClaimedMarketSource | null> {
  const sql = adminSql();
  try {
    const rows = await sql<{ id: string; company_id: string; company_name: string; file_id: string; attempts: number }[]>`
      update market_sources s
         set status = 'reading', claimed_at = now(), attempts = s.attempts + 1, updated_at = now()
       where s.id = (
         select m.id
           from market_sources m
           join drive_files f on f.id = m.file_id and f.company_id = m.company_id
          where f.archived_at is null
            and m.attempts < ${MAX_ATTEMPTS}
            and (f.processing_status in ('processed', 'failed')
                 or f.mime_type like 'image/%' or f.mime_type like 'video/%' or f.mime_type like 'audio/%')
            -- A report that waited or failed once is looked at again after a
            -- pause, not straight away in the same pass.
            and (m.status = 'pending' and (m.error_message is null or m.updated_at < now() - interval '2 minutes')
                 or (m.status = 'reading' and m.claimed_at < now() - make_interval(mins => ${STALE_MINUTES})))
          order by m.created_at
          for update of m skip locked
          limit 1
       )
      returning s.id, s.company_id, s.file_id, s.attempts,
                (select c.name from companies c where c.id = s.company_id) as company_name
    `;
    const row = rows[0];
    return row
      ? { id: row.id, companyId: row.company_id, companyName: row.company_name, fileId: row.file_id, attempts: row.attempts }
      : null;
  } finally {
    await sql.end();
  }
}

async function setSource(
  scope: CompanyScope,
  sourceId: string,
  status: MarketSourceStatus,
  errorMessage: string | null,
): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update market_sources
         set status = ${status}, error_message = ${errorMessage}, updated_at = now()
       where id = ${sourceId} and company_id = ${scope.companyId}
    `;
  });
}

export async function readClaimedMarketSource(claim: ClaimedMarketSource): Promise<MarketReadOutcome> {
  const scope: CompanyScope = { companyId: claim.companyId, userId: ZERO_USER, role: 'owner' };
  const provider = brain();

  const document = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{
      name: string; mime_type: string; created_at: Date; content: string | null;
      seen: string | null; waiting: boolean;
    }[]>`
      select f.name, f.mime_type, f.created_at,
             (select e.content from drive_file_extractions e
               where e.company_id = f.company_id and e.file_id = f.id
                 and e.kind in ('text', 'ocr', 'transcript')
               -- The longest reading wins: a scanned report's text layer is
               -- empty, and the text read off its pages is not.
               order by e.content_chars desc, e.created_at desc
               limit 1) as content,
             -- What the Brain read off the file by looking at it: a scanned
             -- report's pages, a chart's labels. Used only when there is no
             -- text layer to read instead.
             nullif(concat_ws(chr(10) || chr(10),
               (select string_agg(concat_ws(chr(10), p.page_text, p.summary), chr(10) || chr(10) order by p.page_number)
                  from pdf_page_understanding p
                 where p.company_id = f.company_id and p.file_id = f.id and p.status = 'ready'),
               (select concat_ws(chr(10), u.extracted_text, u.summary)
                  from asset_understanding u
                 where u.company_id = f.company_id and u.file_id = f.id and u.status = 'ready'
                 order by u.updated_at desc
                 limit 1)
             ), '') as seen,
             exists (select 1 from asset_understanding u
                      where u.company_id = f.company_id and u.file_id = f.id
                        and u.status not in ('ready', 'failed', 'unsupported'))
             or exists (select 1 from file_ocr o
                         where o.company_id = f.company_id and o.file_id = f.id
                           and o.status in ('pending', 'reading')) as waiting
        from drive_files f
       where f.id = ${claim.fileId} and f.company_id = ${scope.companyId}
    `;
    return rows[0] ?? null;
  });

  if (!document) {
    const message = 'The file is no longer there.';
    await setSource(scope, claim.id, 'failed', message);
    return { status: 'failed', message };
  }

  let text = (document.content ?? '').trim();
  if (text.length < 40) text = (document.seen ?? '').trim();

  if (text.length < 40) {
    // A scanned report or a picture of a chart has no text layer, but CIP may
    // not have looked at it yet. Calling it unreadable before then would be
    // wrong, so it goes back in the queue - without spending an attempt - for
    // up to a day, which is far longer than looking at anything takes.
    const mime = document.mime_type.toLowerCase();
    const visual = mime === 'application/pdf' || mime.startsWith('image/');
    const young = Date.now() - document.created_at.getTime() < 24 * 60 * 60 * 1000;
    if (document.waiting || (visual && young)) {
      await withCompanyScope(scope, (tx) => tx`
        update market_sources
           set status = 'pending', attempts = greatest(attempts - 1, 0), updated_at = now(),
               error_message = 'Waiting for CIP to finish looking at this file.'
         where id = ${claim.id} and company_id = ${scope.companyId}
      `);
      return { status: 'retry', message: 'Waiting for CIP to finish looking at this file.' };
    }
  }

  if (text.length < 40) {
    await setSource(
      scope,
      claim.id,
      'no_text',
      'CIP found no readable text in this file. A scanned report needs to be a searchable PDF, or exported as Excel, CSV or Word.',
    );
    return { status: 'no_text' };
  }

  const [roster, markets] = await Promise.all([companyBrands(scope), companyMarkets(scope)]);
  const marketNames = markets.map((m) => m.market);
  const { parts, total } = chooseParts(text);
  const found: GroundedSignal[] = [];
  let summary = '';

  try {
    for (let i = 0; i < parts.length; i += 1) {
      const reading = await provider.readMarketDocument({
        text: parts[i]!,
        filename: document.name,
        brands: roster.map((b) => ({ name: b.name, note: b.note })),
        markets: marketNames,
        part: i + 1,
        parts: parts.length,
      });
      if (!summary && reading.summary.trim()) summary = reading.summary.trim();
      found.push(...groundSignals(reading.signals, parts[i]!, roster, marketNames, claim.companyName));
    }
  } catch (error) {
    const retry = error instanceof BrainFailed && error.kind !== 'permanent' && claim.attempts < MAX_ATTEMPTS;
    const message = error instanceof BrainFailed ? error.message : 'Reading this report failed.';
    await setSource(scope, claim.id, retry ? 'pending' : 'failed', message);
    return { status: retry ? 'retry' : 'failed', message };
  }

  // The same statement from two overlapping parts is one signal.
  const seen = new Set<string>();
  const unique = found.filter((signal) => {
    const key = normaliseQuote(signal.statement);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const truncated = total > parts.length;
  const count = await withCompanyScope(scope, async (tx) => {
    // What was found last time goes, except what a person removed: that stays
    // removed, and the unique index keeps the reading from bringing it back.
    await tx`
      delete from market_signals
       where company_id = ${scope.companyId} and source_id = ${claim.id} and status = 'active'
    `;
    for (const s of unique) {
      await tx`
        insert into market_signals
          (company_id, source_id, file_id, kind, subject, subject_type, market, category,
           metric, value, unit, period, statement, excerpt)
        values
          (${scope.companyId}, ${claim.id}, ${claim.fileId}, ${s.kind}, ${s.subject}, ${s.subjectType},
           ${s.market}, ${s.category}, ${s.metric}, ${s.value}, ${s.unit}, ${s.period},
           ${s.statement}, ${s.excerpt})
        on conflict (company_id, file_id, statement) do nothing
      `;
    }
    const rows = await tx<{ n: number }[]>`
      select count(*)::int as n from market_signals
       where company_id = ${scope.companyId} and source_id = ${claim.id} and status = 'active'
    `;
    const n = rows[0]?.n ?? 0;
    const note = truncated
      ? ` Read the ${parts.length} sections densest with market figures, of ${total} in this long document.`
      : '';
    await tx`
      update market_sources
         set status = 'ready', signals = ${n}, summary = ${(summary || null) && `${summary}${note}`},
             error_message = null, read_at = now(), provider = ${provider.name}, model = ${provider.model},
             updated_at = now()
       where id = ${claim.id} and company_id = ${scope.companyId}
    `;
    return n;
  });

  return { status: 'ready', signals: count };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

type SignalRow = {
  id: string; kind: MarketSignalKind; subject: string; subject_type: MarketSignalDTO['subjectType'];
  market: string | null; category: string | null; metric: string | null; value: string | null;
  unit: string | null; period: string | null; statement: string; excerpt: string;
  status: 'active' | 'rejected'; file_id: string; file_name: string; created_at: Date;
};

const toSignal = (row: SignalRow): MarketSignalDTO => ({
  id: row.id,
  kind: row.kind,
  subject: row.subject,
  subjectType: row.subject_type,
  market: row.market,
  category: row.category,
  metric: row.metric,
  value: row.value === null ? null : Number(row.value),
  unit: row.unit,
  period: row.period,
  statement: row.statement,
  excerpt: row.excerpt,
  status: row.status,
  fileId: row.file_id,
  fileName: row.file_name,
  createdAt: row.created_at.toISOString(),
});

/**
 * Signals a brand may see: its own, its competitors' and the category's. A
 * sibling brand's numbers are not this brand's market.
 */
async function readSignals(
  scope: CompanyScope,
  options: { brand: string | null; activeOnly: boolean; limit: number },
): Promise<MarketSignalDTO[]> {
  const rows = await withCompanyScope(scope, (tx) =>
    tx<SignalRow[]>`
      select s.id, s.kind, s.subject, s.subject_type, s.market, s.category, s.metric, s.value,
             s.unit, s.period, s.statement, s.excerpt, s.status, s.file_id, f.name as file_name, s.created_at
        from market_signals s
        join drive_files f on f.id = s.file_id and f.company_id = s.company_id
       where s.company_id = ${scope.companyId}
         and f.archived_at is null
         and (${options.activeOnly} = false or s.status = 'active')
         and (${options.brand}::text is null or s.subject_type <> 'own_brand' or s.subject = ${options.brand})
       order by s.created_at desc, s.statement
       limit ${options.limit}
    `,
  );
  return rows.map(toSignal);
}

export async function marketOverview(
  scope: CompanyScope,
  options: { brand: string | null },
): Promise<{ sources: MarketSourceDTO[]; signals: MarketSignalDTO[] }> {
  const [sources, signals] = await Promise.all([
    withCompanyScope(scope, (tx) =>
      tx<{
        id: string; file_id: string; file_name: string; status: MarketSourceStatus; signals: number;
        summary: string | null; error_message: string | null; read_at: Date | null; created_at: Date;
      }[]>`
        select m.id, m.file_id, f.name as file_name, m.status, m.signals, m.summary, m.error_message,
               m.read_at, m.created_at
          from market_sources m
          join drive_files f on f.id = m.file_id and f.company_id = m.company_id
         where m.company_id = ${scope.companyId} and f.archived_at is null
         order by m.created_at desc
         limit 200
      `,
    ),
    readSignals(scope, { brand: options.brand, activeOnly: false, limit: 500 }),
  ]);

  return {
    sources: sources.map((row) => ({
      id: row.id,
      fileId: row.file_id,
      fileName: row.file_name,
      status: row.status,
      signals: row.signals,
      summary: row.summary,
      errorMessage: row.error_message,
      readAt: row.read_at ? row.read_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    })),
    signals,
  };
}

/** What the Brain may cite in an answer: active signals, within the brand. */
export async function marketSignalsFor(
  scope: CompanyScope,
  options: { brand: string | null; limit?: number },
): Promise<MarketSignalDTO[]> {
  return readSignals(scope, { brand: options.brand, activeOnly: true, limit: options.limit ?? 200 });
}

/** A person removing a signal, or putting one back. */
export async function setSignalStatus(
  scope: CompanyScope,
  signalId: string,
  status: 'active' | 'rejected',
): Promise<boolean> {
  if (!UUID.test(signalId)) return false;
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string; source_id: string }[]>`
      update market_signals
         set status = ${status},
             rejected_by = ${status === 'rejected' && scope.userId !== ZERO_USER ? scope.userId : null},
             rejected_at = ${status === 'rejected' ? new Date() : null}
       where id = ${signalId} and company_id = ${scope.companyId}
      returning id, source_id
    `;
    const row = rows[0];
    if (!row) return false;
    await tx`
      update market_sources
         set signals = (select count(*)::int from market_signals
                         where company_id = ${scope.companyId} and source_id = ${row.source_id} and status = 'active'),
             updated_at = now()
       where id = ${row.source_id} and company_id = ${scope.companyId}
    `;
    return true;
  });
}

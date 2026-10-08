import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { uploadFile } from '../drive/service';
import { registerSource } from './market';
import { brain } from './providers';

/**
 * A listed company's filings on the stock exchange, fetched as they appear.
 *
 * Market Intelligence read only what somebody uploaded, so a quarter's results
 * arrived whenever somebody remembered to download them. A listed company has
 * to file its results, earnings call transcripts and investor presentations
 * with the exchange, and they are public the moment they are filed. This
 * watches a company's filings on NSE, fetches the ones worth reading, and hands
 * them to Market Intelligence exactly as an upload would be handed over.
 *
 * NSE, not BSE: BSE refuses requests that do not come from a browser. NSE
 * answers, though it is known to refuse some cloud servers too - and when it
 * refuses, the feed says so on the screen rather than going quiet.
 *
 * Not a news service. Filings only: what the companies themselves publish.
 */

export type MarketFeedDTO = {
  id: string;
  exchange: 'nse';
  symbol: string;
  displayName: string;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  recent: { title: string; category: string | null; publishedAt: string | null; fileId: string | null }[];
};

/** One announcement as NSE lists it. */
export type NseAnnouncement = {
  seq_id: string;
  an_dt: string;
  desc: string | null;
  attchmntText: string | null;
  attchmntFile: string | null;
  sm_name: string | null;
  symbol: string;
};

const NSE = 'https://www.nseindia.com';
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  referer: `${NSE}/companies-listing/corporate-filings-announcements`,
};
/** How often a feed is looked at. Filings come a few times a quarter. */
const EVERY_HOURS = 3;
/** Filings older than this are not fetched on a feed's first look. */
const BACKFILL_DAYS = 120;
/** The largest filing fetched. An annual report is under this; a scanned bundle may not be. */
const MAX_BYTES = 30 * 1024 * 1024;
/** Where fetched filings are kept. Its name puts it under Market Intelligence. */
const FOLDER = 'Market Intelligence - Exchange filings';

let fetcher: typeof fetch = (...args) => fetch(...args);
/** Tests stand in for NSE. */
export function __setFilingsFetch(next: typeof fetch | null): void {
  fetcher = next ?? ((...args) => fetch(...args));
}

export class FilingsRefused extends Error {}

/**
 * Whether a filing says something about the market.
 *
 * Results, what management told analysts, investor presentations, annual
 * reports and press releases. Not the paperwork every listed company files
 * every month - trading windows, lost share certificates, newspaper notices.
 */
export function worthReading(a: Pick<NseAnnouncement, 'desc' | 'attchmntText'>): boolean {
  const text = `${a.desc ?? ''} ${a.attchmntText ?? ''}`;
  if (/trading window|newspaper|duplicate share|loss of share|share certificate|book closure|record date|regulation 74|reg\.? ?74|change in (director|auditor|registrar)|esop|esos|credit rating|postal ballot|scrutinizer|voting results|closure of trading|copy of newspaper/i.test(text)) {
    return false;
  }
  // What was said and shown to analysts is worth reading; that a meeting is
  // going to happen is not. Radico files a notice before every investor
  // meeting, and each one is a date and a list of funds.
  if (/transcript|investor presentation|earnings presentation/i.test(text)) return true;
  if (/investor meet|analyst meet|investor meeting|intimation|schedule of/i.test(text)) return false;
  return /financial result|results|earnings|press release|annual report|integrated report|outcome of board meeting/i.test(text);
}

/** "28-Sep-2026 08:57:49" as a date. */
function nseDate(value: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?/.exec(value.trim());
  if (!m) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2]!.toLowerCase());
  if (month < 0) return null;
  // NSE's times are Indian Standard Time.
  return new Date(Date.UTC(+m[3]!, month, +m[1]!, +(m[4] ?? 0) - 5, +(m[5] ?? 0) - 30, +(m[6] ?? 0)));
}

/** 5 October 2026 as NSE writes it: "05-10-2026". */
function nseDay(date: Date): string {
  const ist = new Date(date.getTime() + 330 * 60_000);
  return `${String(ist.getUTCDate()).padStart(2, '0')}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${ist.getUTCFullYear()}`;
}

/**
 * A company's announcements on NSE since a date, newest first.
 *
 * Always for a window: asked for none, NSE sends every announcement since
 * 2005 - over a thousand for Radico - on every check.
 */
export async function nseAnnouncements(symbol: string, since: Date): Promise<NseAnnouncement[]> {
  const url =
    `${NSE}/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}` +
    `&from_date=${nseDay(since)}&to_date=${nseDay(new Date())}`;
  const res = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (res.status === 401 || res.status === 403) {
    throw new FilingsRefused('NSE refused the request from this server. Filings will be retried on the next check.');
  }
  if (!res.ok) throw new FilingsRefused(`NSE answered ${res.status}. Filings will be retried on the next check.`);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(body)) throw new FilingsRefused('NSE sent back something that was not a list of filings.');
  return (body as NseAnnouncement[])
    .filter((a) => a && typeof a.seq_id === 'string')
    .sort((a, b) => (nseDate(b.an_dt)?.getTime() ?? 0) - (nseDate(a.an_dt)?.getTime() ?? 0));
}

/** A filing's PDF, or null when it is not a PDF or is too large to keep. */
async function download(url: string): Promise<Buffer | null> {
  if (!/^https:\/\/(nsearchives|archives|www)\.nseindia\.com\//i.test(url)) return null;
  const res = await fetcher(url, { headers: { ...HEADERS, accept: 'application/pdf,*/*' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new FilingsRefused(`NSE refused a filing (${res.status}).`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES || bytes.subarray(0, 4).toString('latin1') !== '%PDF') return null;
  return bytes;
}

/** The folder filings are kept in, made the first time. */
async function filingsFolder(scope: CompanyScope): Promise<string> {
  return withCompanyScope(scope, async (tx) => {
    const found = await tx<{ id: string }[]>`
      select id from drive_folders
       where company_id = ${scope.companyId} and parent_id is null and name = ${FOLDER} and archived_at is null
       limit 1
    `;
    if (found[0]) return found[0].id;
    const made = await tx<{ id: string }[]>`
      insert into drive_folders (company_id, parent_id, name, created_by)
      values (${scope.companyId}, null, ${FOLDER}, ${scope.userId})
      returning id
    `;
    return made[0]!.id;
  });
}

function fileName(feed: { displayName: string }, a: NseAnnouncement): string {
  const when = nseDate(a.an_dt)?.toISOString().slice(0, 10) ?? 'undated';
  const what = (a.desc ?? 'Filing').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80);
  return `${feed.displayName} - ${what} - ${when}.pdf`;
}

type FeedRow = { id: string; symbol: string; display_name: string; last_checked_at: Date | null; caught_up: boolean };

/**
 * Looks at one feed: records every new filing, and fetches the ones worth
 * reading, up to `maxDownloads` - the rest wait for the next look.
 */
export async function checkFeed(
  scope: CompanyScope,
  feed: FeedRow,
  options: { maxDownloads?: number } = {},
): Promise<{ fetched: number; skipped: number; waiting: number }> {
  const maxDownloads = options.maxDownloads ?? 3;
  let fetched = 0;
  let skipped = 0;
  let waiting = 0;
  try {
    // Back the full window until everything in it has been fetched; after
    // that, a fortnight is plenty to overlap the last look.
    const windowDays = feed.caught_up ? 14 : BACKFILL_DAYS;
    const listed = await nseAnnouncements(feed.symbol, new Date(Date.now() - windowDays * 86_400_000));
    const seen = new Set(
      (await withCompanyScope(scope, (tx) =>
        tx<{ external_id: string }[]>`select external_id from market_feed_items where feed_id = ${feed.id}`,
      )).map((r) => r.external_id),
    );
    // Only what is recent: a company's whole filing history is not this
    // quarter's market.
    const since = Date.now() - windowDays * 86_400_000;

    let folderId: string | null = null;
    for (const a of listed) {
      if (seen.has(a.seq_id)) continue;
      const published = nseDate(a.an_dt);
      if (since && published && published.getTime() < since) continue;
      const title = (a.attchmntText ?? a.desc ?? 'Filing').replace(/\s+/g, ' ').trim().slice(0, 500);

      const record = (status: 'fetched' | 'skipped', fileId: string | null) =>
        withCompanyScope(scope, (tx) => tx`
          insert into market_feed_items (company_id, feed_id, external_id, title, category, published_at, url, file_id, status)
          values (${scope.companyId}, ${feed.id}, ${a.seq_id}, ${title}, ${a.desc}, ${published}, ${a.attchmntFile}, ${fileId}, ${status})
          on conflict (feed_id, external_id) do nothing
        `);

      if (!worthReading(a) || !a.attchmntFile) {
        await record('skipped', null);
        skipped += 1;
        continue;
      }
      if (fetched >= maxDownloads) {
        waiting += 1;
        continue;
      }
      const bytes = await download(a.attchmntFile);
      if (!bytes) {
        await record('skipped', null);
        skipped += 1;
        continue;
      }
      folderId ??= await filingsFolder(scope);
      const file = await uploadFile(scope, {
        folderId,
        filename: fileName({ displayName: feed.display_name }, a),
        mimeType: 'application/pdf',
        body: bytes,
        sourceType: 'exchange_filing',
      });
      // Read for the market, straight away - not when a folder sweep finds it.
      await registerSource(scope, file.id);
      await record('fetched', file.id);
      fetched += 1;
    }

    await withCompanyScope(scope, (tx) => tx`
      update market_feeds set last_checked_at = now(), last_error = null, caught_up = ${waiting === 0} where id = ${feed.id}
    `);
  } catch (error) {
    const message = error instanceof FilingsRefused ? error.message : 'The filings could not be checked. They will be retried.';
    await withCompanyScope(scope, (tx) => tx`
      update market_feeds set last_checked_at = now(), last_error = ${message.slice(0, 300)} where id = ${feed.id}
    `).catch(() => {});
  }
  return { fetched, skipped, waiting };
}

/** Every feed due a look, for every company. Bounded, for the pump. */
export async function checkFeedsEverywhere(options: { outOfTime: () => boolean }): Promise<number> {
  const sql = adminSql();
  let due: (FeedRow & { company_id: string; user_id: string | null })[];
  try {
    due = await sql`
      select f.id, f.symbol, f.display_name, f.last_checked_at, f.caught_up, f.company_id,
             coalesce(f.added_by, (select m.user_id from memberships m where m.company_id = f.company_id
                                     order by (m.role = 'owner') desc limit 1)) as user_id
        from market_feeds f
       where f.enabled
         -- Due every few hours, or straight away while a backlog remains.
         and (f.last_checked_at is null or not f.caught_up
              or f.last_checked_at < now() - make_interval(hours => ${EVERY_HOURS}))
       order by f.last_checked_at nulls first
       limit 5
    `;
  } finally {
    await sql.end();
  }
  let fetched = 0;
  for (const feed of due) {
    if (options.outOfTime() || !feed.user_id) break;
    const scope: CompanyScope = { companyId: feed.company_id, userId: feed.user_id, role: 'owner' };
    fetched += (await checkFeed(scope, feed, { maxDownloads: 2 })).fetched;
  }
  return fetched;
}

// --- what the screen shows and changes ----------------------------------------

export async function listFeeds(scope: CompanyScope): Promise<MarketFeedDTO[]> {
  return withCompanyScope(scope, async (tx) => {
    const feeds = await tx<{ id: string; exchange: 'nse'; symbol: string; display_name: string; enabled: boolean; last_checked_at: Date | null; last_error: string | null }[]>`
      select id, exchange, symbol, display_name, enabled, last_checked_at, last_error
        from market_feeds where company_id = ${scope.companyId} order by created_at
    `;
    const items = feeds.length === 0 ? [] : await tx<{ feed_id: string; title: string; category: string | null; published_at: Date | null; file_id: string | null }[]>`
      select feed_id, title, category, published_at, file_id
        from (select i.*, row_number() over (partition by feed_id order by published_at desc nulls last) n
                from market_feed_items i
               where company_id = ${scope.companyId} and status = 'fetched') ranked
       where n <= 5
    `;
    return feeds.map((f) => ({
      id: f.id,
      exchange: f.exchange,
      symbol: f.symbol,
      displayName: f.display_name,
      enabled: f.enabled,
      lastCheckedAt: f.last_checked_at?.toISOString() ?? null,
      lastError: f.last_error,
      recent: items
        .filter((i) => i.feed_id === f.id)
        .map((i) => ({ title: i.title, category: i.category, publishedAt: i.published_at?.toISOString() ?? null, fileId: i.file_id })),
    }));
  });
}

export class FeedRejected extends Error {}

/** Starts watching a listed company. Its symbol as NSE writes it: RADICO, UNITDSPR. */
export async function addFeed(scope: CompanyScope, input: { symbol: string; name: string }): Promise<void> {
  const symbol = input.symbol.trim().toUpperCase();
  const name = input.name.trim() || symbol;
  if (!/^[A-Z0-9&-]{2,20}$/.test(symbol)) {
    throw new FeedRejected('That is not an NSE symbol. It is the short code NSE uses, such as RADICO or UNITDSPR.');
  }
  await withCompanyScope(scope, (tx) => tx`
    insert into market_feeds (company_id, exchange, symbol, display_name, added_by)
    values (${scope.companyId}, 'nse', ${symbol}, ${name.slice(0, 80)}, ${scope.userId})
    on conflict (company_id, exchange, symbol) do update set enabled = true, display_name = excluded.display_name
  `);
}

export async function setFeedEnabled(scope: CompanyScope, feedId: string, enabled: boolean): Promise<boolean> {
  const rows = await withCompanyScope(scope, (tx) => tx`
    update market_feeds set enabled = ${enabled} where id = ${feedId} and company_id = ${scope.companyId} returning id
  `);
  return rows.length > 0;
}

/** Looks at one feed now, rather than waiting for the next pass. */
export async function checkFeedNow(scope: CompanyScope, feedId: string): Promise<MarketFeedDTO[] | null> {
  const rows = await withCompanyScope(scope, (tx) =>
    tx<FeedRow[]>`select id, symbol, display_name, last_checked_at, caught_up from market_feeds where id = ${feedId} and company_id = ${scope.companyId}`,
  );
  if (!rows[0]) return null;
  await checkFeed(scope, rows[0], { maxDownloads: 3 });
  return listFeeds(scope);
}

// --- the weekly note ----------------------------------------------------------

/** How often a note is written, and the stretch of filings it covers. */
const DIGEST_EVERY_DAYS = 7;
/** Filings put in front of the model for one note, at most - the newest. */
const DIGEST_MAX_FILINGS = 30;

export type MarketDigestDTO = {
  id: string;
  periodStart: string;
  periodEnd: string;
  headline: string;
  points: { company: string; point: string; fileId: string | null }[];
  filings: number;
  createdAt: string;
};

/**
 * Writes the note on the filings fetched since the last one, from what CIP
 * read off each. Null when none of them has been read yet - a note about
 * PDFs nobody has opened would only be their titles.
 */
export async function writeDigest(scope: CompanyScope): Promise<MarketDigestDTO | null> {
  const provider = brain();
  if (!provider.configured) return null;

  const gathered = await withCompanyScope(scope, async (tx) => {
    const [company] = await tx<{ name: string }[]>`select name from companies where id = ${scope.companyId}`;
    const [last] = await tx<{ period_end: Date }[]>`
      select period_end from market_digests where company_id = ${scope.companyId}
       order by period_end desc limit 1
    `;
    const since = last?.period_end ?? new Date(Date.now() - DIGEST_EVERY_DAYS * 86_400_000);
    const filings = await tx<{ file_id: string; company: string; published_at: Date | null; title: string; summary: string | null; signals: string[] | null }[]>`
      select i.file_id, f.display_name as company, i.published_at, i.title, s.summary,
             (select array_agg(g.statement order by g.created_at)
                from market_signals g
               where g.company_id = i.company_id and g.file_id = i.file_id and g.status <> 'rejected') as signals
        from market_feed_items i
        join market_feeds f on f.id = i.feed_id and f.company_id = i.company_id
        join market_sources s on s.file_id = i.file_id and s.company_id = i.company_id
       where i.company_id = ${scope.companyId}
         and i.status = 'fetched'
         and s.status = 'ready'
         and s.read_at > ${since}
       order by i.published_at desc nulls last
       limit ${DIGEST_MAX_FILINGS}
    `;
    return { companyName: company?.name ?? 'the company', since, filings };
  });
  if (gathered.filings.length === 0) return null;

  const refs = gathered.filings.map((f, i) => ({ ...f, ref: `F${i + 1}` }));
  const digest = await provider.digestFilings({
    companyName: gathered.companyName,
    filings: refs.map((f) => ({
      ref: f.ref,
      company: f.company,
      date: f.published_at?.toISOString().slice(0, 10) ?? null,
      title: f.title.slice(0, 300),
      summary: (f.summary ?? '').slice(0, 1_200),
      signals: (f.signals ?? []).slice(0, 8).map((s) => s.slice(0, 240)),
    })),
  });
  if (!digest.headline && digest.points.length === 0) return null;

  const byRef = new Map(refs.map((f) => [f.ref, f.file_id]));
  const points = digest.points.map((p) => ({ company: p.company, point: p.point, fileId: byRef.get(p.ref) ?? null }));
  const now = new Date();
  await withCompanyScope(scope, (tx) => tx`
    insert into market_digests (company_id, period_start, period_end, headline, points, filings)
    values (${scope.companyId}, ${gathered.since}, ${now}, ${digest.headline}, ${tx.json(points)}, ${refs.length})
  `);
  return latestDigest(scope);
}

export async function latestDigest(scope: CompanyScope): Promise<MarketDigestDTO | null> {
  const [row] = await withCompanyScope(scope, (tx) => tx<{
    id: string; period_start: Date; period_end: Date; headline: string;
    points: MarketDigestDTO['points']; filings: number; created_at: Date;
  }[]>`
    select id, period_start, period_end, headline, points, filings, created_at
      from market_digests where company_id = ${scope.companyId}
     order by created_at desc limit 1
  `);
  if (!row) return null;
  return {
    id: row.id,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    headline: row.headline,
    points: Array.isArray(row.points) ? row.points : [],
    filings: row.filings,
    createdAt: row.created_at.toISOString(),
  };
}

/** Writes the week's note for every company watching filings whose last note is a week old. */
export async function digestsEverywhere(options: { outOfTime: () => boolean }): Promise<number> {
  const sql = adminSql();
  let due: { company_id: string; user_id: string | null }[];
  try {
    due = await sql`
      select f.company_id,
             (select m.user_id from memberships m where m.company_id = f.company_id
               order by (m.role = 'owner') desc limit 1) as user_id
        from market_feeds f
       where f.enabled
       group by f.company_id
      having not exists (
        select 1 from market_digests d
         where d.company_id = f.company_id
           and d.created_at > now() - make_interval(days => ${DIGEST_EVERY_DAYS})
      )
       limit 5
    `;
  } finally {
    await sql.end();
  }
  let written = 0;
  for (const company of due) {
    if (options.outOfTime() || !company.user_id) break;
    const scope: CompanyScope = { companyId: company.company_id, userId: company.user_id, role: 'owner' };
    if (await writeDigest(scope).catch(() => null)) written += 1;
  }
  return written;
}

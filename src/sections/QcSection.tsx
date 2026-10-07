'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { assetUrl } from '@/types/media';
import type { CheckFlag, ClosePass, SecondLook } from '@/server/brain/checker';
import type { Revision } from '@/server/brain/revisions';
import { relativeDay } from '@/lib/format';

/**
 * Creative QC.
 *
 * Upload anything, and be told whether it can go out.
 *
 * The verdict is printed with what it rests on beside it, always. A reviewer
 * seeing "No problems found" needs to know whether that was measured against
 * forty rules or against two, and a report that hides the second case is worse
 * than no report - it converts ignorance into approval.
 */

type Coverage = { rules: number; verifiedRules: number; facts: number };

/** Something CIP already holds, which can be checked whatever its size. */
type Held = { id: string; name: string; kind: 'PDF' | 'image' | 'video'; sizeMb: number };

/**
 * Whether a file is a video, from its name.
 *
 * Only for what the screen says while it works: a video is one check of the
 * whole film, not "page 1 of 1", and it takes longer than a picture because
 * the frames have to be taken out of it first.
 */
const VIDEO_NAME = /\.(mp4|mov|webm|mkv)$/i;

type Report = {
  check: {
    id: string;
    fileId: string | null;
    generationId: string | null;
    subject: string;
    brand: string | null;
    market: string | null;
    score: number | null;
    summary: string | null;
    factsConsidered: number;
    rulesConsidered: number;
    flags: CheckFlag[];
    /** What CIP worked out when nobody said which brand it was. */
    detected: { product: string | null; confidence: number; evidence: string | null } | null;
    /** For a video: which moments it was judged on and what it was heard to say. */
    video: {
      durationSeconds: number;
      shots: number;
      framesAt: number[];
      complete: boolean;
      heardStatus: 'heard' | 'nothing_said' | 'no_audio' | 'failed';
      heard: string | null;
      onScreen: string[] | null;
      secondLook: SecondLook | null;
      timeline: { step: number; spans: { text: string; shown: { from: number; to: number }[]; seconds: number }[] } | null;
      heardLanguage: string | null;
      closePass: ClosePass | null;
    } | null;
  };
  verdict: 'pass' | 'fix' | 'review' | 'nothing_to_check' | 'not_a_creative';
  passed: { id: string; rule: string; verified: boolean }[];
  mustFix: CheckFlag[];
  toReview: CheckFlag[];
  counts: { rulesApplied: number; factsApplied: number; passed: number; flagged: number };
  /** The other kind of creative's rules, set aside. */
  notApplicable?: { id: string; rule: string }[];
};

/** One page's verdict, kept with the page it came from. */
type PageReport = { page: number; report: Report };

/** The most files checked in one go. Each takes a minute or more. */
const MAX_BATCH = 20;

/** One creative in a batch, and where it has got to. */
type BatchItem = {
  name: string;
  status: 'waiting' | 'uploading' | 'checking' | 'done' | 'failed';
  reports: PageReport[];
  message: string | null;
  page: number;
  of: number;
};

/** A batch item's verdict, from its pages: one page to fix and the creative needs fixing. */
function batchVerdict(item: BatchItem): { label: string; tone: string } {
  if (item.status === 'failed') return { label: 'Could not check', tone: 'tone-stop' };
  if (item.status !== 'done') return { label: '', tone: '' };
  const judged = item.reports.filter((r) => r.report.verdict !== 'not_a_creative');
  if (judged.length === 0) return { label: 'Not a creative', tone: 'tone-neutral' };
  if (judged.some((r) => r.report.verdict === 'nothing_to_check')) return { label: 'Nothing to check against', tone: 'tone-stop' };
  if (judged.some((r) => r.report.mustFix.length > 0)) return { label: 'Fix', tone: 'tone-stop' };
  if (judged.some((r) => r.report.toReview.length > 0)) return { label: 'Look', tone: 'tone-warn' };
  return { label: 'Pass', tone: 'tone-ok' };
}

/**
 * A campaign's verdict at a glance: every creative, what it came to, and how
 * much there is to do - each one a click away from its full report.
 */
function BatchTable({ items, onOpen }: { items: BatchItem[]; onOpen: (item: BatchItem) => void }) {
  const done = items.filter((i) => i.status === 'done' || i.status === 'failed');
  const tally = (label: string) => items.filter((i) => batchVerdict(i).label === label).length;
  const running = items.find((i) => i.status === 'uploading' || i.status === 'checking');

  return (
    <div className="card pad" style={{ marginTop: 16 }}>
      <p className="qc-verdict">
        {done.length < items.length
          ? `Checking ${done.length + 1} of ${items.length}…`
          : `${items.length} creatives checked`}
      </p>
      <p className="tiny muted">
        {tally('Pass')} pass · {tally('Fix')} to fix · {tally('Look')} to look at
        {tally('Could not check') > 0 ? ` · ${tally('Could not check')} could not be checked` : ''}
        {running ? ` · now: ${running.name}${running.of > 1 ? ` (page ${running.page} of ${running.of})` : ''}` : ''}
      </p>
      <table className="qc-batch">
        <thead>
          <tr>
            <th>Creative</th>
            <th>Verdict</th>
            <th>Score</th>
            <th>To fix</th>
            <th>Missing</th>
            <th className="no-print" />
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => {
            const verdict = batchVerdict(item);
            const flags = item.reports.flatMap((r) => [...r.report.mustFix, ...r.report.toReview]);
            const scores = item.reports.map((r) => r.report.check.score).filter((s): s is number => s !== null);
            return (
              <tr key={i}>
                <td className="truncate" title={item.name}>{item.name}</td>
                <td>
                  {verdict.label ? (
                    <span className={`qc-batch-verdict ${verdict.tone}`} title={item.message ?? undefined}>{verdict.label}</span>
                  ) : (
                    <span className="muted">{item.status === 'waiting' ? 'Waiting' : item.status === 'uploading' ? 'Uploading…' : 'Checking…'}</span>
                  )}
                </td>
                <td>{scores.length > 0 ? Math.min(...scores) : '—'}</td>
                <td>{item.status === 'done' ? flags.filter((f) => f.issue === 'wrong').length : '—'}</td>
                <td>{item.status === 'done' ? flags.filter((f) => f.issue === 'missing').length : '—'}</td>
                <td className="no-print">
                  {item.reports.length > 0 && (
                    <button type="button" className="btn btn-sm" onClick={() => onOpen(item)}>Open</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.some((i) => i.status === 'failed') && (
        <ul className="tiny" style={{ marginTop: 8, paddingLeft: 16, color: 'var(--stop-700)' }}>
          {items.filter((i) => i.status === 'failed').map((i, n) => (
            <li key={n}>{i.name}: {i.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Phase =
  | { at: 'idle' }
  | { at: 'uploading'; name: string }
  /** Checking, and saying which page of how many. A spinner alone tells a
      reviewer nothing about whether their file was even taken. */
  | { at: 'checking'; name: string; page: number; of: number }
  | { at: 'done'; name: string }
  | { at: 'failed'; message: string };

/** Pages checked in one go. A hundred-page deck is a hundred vision calls. */
const MAX_PAGES = 25;

const VERDICT: Record<Report['verdict'], { text: string; tone: string; line: string }> = {
  pass: {
    text: 'Nothing to fix',
    tone: 'tone-ok',
    line: 'Every rule that applies to this brand was checked and none was broken.',
  },
  fix: {
    text: 'Fix before this goes out',
    tone: 'tone-stop',
    line: 'These break a rule this company stands behind.',
  },
  review: {
    text: 'A person should look',
    tone: 'tone-warn',
    line: 'Nothing here breaks a confirmed rule, but CIP is unsure enough to ask.',
  },
  nothing_to_check: {
    text: 'CIP had nothing to check against',
    tone: 'tone-stop',
    line: 'No rules and no learned facts apply to this brand yet, so this report means nothing. Add rules first.',
  },
  not_a_creative: {
    text: 'Not a creative',
    tone: 'tone-neutral',
    line: 'A title slide, divider, chart or blank page. The advertising rules were not applied to it.',
  },
};

/**
 * The file CIP already holds under this name, if there is one.
 *
 * Search matches loosely, so the name is compared exactly here: a deck called
 * "Q3.pdf" must not be checked because "Q3 final.pdf" came back first.
 */
async function findByName(name: string): Promise<string | null> {
  const res = await fetch(`/api/drive/search?q=${encodeURIComponent(name)}`).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { files?: { id: string; name: string }[] } | null;
  return body?.files?.find((f) => f.name === name)?.id ?? null;
}

/**
 * Why the upload did not work, in words that say what to do about it.
 *
 * "That file could not be uploaded" is not an answer. The usual cause is not
 * anything CIP decides: a request to a Vercel function carries at most 4.5 MB,
 * and a deck is routinely larger. It returns 413 before any of our code runs,
 * with a body that is not JSON, so the message has to be worked out from the
 * status and the file rather than read off the response.
 */
async function whyUploadFailed(res: Response | null, file: File): Promise<string> {
  const mb = (file.size / 1024 / 1024).toFixed(1);

  if (!res) return 'The upload did not reach CIP. Check the connection and try again.';

  if (res.status === 413) {
    return (
      `This file is ${mb} MB, and an upload through the site is capped at 4.5 MB — ` +
      'a limit of the hosting platform, not of CIP. Add it through Add data to brain ' +
      'from a smaller export, or pick it below if it is already in CIP.'
    );
  }

  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (body?.message) return body.message;
  return `The upload failed (${res.status}). The file is ${mb} MB.`;
}

/**
 * Why the check did not run, in terms somebody can act on.
 *
 * "That creative could not be checked" is what was said while a 2.8 MB PDF
 * failed on the deployment and worked locally, and it said nothing at all. A
 * request killed for running too long comes back as 504 with no JSON in it, so
 * the status has to be read rather than the body.
 */
async function whyCheckFailed(res: Response | null): Promise<string> {
  if (!res) return 'The check did not reach CIP. Check the connection and try again.';

  if (res.status === 504 || res.status === 408) {
    return (
      'The check ran out of time on the server. A page with a lot on it can take ' +
      'minutes; try that page on its own, or a smaller export.'
    );
  }

  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (body?.message) return body.message;
  return `The check failed (${res.status}). Nothing was recorded, so nothing was judged.`;
}

export function QcSection({
  configured,
  brands,
  activeBrand,
  markets,
  coverage: initialCoverage,
  held,
}: {
  configured: boolean;
  brands: string[];
  activeBrand: string | null;
  markets: string[];
  coverage: Coverage;
  held: Held[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const [brand, setBrand] = useState(activeBrand ?? '');
  // Not "any market". Every rule this company has belongs to a market - Ghana's
  // six, India's three - so "any" resolves to the rules that apply everywhere,
  // of which there are none, and the report comes back spotless having checked
  // nothing. The first market is a guess; leaving it blank is a trap.
  const [market, setMarket] = useState(markets[0] ?? '');
  const [page, setPage] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ at: 'idle' });
  const [showPassed, setShowPassed] = useState(false);
  const [coverage, setCoverage] = useState<Coverage>(initialCoverage);
  // Filled in as each page comes back, so findings appear while the rest of the
  // deck is still being looked at.
  const [pages, setPages] = useState<PageReport[]>([]);
  const [search, setSearch] = useState('');
  // Folded away. Two hundred file names between the dropzone and the report is
  // how a finished report ends up eleven screens below the fold.
  const [browsing, setBrowsing] = useState(false);
  // Several creatives at once: each one's outcome, in the order they were given.
  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  // Where the report will appear. A deck's verdict lands below the dropzone and
  // the file list, and somebody who has just waited four minutes should not
  // have to go looking for it.
  const results = useRef<HTMLDivElement>(null);

  // What a check would cover, asked again whenever the brand or the market
  // changes. The number on screen has to be the number that will be used.
  const refreshCoverage = useCallback(async () => {
    const params = new URLSearchParams();
    if (brand) params.set('brand', brand);
    if (market) params.set('market', market);
    const res = await fetch(`/api/brain/qc?${params.toString()}`).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json().catch(() => null)) as { coverage?: Coverage } | null;
    if (body?.coverage) setCoverage(body.coverage);
  }, [brand, market]);

  useEffect(() => {
    void refreshCoverage();
  }, [refreshCoverage]);

  const busy = phase.at === 'uploading' || phase.at === 'checking' || batch.some((b) => b.status === 'uploading' || b.status === 'checking');

  /**
   * Everything after the file is in CIP: count the pages, then walk them.
   * Each page's report is handed on as it lands; the error, if the first page
   * could not be checked at all, comes back.
   */
  const walkPages = async (
    fileId: string,
    onPage: (collected: PageReport[], page: number, of: number) => void,
    onPageStart: (page: number, of: number) => void,
  ): Promise<string | null> => {
    const counted = await fetch(`/api/brain/qc/pages?fileId=${fileId}`).catch(() => null);
    const total = counted?.ok
      ? Math.min(MAX_PAGES, ((await counted.json()) as { pages: number }).pages)
      : 1;

    // One page at a time, in order, showing each verdict as it lands. A deck
    // takes minutes; waiting until the last page to show the first finding
    // would leave the screen silent for all of them.
    const collected: PageReport[] = [];
    // Once the first page has told us the brand, the rest are told rather than
    // asked. Working it out costs a vision call, and doing that on all fourteen
    // pages of a deck is thirteen calls to answer a question already answered.
    let known: string | null = brand || null;

    for (let page = 1; page <= total; page += 1) {
      onPageStart(page, total);

      const res = await fetch('/api/brain/qc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId, brand: known, market: market || null, page }),
      }).catch(() => null);

      if (!res?.ok) {
        // One page that cannot be drawn does not stop the other thirteen.
        if (page === 1) return whyCheckFailed(res);
        continue;
      }

      const { report } = (await res.json()) as { report: Report };
      known = known ?? report.check.brand;
      collected.push({ page, report });
      onPage([...collected], page, total);
    }
    return null;
  };

  const checkStored = async (fileId: string, label: string) => {
    const failed = await walkPages(
      fileId,
      (collected) => {
        setPages(collected);
        // Once, when the first page lands. Scrolling on every page would fight
        // anybody reading the ones already there.
        if (collected.length === 1) {
          results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      },
      (page, of) => setPhase({ at: 'checking', name: label, page, of }),
    );
    setPhase(failed ? { at: 'failed', message: failed } : { at: 'done', name: label });
  };

  /** A file into CIP, or the copy CIP already holds under its name. */
  const upload = async (file: File): Promise<{ id: string } | { error: string }> => {
    const form = new FormData();
    form.append('file', file);
    if (brand) form.append('brand', brand);
    const res = await fetch('/api/drive/files', { method: 'POST', body: form }).catch(() => null);
    // The upload route answers with the file itself, not with it wrapped.
    if (res?.ok) return { id: ((await res.json()) as { id: string }).id };
    // "A file called X is already here" is not a failure here. Somebody
    // dropping a deck onto a QC page wants that deck checked, and whether CIP
    // happens to hold a copy already is not their problem.
    const existing = await findByName(file.name);
    return existing ? { id: existing } : { error: await whyUploadFailed(res, file) };
  };

  /**
   * Several creatives, one after another.
   *
   * One at a time, each in its own requests, so no single request has to last
   * as long as a whole campaign - a request that runs past the platform's
   * limit is killed with nothing anybody can read. The table fills in as each
   * one finishes; a file that fails is marked and the rest carry on.
   */
  const checkMany = async (items: ({ file: File } | { held: Held })[]) => {
    const list = items.slice(0, MAX_BATCH);
    const start: BatchItem[] = list.map((item) => ({
      name: 'file' in item ? item.file.name : item.held.name,
      status: 'waiting',
      reports: [],
      message: null,
      page: 0,
      of: 0,
    }));
    setPages([]);
    setPhase({ at: 'idle' });
    setBatch(start);
    const update = (index: number, change: Partial<BatchItem>) =>
      setBatch((all) => all.map((b, i) => (i === index ? { ...b, ...change } : b)));

    for (const [index, item] of list.entries()) {
      let fileId: string;
      if ('file' in item) {
        update(index, { status: 'uploading' });
        const got = await upload(item.file);
        if ('error' in got) {
          update(index, { status: 'failed', message: got.error });
          continue;
        }
        fileId = got.id;
      } else {
        fileId = item.held.id;
      }
      update(index, { status: 'checking' });
      const failed = await walkPages(
        fileId,
        (collected) => update(index, { reports: collected }),
        (page, of) => update(index, { page, of }),
      );
      update(index, failed ? { status: 'failed', message: failed } : { status: 'done' });
    }
  };

  const checkHeld = async (file: Held) => {
    setPages([]);
    setBatch([]);
    await checkStored(file.id, file.name);
  };

  const check = async (file: File) => {
    setPages([]);
    setBatch([]);
    setPhase({ at: 'uploading', name: file.name });
    const got = await upload(file);
    if ('error' in got) {
      setPhase({ at: 'failed', message: got.error });
      return;
    }
    await checkStored(got.id, file.name);
  };

  /** One file is the usual check; more than one is a batch. */
  const checkFiles = (files: File[]) => {
    if (files.length === 1) void check(files[0]!);
    else if (files.length > 1) void checkMany(files.map((file) => ({ file })));
  };

  return (
    <>
      <div className="page-head no-print">
        <p className="eyebrow">Creative QC</p>
        <h1>Check it before it goes out</h1>
        <p className="lede">
          Drop in a finished creative — a banner, a deck page, a PDF from an agency — and CIP
          says what breaks a rule, what a person should look at, and what it checked and found
          right.
        </p>
      </div>

      {/* What the verdict will rest on, said before anything is judged rather
          than left to be inferred from a clean report. */}
      <div className="card pad no-print" style={{ marginBottom: 16 }}>
        <p className="tiny muted" style={{ marginBottom: 6 }}>
          What CIP is judging against{brand ? `, for ${brand}` : ''}
        </p>
        <div className="row" style={{ gap: 22, flexWrap: 'wrap' }}>
          <span><strong>{coverage.rules}</strong> rules</span>
          <span><strong>{coverage.verifiedRules}</strong> of them confirmed by a person</span>
          <span><strong>{coverage.facts}</strong> learned brand facts</span>
        </div>
        {coverage.rules === 0 && (
          <p className="tiny" style={{ marginTop: 8, color: 'var(--stop-700)' }}>
            No rules apply to {brand || 'this brand'} in {market || 'this market'}. A report
            would come back clean because there is nothing to break, which is not the same as
            being right.
          </p>
        )}
        {coverage.rules > 0 && coverage.verifiedRules === 0 && (
          <p className="tiny muted" style={{ marginTop: 8 }}>
            None of these rules has been confirmed by a person yet, so nothing here can fail a
            creative outright — findings will ask for review instead.
          </p>
        )}
      </div>

      {/* Choosing and uploading: the page's controls, not the report. */}
      <div className="card pad no-print">
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <label className="check-field">
            <span className="tiny muted">Brand</span>
            <select value={brand} onChange={(e) => setBrand(e.target.value)} disabled={busy}>
              <option value="">Let CIP work it out</option>
              {brands.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="check-field">
            <span className="tiny muted">Market</span>
            <select value={market} onChange={(e) => setMarket(e.target.value)} disabled={busy}>
              {markets.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="check-field">
            <span className="tiny muted">PDF page</span>
            <input
              type="number"
              min={1}
              value={page}
              onChange={(e) => setPage(Math.max(1, Number(e.target.value) || 1))}
              disabled={busy}
              style={{ width: 80 }}
            />
          </label>
        </div>

        <button
          type="button"
          className={`dropzone ${dragging ? 'is-over' : ''}`}
          onClick={() => input.current?.click()}
          disabled={busy || !configured}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            checkFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <Icon name="upload" size={26} />
          <span className="t">
            {phase.at === 'uploading'
              ? `Uploading ${phase.name}…`
              : phase.at === 'checking'
                ? VIDEO_NAME.test(phase.name)
                  ? 'Watching it from the first frame to the end card…'
                  : `Looking at page ${phase.page} of ${phase.of}…`
                : 'Drop creatives here, or click to browse — one, or a whole campaign'}
          </span>
          <span className="f">
            PNG, JPEG, WebP, PDF or a video (MP4, MOV, WebM), up to 4.5 MB. A PDF is
            checked a page at a time; a video is checked whole, start to end card.
          </span>
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp,application/pdf,video/mp4,video/quicktime,video/webm"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            checkFiles(files);
          }}
        />

        {!configured && (
          <p className="tiny" style={{ marginTop: 10, color: 'var(--stop-700)' }}>
            The Brain is not configured, so nothing can be checked.
          </p>
        )}
        {phase.at === 'failed' && (
          <p className="check-error" style={{ marginTop: 12 }}>{phase.message}</p>
        )}

        {/* Said out loud, and kept on screen. A reviewer who cannot tell
            whether their file was taken will upload it again. */}
        {(phase.at === 'uploading' || phase.at === 'checking') && (
          <div className="qc-progress">
            <span className="qc-spinner" aria-hidden />
            <span>
              {phase.at === 'uploading'
                ? `Taking ${phase.name}…`
                : VIDEO_NAME.test(phase.name)
                  ? `Watching ${phase.name}. Taking frames out of a video takes a minute.`
                  : `Reading ${phase.name} — page ${phase.page} of ${phase.of}`}
            </span>
            {phase.at === 'checking' && (
              <span className="qc-progress-track" aria-hidden>
                <i style={{ width: `${Math.round((phase.page / phase.of) * 100)}%` }} />
              </span>
            )}
          </div>
        )}
        {/* What CIP already holds. An upload through the site carries at most
            4.5 MB — the hosting platform's limit, not CIP's — and a deck is
            routinely larger. A file already here never went through it. */}
        <div className="qc-held">
          <button
            type="button"
            className="qc-held-toggle"
            onClick={() => setBrowsing((open) => !open)}
            disabled={busy}
          >
            <Icon name={browsing ? 'chevron-down' : 'chevron-right'} size={14} />
            <span>Or check something already in CIP — any size, no 4.5 MB limit</span>
            <span className="tiny muted">{held.length} files</span>
          </button>
          {browsing && (
          <>
          <label className="tiny muted" htmlFor="qc-held-search">
            Search by name
          </label>
          <input
            id="qc-held-search"
            type="search"
            placeholder="Deck, banner, packshot…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={busy}
          />
          <ul>
            {held
              .filter((f) => f.name.toLowerCase().includes(search.trim().toLowerCase()))
              .slice(0, 12)
              .map((file) => (
                <li key={file.id} className="qc-held-row">
                  {/* Ticked to check several together; clicked to check this one now. */}
                  <input
                    type="checkbox"
                    aria-label={`Add ${file.name} to a batch`}
                    checked={picked.includes(file.id)}
                    disabled={busy}
                    onChange={(e) =>
                      setPicked((all) => (e.target.checked ? [...all, file.id] : all.filter((id) => id !== file.id)))
                    }
                  />
                  <button type="button" onClick={() => void checkHeld(file)} disabled={busy || !configured}>
                    <span className="truncate">{file.name}</span>
                    <span className="tiny muted">
                      {file.kind} · {file.sizeMb} MB
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          {picked.length > 0 && (
            <div className="row-gap" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || !configured}
                onClick={() => {
                  const chosen = held.filter((f) => picked.includes(f.id));
                  setPicked([]);
                  void checkMany(chosen.map((h) => ({ held: h })));
                }}
              >
                Check {picked.length} selected
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPicked([])}>
                Clear
              </button>
            </div>
          )}
          {held.length === 0 && (
            <p className="tiny muted">CIP holds no pictures, PDFs or videos yet.</p>
          )}
          </>
          )}
        </div>

        {phase.at === 'done' && (
          <p className="tiny muted" style={{ marginTop: 12 }}>
            {VIDEO_NAME.test(phase.name)
              ? `Finished ${phase.name} — watched start to finish.`
              : `Finished ${phase.name} — ${pages.length} page${pages.length === 1 ? '' : 's'} checked.`}
          </p>
        )}
      </div>

      {batch.length > 0 && (
        <BatchTable
          items={batch}
          onOpen={(item) => {
            setPages(item.reports);
            results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        />
      )}

      <div ref={results}>
        {pages.length > 0 && (
          <Deck pages={pages} showPassed={showPassed} onTogglePassed={() => setShowPassed((v) => !v)} />
        )}
      </div>
    </>
  );
}

/**
 * This check next to the version before it: what was fixed, what is still
 * open, what is new. Found for the reviewer when it can be told for certain -
 * the same file checked again, or the same name with "v2" or "final" taken
 * off - and otherwise chosen from the list.
 */
function RevisionNote({ checkId }: { checkId: string }) {
  const [revision, setRevision] = useState<Revision | null>(null);
  const [withId, setWithId] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const query = withId ? `?with=${encodeURIComponent(withId)}` : '';
    void fetch(`/api/brain/checks/${checkId}/compare${query}`, { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<{ revision: Revision }>) : null))
      .then((body) => { if (!stopped && body) setRevision(body.revision); })
      .catch(() => {});
    return () => { stopped = true; };
  }, [checkId, withId]);

  if (!revision || (revision.against === null && revision.candidates.length === 0)) return null;
  const { against, fixed, stillOpen, added } = revision;

  return (
    <div className="qc-revision">
      {against && (
        <>
          <p className="qc-revision-head">
            <Icon name="restore" size={13} /> Compared with the earlier version
            {' '}<span className="muted">({against.subject}, {relativeDay(against.createdAt)})</span>
            {revision.scoreBefore !== null && revision.scoreNow !== null && (
              <strong> · score {revision.scoreBefore} → {revision.scoreNow}</strong>
            )}
          </p>
          <ul className="qc-revision-list">
            {fixed.map((f, i) => <li key={`f${i}`} className="is-fixed">Fixed — {f.message}</li>)}
            {stillOpen.map((f, i) => <li key={`s${i}`} className="is-open">Still open — {f.message}</li>)}
            {added.map((f, i) => <li key={`a${i}`} className="is-new">New — {f.message}</li>)}
            {fixed.length + stillOpen.length + added.length === 0 && <li>Nothing flagged in either version.</li>}
          </ul>
        </>
      )}
      {revision.candidates.length > 0 && (
        <label className="qc-revision-pick no-print">
          <span className="tiny muted">{against ? 'Compare with a different version' : 'Is this a new version? Compare it with'}</span>
          <select value={against?.id ?? ''} onChange={(e) => setWithId(e.target.value || null)}>
            <option value="">{against ? '—' : 'Choose an earlier check'}</option>
            {revision.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.subject} · {relativeDay(c.createdAt)}{c.score !== null ? ` · ${c.score}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** 83.4 seconds as "1:23". */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Only what makes a video's verdict less trustworthy, kept in sight: a clean
 * result on a film whose sound nobody heard is not the same as a clean one.
 */
function VideoCaveats({ video }: { video: NonNullable<Report['check']['video']> }) {
  const caveats = [
    !video.complete && 'Some short shots were not looked at.',
    video.heardStatus === 'failed' && 'Sound could not be transcribed — listen to it yourself.',
    video.onScreen === null && 'Small print was read from thumbnails only.',
    video.closePass?.status === 'failed' && 'Frames were not searched at full size.',
    video.secondLook?.status === 'failed' && 'Flags were not double-checked.',
    video.secondLook && video.secondLook.unsure > 0 &&
      `${video.secondLook.unsure} flag${video.secondLook.unsure === 1 ? '' : 's'} uncertain — watch ${video.secondLook.unsure === 1 ? 'that moment' : 'those moments'}.`,
  ].filter((c): c is string => typeof c === 'string');

  return (
    <>
      {caveats.map((c) => (
        <p key={c} className="qc-caveat">
          <Icon name="alert" size={13} /> {c}
        </p>
      ))}
    </>
  );
}

/** How a video was checked: the film, what was heard and read, what was thrown out. */
function VideoDetails({ video }: { video: NonNullable<Report['check']['video']> }) {
  const sound =
    video.heardStatus === 'heard'
      ? `voiceover heard${video.heardLanguage ? ` (${video.heardLanguage})` : ''}`
      : video.heardStatus === 'nothing_said'
        ? 'no speech'
        : video.heardStatus === 'no_audio'
          ? 'no sound'
          : 'sound not transcribed';
  const facts = [
    `${clock(video.durationSeconds)} film`,
    `${video.shots} shot${video.shots === 1 ? '' : 's'}, ${video.framesAt.length} frames`,
    sound,
    video.closePass?.status === 'done' ? 'every frame searched full size' : null,
    video.secondLook?.status === 'done' && video.secondLook.dropped.length > 0
      ? `${video.secondLook.dropped.length} false flag${video.secondLook.dropped.length === 1 ? '' : 's'} removed`
      : null,
  ].filter(Boolean);
  const read = video.onScreen?.map((text, i) => ({ text, at: video.framesAt[i] ?? 0 })).filter((r) => r.text) ?? [];

  return (
    <>
      <p>{facts.join(' · ')}</p>
      {video.heardStatus === 'heard' && video.heard && (
        <div className="qc-video-block">
          <p className="qc-video-head">Voiceover (automatic, can mishear)</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{video.heard}</p>
        </div>
      )}
      {read.length > 0 && (
        <div className="qc-video-block">
          <p className="qc-video-head">Text on screen</p>
          <ul>
            {read.map((r, i) => (
              <li key={i}><strong>{clock(r.at)}</strong> {r.text.replace(/\s*\n\s*/g, ' / ')}</li>
            ))}
          </ul>
        </div>
      )}
      {video.timeline && video.timeline.spans.length > 0 && (
        <div className="qc-video-block">
          <p className="qc-video-head">How long each line stayed up</p>
          <ul>
            {video.timeline.spans.map((span, i) => (
              <li key={i}>
                <strong>{span.seconds}s</strong> {span.text}{' '}
                <span className="muted">({span.shown.map((x) => `${clock(x.from)}–${clock(x.to)}`).join(', ')})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {video.secondLook && video.secondLook.dropped.length > 0 && (
        <div className="qc-video-block">
          <p className="qc-video-head">Removed on a closer look</p>
          <ul>
            {video.secondLook.dropped.map((d, i) => (
              <li key={i}>{d.message} <span className="muted">— {d.reason}</span></li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * The whole document's verdict, and then each page's.
 *
 * The summary at the top is worked out from the pages, not asked of anything:
 * a deck is only clean when every page in it is.
 */
function Deck({
  pages,
  showPassed,
  onTogglePassed,
}: {
  pages: PageReport[];
  showPassed: boolean;
  onTogglePassed: () => void;
}) {
  // A page that was never an advert is neither clean nor a problem: it was not
  // judged. Counting it as clean inflates every deck's score.
  const skipped = pages.filter((p) => p.report.verdict === 'not_a_creative');
  const judged = pages.filter((p) => p.report.verdict !== 'not_a_creative');
  const problems = judged.filter((p) => p.report.mustFix.length > 0);
  const queries = judged.filter((p) => p.report.mustFix.length === 0 && p.report.toReview.length > 0);
  const clean = judged.length - problems.length - queries.length;

  return (
    <>
      <div className="card pad" style={{ marginTop: 16 }}>
        <p className={`qc-verdict ${problems.length > 0 ? 'tone-stop' : queries.length > 0 ? 'tone-warn' : 'tone-ok'}`}>
          {problems.length > 0
            ? `${problems.length} page${problems.length === 1 ? '' : 's'} need fixing`
            : queries.length > 0
              ? `${queries.length} page${queries.length === 1 ? '' : 's'} worth a look`
              : 'Nothing to fix'}
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-sm no-print"
          style={{ float: 'right' }}
          // The browser's own "Save as PDF": the report as it is on screen,
          // without the page around it. See the print rules in check.css.
          // Named for what was checked, so the saved file is not "Creative QC".
          onClick={() => {
            const before = document.title;
            const subject = pages[0]?.report.check.subject;
            if (subject) document.title = `QC report - ${subject.replace(/\.[a-z0-9]{2,4}$/i, '')}`;
            window.print();
            document.title = before;
          }}
        >
          <Icon name="download" size={14} /> Download PDF
        </button>
        <p className="tiny muted">
          {judged.length} creative{judged.length === 1 ? '' : 's'} checked · {clean} clean
          {queries.length > 0 ? ` · ${queries.length} to review` : ''}
          {problems.length > 0 ? ` · ${problems.length} to fix` : ''}
          {skipped.length > 0
            ? ` · ${skipped.length} page${skipped.length === 1 ? '' : 's'} skipped, not creatives`
            : ''}
        </p>
      </div>

      {pages.map(({ page, report }) => (
        <QcReport
          key={page}
          page={page}
          report={report}
          showPassed={showPassed}
          onTogglePassed={onTogglePassed}
        />
      ))}
    </>
  );
}

function QcReport({
  page,
  report,
  showPassed,
  onTogglePassed,
}: {
  page: number;
  report: Report;
  showPassed: boolean;
  onTogglePassed: () => void;
}) {
  const verdict = VERDICT[report.verdict];

  return (
    <div className="card pad" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <p className="tiny muted" style={{ marginBottom: 2 }}>Page {page}</p>
          <p className={`qc-verdict ${verdict.tone}`}>{verdict.text}</p>
          {/* "These break a rule" says again what the title and the flags
              under it already say. The other verdicts' lines explain. */}
          {report.verdict !== 'fix' && <p className="tiny muted">{verdict.line}</p>}
        </div>
        {report.check.score !== null && (
          <div style={{ textAlign: 'right' }}>
            <p style={{ fontSize: 28, fontWeight: 600 }}>{report.check.score}</p>
            <p className="tiny muted">out of 100</p>
          </div>
        )}
      </div>

      {/* One line: what was checked, and as which brand. Everything else about
          how it was checked is folded away below, unless it weakens the
          verdict - a brand CIP was not sure of applies the wrong rules. */}
      <p className="tiny muted" style={{ marginTop: 8 }}>
        {report.check.subject}
        {report.check.brand ? ` · ${report.check.brand}` : ''}
      </p>
      {report.check.detected && (!report.check.brand || report.check.detected.confidence < 0.7) && (
        <p className="qc-caveat">
          <Icon name="alert" size={13} />
          {report.check.brand
            ? ` Only ${Math.round(report.check.detected.confidence * 100)}% sure this is ${report.check.brand} — pick the brand above if it is not.`
            : ' CIP could not tell which brand this is, so only the house-wide rules were applied — pick the brand above.'}
        </p>
      )}
      {report.check.video && <VideoCaveats video={report.check.video} />}

      <details className="qc-how">
        <summary>How it was checked</summary>
        <p>
          Against {report.counts.rulesApplied} rules and {report.counts.factsApplied} brand facts ·{' '}
          {report.counts.passed} passed, {report.counts.flagged} flagged
        </p>
        {report.check.detected && report.check.brand && (
          <p>
            Read as {report.check.brand}
            {report.check.detected.product ? ` — ${report.check.detected.product}` : ''}
            {report.check.detected.evidence ? ` (${report.check.detected.evidence})` : ''} ·{' '}
            {Math.round(report.check.detected.confidence * 100)}% sure
          </p>
        )}
        {(report.notApplicable?.length ?? 0) > 0 && (
          <p>
            Not applicable to {report.check.video ? 'a video' : 'an image'} ({report.notApplicable!.length}):{' '}
            {report.notApplicable!.map((r) => r.rule).join(' · ')}
          </p>
        )}
        {report.check.video && <VideoDetails video={report.check.video} />}
        {report.check.summary && report.mustFix.length + report.toReview.length > 0 && (
          <p>{report.check.summary}</p>
        )}
      </details>

      <RevisionNote checkId={report.check.id} />

      {/* With nothing flagged, the summary is the only account of the
          creative there is. With flags, it only says them again. */}
      {report.check.summary && report.mustFix.length + report.toReview.length === 0 && (
        <p style={{ marginTop: 12 }}>{report.check.summary}</p>
      )}

      {/* Something there to change is shown at its moment, with the frame.
          Something not there at all has no moment to show - every frame of
          it is just the end card - so those are one list to add, at the end. */}
      {report.mustFix.some((f) => f.issue === 'wrong') && (
        <FlagList title="Fix these" tone="tone-stop" flags={report.mustFix.filter((f) => f.issue === 'wrong')}
          checkId={report.check.id} framesAt={report.check.video?.framesAt ?? []} picture={pictureOf(report)} />
      )}
      {report.toReview.some((f) => f.issue === 'wrong') && (
        <FlagList title="Worth a look" tone="tone-warn" flags={report.toReview.filter((f) => f.issue === 'wrong')}
          checkId={report.check.id} framesAt={report.check.video?.framesAt ?? []} picture={pictureOf(report)} />
      )}
      <AddList
        mustAdd={report.mustFix.filter((f) => f.issue === 'missing')}
        mayAdd={report.toReview.filter((f) => f.issue === 'missing')}
      />

      {report.passed.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <button type="button" className="btnghost btn-sm" onClick={onTogglePassed}>
            {showPassed ? 'Hide' : 'Show'} the {report.passed.length} rules that passed
          </button>
          {showPassed && (
            <ul className="qc-passed">
              {report.passed.map((rule) => (
                <li key={rule.id}>
                  <Icon name="check" size={13} />
                  <span>{rule.rule}</span>
                  {!rule.verified && <span className="tiny muted">not yet confirmed</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Everything the creative is missing, as one list to work through.
 *
 * Each point is what to add, short; the rule behind it is a hover away. What
 * a rule requires comes first, and what is only worth a look is marked so.
 */
function AddList({ mustAdd, mayAdd }: { mustAdd: CheckFlag[]; mayAdd: CheckFlag[] }) {
  if (mustAdd.length + mayAdd.length === 0) return null;
  return (
    <div className="qc-add">
      <p className="qc-list-title tone-stop">Missing — add these · {mustAdd.length + mayAdd.length}</p>
      <ul>
        {[...mustAdd, ...mayAdd].map((flag) => (
          <li key={flag.id} title={[flag.citedRule?.rule, ...(flag.alsoRules ?? []).map((r) => r.rule)].filter(Boolean).join(' · ') || undefined}>
            {flag.message}
            {mayAdd.includes(flag) && (
              <span className="qc-add-soft"> worth a look</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The picture a single creative's flags are marked on, or null.
 *
 * A film's flags have their frames; a PDF page has no picture of its own to
 * link to, and marking the whole document would point nowhere.
 */
function pictureOf(report: Report): string | null {
  if (report.check.video) return null;
  if (report.check.generationId) return assetUrl(report.check.generationId);
  if (report.check.fileId && /\.(png|jpe?g|webp)$/i.test(report.check.subject)) {
    return `/api/drive/files/${report.check.fileId}/content?size=640`;
  }
  return null;
}

/** A picture, and where on it the fault is. The rectangle is in fractions, so it fits any size. */
function Marked({
  src, alt, box, href, label,
}: {
  src: string;
  alt: string;
  box: { x: number; y: number; w: number; h: number } | null;
  href: string;
  label: string | null;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" title={box ? 'Open it - the box marks the fault' : 'Open it'}>
      <span className="qc-marked">
        <img
          src={src}
          alt={alt}
          loading="lazy"
          // An older check kept no pictures; its time still says where.
          onError={(event) => { event.currentTarget.parentElement!.style.display = 'none'; }}
        />
        {box && (
          <i
            className="qc-box"
            style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
          />
        )}
      </span>
      {label && <span>{label}</span>}
    </a>
  );
}

function FlagList({
  title, tone, flags, checkId, framesAt, picture,
}: {
  title: string;
  tone: string;
  flags: CheckFlag[];
  checkId: string;
  /** For a video: when each kept frame was taken, so a flag's moment finds its picture. */
  framesAt: number[];
  /** For a single picture: the picture itself, to mark the fault on. */
  picture: string | null;
}) {
  return (
    <div style={{ marginTop: 18 }}>
      <p className={`qc-list-title ${tone}`}>{title} · {flags.length}</p>
      <ul className="qc-flags">
        {flags.map((flag) => {
          // A flag names moments; the kept frame for each is the one taken then.
          // The moment the fault is marked on comes first, so it is always shown.
          const moments = flag.box?.at != null
            ? [flag.box.at, ...flag.atSeconds.filter((t) => Math.abs(t - flag.box!.at!) >= 0.05)]
            : flag.atSeconds;
          const shots = moments.slice(0, 3).map((t) => ({
            t,
            n: framesAt.findIndex((f) => Math.abs(f - t) < 0.05) + 1,
          }));
          // What it was judged against. A finding with nothing here would
          // have been thrown away before it reached this screen.
          const against = flag.citedRule
            ? [flag.citedRule.rule, ...(flag.alsoRules ?? []).map((r) => r.rule)].join(' · ')
            : flag.citedFact
              ? `${flag.citedFact.brand ?? 'This brand'} usually — ${flag.citedFact.attribute}: ${flag.citedFact.value}`
              : null;
          return (
            <li key={flag.id} className={`is-${flag.severity}`}>
              <div className="qc-flag-body">
                <p className="qc-flag-message">{flag.message}</p>
                {against && (
                  <p className="qc-flag-rule" title={against}>
                    {flag.citedRule ? ((flag.alsoRules ?? []).length > 0 ? 'Rules' : 'Rule') : 'Pattern'}: {against}
                  </p>
                )}
              </div>
              {shots.length > 0 && (
                <div className="qc-flag-frames">
                  {shots.map(({ t, n }) =>
                    n > 0 ? (
                      <Marked
                        key={t}
                        src={`/api/brain/checks/${checkId}/frames/${n}`}
                        href={`/api/brain/checks/${checkId}/frames/${n}`}
                        alt={`The frame at ${clock(t)}`}
                        box={flag.box && flag.box.at !== null && Math.abs(flag.box.at - t) < 0.05 ? flag.box : null}
                        label={clock(t)}
                      />
                    ) : (
                      <span key={t} className="qc-flag-time">{clock(t)}</span>
                    ),
                  )}
                </div>
              )}
              {shots.length === 0 && picture && flag.box && (
                <div className="qc-flag-frames">
                  <Marked src={picture} href={picture} alt="Where the fault is" box={flag.box} label={null} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { CheckFlag } from '@/server/brain/checker';

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
type Held = { id: string; name: string; isPdf: boolean; sizeMb: number };

type Report = {
  check: {
    id: string;
    subject: string;
    brand: string | null;
    market: string | null;
    score: number | null;
    summary: string | null;
    factsConsidered: number;
    rulesConsidered: number;
    flags: CheckFlag[];
  };
  verdict: 'pass' | 'fix' | 'review' | 'nothing_to_check' | 'not_a_creative';
  passed: { id: string; rule: string; verified: boolean }[];
  mustFix: CheckFlag[];
  toReview: CheckFlag[];
  counts: { rulesApplied: number; factsApplied: number; passed: number; flagged: number };
};

/** One page's verdict, kept with the page it came from. */
type PageReport = { page: number; report: Report };

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

  const busy = phase.at === 'uploading' || phase.at === 'checking';

  /** Everything after the file is in CIP: count the pages, then walk them. */
  const checkStored = async (fileId: string, label: string) => {
    const counted = await fetch(`/api/brain/qc/pages?fileId=${fileId}`).catch(() => null);
    const total = counted?.ok
      ? Math.min(MAX_PAGES, ((await counted.json()) as { pages: number }).pages)
      : 1;

    // One page at a time, in order, showing each verdict as it lands. A deck
    // takes minutes; waiting until the last page to show the first finding
    // would leave the screen silent for all of them.
    const collected: PageReport[] = [];
    for (let page = 1; page <= total; page += 1) {
      setPhase({ at: 'checking', name: label, page, of: total });

      const res = await fetch('/api/brain/qc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId, brand: brand || null, market: market || null, page }),
      }).catch(() => null);

      if (!res?.ok) {
        // One page that cannot be drawn does not stop the other thirteen.
        if (page === 1) {
          const body: { message?: string } = res ? await res.json().catch(() => ({})) : {};
          setPhase({ at: 'failed', message: body.message ?? 'That creative could not be checked.' });
          return;
        }
        continue;
      }

      const { report } = (await res.json()) as { report: Report };
      collected.push({ page, report });
      setPages([...collected]);
      // Once, when the first page lands. Scrolling on every page would fight
      // anybody reading the ones already there.
      if (collected.length === 1) {
        results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    setPhase({ at: 'done', name: label });
  };

  const checkHeld = async (file: Held) => {
    setPages([]);
    await checkStored(file.id, file.name);
  };

  const check = async (file: File) => {
    setPages([]);
    setPhase({ at: 'uploading', name: file.name });

    const form = new FormData();
    form.append('file', file);
    if (brand) form.append('brand', brand);

    const upload = await fetch('/api/drive/files', { method: 'POST', body: form }).catch(() => null);

    let fileId: string | null = null;
    if (upload?.ok) {
      // The upload route answers with the file itself, not with it wrapped.
      fileId = ((await upload.json()) as { id: string }).id;
    } else {
      // "A file called X is already here" is not a failure here. Somebody
      // dropping a deck onto a QC page wants that deck checked, and whether CIP
      // happens to hold a copy already is not their problem.
      fileId = await findByName(file.name);
      if (!fileId) {
        setPhase({ at: 'failed', message: await whyUploadFailed(upload, file) });
        return;
      }
    }

    await checkStored(fileId, file.name);
  };

  return (
    <>
      <div className="page-head">
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
      <div className="card pad" style={{ marginBottom: 16 }}>
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

      <div className="card pad">
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
            const file = event.dataTransfer.files[0];
            if (file) void check(file);
          }}
        >
          <Icon name="upload" size={26} />
          <span className="t">
            {phase.at === 'uploading'
              ? `Uploading ${phase.name}…`
              : phase.at === 'checking'
                ? `Looking at page ${phase.page} of ${phase.of}…`
                : 'Drop a creative here, or click to browse'}
          </span>
          <span className="f">
            PNG, JPEG, WebP or PDF, up to 4.5 MB. A PDF is checked one page at a time.
          </span>
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp,application/pdf"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void check(file);
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
                <li key={file.id}>
                  <button type="button" onClick={() => void checkHeld(file)} disabled={busy || !configured}>
                    <span className="truncate">{file.name}</span>
                    <span className="tiny muted">
                      {file.isPdf ? 'PDF' : 'image'} · {file.sizeMb} MB
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          {held.length === 0 && (
            <p className="tiny muted">CIP holds no pictures or PDFs yet.</p>
          )}
          </>
          )}
        </div>

        {phase.at === 'done' && (
          <p className="tiny muted" style={{ marginTop: 12 }}>
            Finished {phase.name} — {pages.length} page{pages.length === 1 ? '' : 's'} checked.
          </p>
        )}
      </div>

      <div ref={results}>
        {pages.length > 0 && (
          <Deck pages={pages} showPassed={showPassed} onTogglePassed={() => setShowPassed((v) => !v)} />
        )}
      </div>
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
          <p className="tiny muted">{verdict.line}</p>
        </div>
        {report.check.score !== null && (
          <div style={{ textAlign: 'right' }}>
            <p style={{ fontSize: 28, fontWeight: 600 }}>{report.check.score}</p>
            <p className="tiny muted">out of 100</p>
          </div>
        )}
      </div>

      <p className="tiny muted" style={{ marginTop: 10 }}>
        {report.check.subject} · checked against {report.counts.rulesApplied} rules and{' '}
        {report.counts.factsApplied} brand facts · {report.counts.passed} passed,{' '}
        {report.counts.flagged} flagged
      </p>

      {report.check.summary && (
        <p style={{ marginTop: 12 }}>{report.check.summary}</p>
      )}

      {report.mustFix.length > 0 && (
        <FlagList title="Fix these" tone="tone-stop" flags={report.mustFix} />
      )}
      {report.toReview.length > 0 && (
        <FlagList title="Worth a look" tone="tone-warn" flags={report.toReview} />
      )}

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

function FlagList({ title, tone, flags }: { title: string; tone: string; flags: CheckFlag[] }) {
  return (
    <div style={{ marginTop: 18 }}>
      <p className={`qc-list-title ${tone}`}>{title}</p>
      <ul className="qc-flags">
        {flags.map((flag) => (
          <li key={flag.id} className={`is-${flag.severity}`}>
            <p className="qc-flag-message">{flag.message}</p>
            {/* What it was judged against. A finding with nothing here would
                have been thrown away before it reached this screen. */}
            {flag.citedRule && (
              <p className="tiny muted">Rule: {flag.citedRule.rule}</p>
            )}
            {flag.citedFact && (
              <p className="tiny muted">
                {flag.citedFact.brand ? `${flag.citedFact.brand} usually — ` : 'This brand usually — '}
                {flag.citedFact.attribute}: {flag.citedFact.value}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

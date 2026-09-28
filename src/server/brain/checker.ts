import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { driveStorage } from '../drive/storage';
import { renderPdfPages } from '../drive/extraction/pdfRender';
import { readAsset } from '../media/generation';
import { readBrandDna } from './brandDna';
import { companyBrands } from './brands';
import { marketsCovering } from './markets';
import { productShots } from './retrieval';
import { fitForVision } from './fitImage';
import { videoContactSheet } from './contactSheet';
import { framesEvery, readVideoMetadata, textSpans, withTempFile } from './media';
import type { SampledFrame, TextSpan } from './media';
import { brain } from './providers';
import { ANALYSABLE_VIDEO_TYPES, BRAIN_LIMITS, BrainFailed } from './providers/types';
import type {
  AssetKind,
  BrainProvider,
  CheckDimension,
  CheckFinding,
  CheckRule,
  VideoSequence,
} from './providers/types';

/**
 * The Consistency & Compliance Checker.
 *
 * CIP could make a picture and could not look at one and say whether it was
 * right. This does: a creative is scored against what CIP has learned about
 * the brand and against the rules its category has to obey, and every flag
 * says which of those it came from.
 *
 * Three things keep it honest.
 *
 * A flag must cite a rule that was actually sent. The model is handed short
 * refs - F1, R3 - and a finding naming anything else is thrown away. A flag
 * grounded in nothing is exactly the ungrounded output this product exists
 * not to produce, and the schema alone cannot stop a model inventing one.
 *
 * The score is worked out here, from the flags, never asked of the model. A
 * number a model reports about its own judgement is a number it chose.
 *
 * A reviewer can disagree, and say which way. "This asset is a legitimate
 * exception" changes nothing CIP believes. "This rule is wrong" does - it
 * rejects the fact, or retires a rule CIP suggested - because a person said
 * so. A brain that only ever grows and cannot be corrected drifts.
 */

export class CheckRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckRejected';
  }
}

export type RuleCategory = 'disclaimer' | 'audience' | 'claim' | 'placement' | 'medium' | 'other';
export type RuleSource = 'manual' | 'regulation' | 'suggested';

export type ComplianceRule = {
  id: string;
  brand: string | null;
  market: string | null;
  category: RuleCategory;
  requirement: 'required' | 'forbidden';
  rule: string;
  note: string | null;
  referenceUrl: string | null;
  source: RuleSource;
  active: boolean;
  /** When a person confirmed the rule is right. Null until someone has. */
  verifiedAt: string | null;
};

export type NewComplianceRule = {
  rule: string;
  requirement: 'required' | 'forbidden';
  category?: RuleCategory;
  brand?: string | null;
  market?: string | null;
  note?: string | null;
  referenceUrl?: string | null;
  source?: RuleSource;
};

export type CheckFlag = {
  id: string;
  dimension: CheckDimension;
  severity: 'critical' | 'warning' | 'note';
  message: string;
  /** What the flag was judged against. Exactly one of these is set. */
  citedFact: { id: string; attribute: string; value: string; brand: string | null } | null;
  citedRule: { id: string; rule: string; source: RuleSource; referenceUrl: string | null } | null;
  status: 'open' | 'accepted' | 'disputed';
  disputeReason: 'exception' | 'wrong_rule' | null;
  correction: string | null;
  /** For a video: the moments it is about, in seconds. Empty for the whole film. */
  atSeconds: number[];
};

export type CreativeCheck = {
  id: string;
  fileId: string | null;
  generationId: string | null;
  /** What was on the page. Only a creative is judged against advertising rules. */
  assetKind: AssetKind;
  /**
   * What the Brain read off the creative when nobody said which brand it was.
   *
   * Null when a person chose the brand. Present, with how sure it was, so a
   * verdict can be weighed: a check run as the wrong brand applied the wrong
   * rules, and the only defence is being able to see which brand was used.
   */
  detected: { product: string | null; confidence: number; evidence: string | null } | null;
  /** The display name of what was checked. */
  subject: string;
  brand: string | null;
  market: string | null;
  status: 'pending' | 'ready' | 'failed';
  score: number | null;
  visualScore: number | null;
  verbalScore: number | null;
  complianceScore: number | null;
  summary: string | null;
  /** How much the score stands on. A perfect score against nothing is not a pass. */
  factsConsidered: number;
  rulesConsidered: number;
  errorMessage: string | null;
  createdAt: string;
  /**
   * For a video: which frames it was judged on and what its soundtrack was
   * taken to say. Shown so a reviewer can tell a clean verdict on the whole
   * film from one on a sample that missed a shot or misheard a line.
   */
  video: VideoCheck | null;
  flags: CheckFlag[];
};

export type VideoCheck = {
  durationSeconds: number;
  shots: number;
  framesAt: number[];
  /** False when some short shots did not fit on the sheet. */
  complete: boolean;
  heardStatus: 'heard' | 'nothing_said' | 'no_audio' | 'failed';
  heard: string | null;
  /** The words read off each frame at full size, in order. Null when they could not be read. */
  onScreen: string[] | null;
  /** What the closer look at the findings decided. Null when there was nothing to look at. */
  secondLook: SecondLook | null;
  /** When each line of text was on screen. Null when no rule needed it timed. */
  timeline: { step: number; spans: TextSpan[] } | null;
  /** The language the soundtrack was heard as, when it was. */
  heardLanguage: string | null;
};

/**
 * The closer look at a video's findings, kept beside the verdict.
 *
 * A flag the second look threw out is not silently gone: it is listed with
 * what was seen, so a reviewer who disagrees can watch that moment.
 */
export type SecondLook = {
  status: 'done' | 'failed';
  /** How many findings were looked at again. */
  reviewed: number;
  /** Findings kept, but which the closer look could not settle either way. */
  unsure: number;
  dropped: { rule: string; message: string; reason: string }[];
};

/**
 * What each finding costs a dimension.
 *
 * A critical finding is a missing mandatory warning or a forbidden element in
 * the frame. Two of those and a dimension is at twenty, which is where it
 * belongs.
 */
const PENALTY = { critical: 40, warning: 15, note: 5 } as const;

/**
 * The most a creative can score while it breaks a compliance requirement.
 *
 * An average hides the one thing that matters most: a banner that is perfectly
 * on-brand and missing its statutory warning must not come back as a 73. It
 * fails, whatever else is true of it.
 */
const COMPLIANCE_FAIL_CEILING = 49;

/** Facts sent per check. Enough to judge a brand, few enough to stay legible. */
const MAX_FACTS = 40;

const SEVERITY_RANK = { note: 0, warning: 1, critical: 2 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKABLE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** What ffmpeg is told the file is, since it goes to disk under a made-up name. */
const VIDEO_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};

/**
 * Scores worked out from the flags that still stand.
 *
 * A dimension nothing was judged against scores null, not a hundred - there
 * was nothing to fail, which is a different thing from passing.
 */
export function scoreFrom(
  flags: { dimension: CheckDimension; severity: CheckFinding['severity'] }[],
  judged: Record<CheckDimension, boolean>,
): { score: number | null; visual: number | null; verbal: number | null; compliance: number | null } {
  const dimension = (name: CheckDimension): number | null => {
    if (!judged[name]) return null;
    const lost = flags
      .filter((f) => f.dimension === name)
      .reduce((sum, f) => sum + PENALTY[f.severity], 0);
    return Math.max(0, 100 - lost);
  };

  const visual = dimension('visual');
  const verbal = dimension('verbal');
  const compliance = dimension('compliance');

  const present = [visual, verbal, compliance].filter((v): v is number => v !== null);
  if (present.length === 0) return { score: null, visual, verbal, compliance };

  let score = Math.round(present.reduce((a, b) => a + b, 0) / present.length);
  if (flags.some((f) => f.dimension === 'compliance' && f.severity === 'critical')) {
    score = Math.min(score, COMPLIANCE_FAIL_CEILING);
  }
  return { score, visual, verbal, compliance };
}

/** Where a ref came from, so a finding can be checked against it. */
type RefTarget =
  | { kind: 'fact'; id: string; dimension: CheckDimension; requirement: 'observed' }
  | {
      kind: 'rule';
      id: string;
      dimension: 'compliance';
      requirement: 'required' | 'forbidden';
      /** A rule CIP suggested that no person has verified. It can warn; it cannot fail. */
      advisory?: boolean;
      /**
       * An approved choice. Nothing can break a permission, so a finding that
       * cites one is the model misreading it and is dropped.
       */
      permits?: boolean;
      /** A preference, not a requirement: departing from it is at most a note. */
      soft?: boolean;
      /** How serious the rule's author said breaking it is. */
      graded?: CheckFinding['severity'];
    };

/**
 * Keeps only findings that are about something CIP actually sent.
 *
 * Exported for the tests, because this is the part of the checker that stands
 * between a model's imagination and a reviewer's screen.
 */
export function groundFindings(
  findings: CheckFinding[],
  refs: Map<string, RefTarget>,
  /** Frames on a video's sheet. A frame number outside them is not a frame. */
  frameCount = 0,
): (CheckFinding & { target: RefTarget; frames: number[] })[] {
  const kept = new Map<string, CheckFinding & { target: RefTarget; frames: number[] }>();

  for (const raw of findings) {
    const ref = typeof raw.ref === 'string' ? raw.ref.trim() : '';
    const target = refs.get(ref);
    // A ref nobody sent: a rule the model made up. Discarded, not reported.
    if (!target) continue;

    const message = typeof raw.message === 'string' ? raw.message.trim().slice(0, 400) : '';
    if (message.length === 0) continue;

    // The rule's own grading wins where it has one. The model is answering
    // "was this broken", not "how bad is it" - that was settled when the rule
    // was written down.
    let severity: CheckFinding['severity'] =
      target.kind === 'rule' && target.graded
        ? target.graded
        : raw.severity === 'critical' || raw.severity === 'warning'
          ? raw.severity
          : 'note';
    // What a brand has usually done is not what it must do. Departing from an
    // observed pattern is at most a warning, whatever the model called it.
    if (target.requirement === 'observed' && severity === 'critical') severity = 'warning';
    // A rule CIP suggested and no person has verified is a question, not a
    // ruling: it can raise a flag, but it cannot fail a creative on its own.
    if (target.kind === 'rule' && target.advisory && severity === 'critical') severity = 'warning';
    // "The black logo is approved" cannot be broken. A flag citing it is the
    // model reading a permission as a requirement, which is the flag the rule
    // exists to prevent.
    if (target.kind === 'rule' && target.permits) continue;
    if (target.kind === 'rule' && target.soft) severity = 'note';

    const frames = [...new Set((Array.isArray(raw.frames) ? raw.frames : []).map(Number))]
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= frameCount)
      .sort((a, b) => a - b);

    const finding = {
      ref,
      // The dimension comes from what the ref is, never from what the model
      // said it was, so a compliance rule cannot be quietly filed as visual.
      dimension: target.dimension,
      severity,
      message,
      target,
      frames,
    };

    // One flag per rule, the most severe of whatever was said about it, and
    // every frame anything said about it pointed at.
    const existing = kept.get(ref);
    if (!existing || SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) {
      const union = existing ? [...new Set([...existing.frames, ...frames])].sort((a, b) => a - b) : frames;
      kept.set(ref, { ...finding, frames: union });
    } else {
      existing.frames = [...new Set([...existing.frames, ...frames])].sort((a, b) => a - b);
    }
  }

  return [...kept.values()];
}

/** The bytes of a file, including one read from Google Drive without being kept. */
async function fileBytes(
  scope: CompanyScope,
  file: { id: string; storage_path: string | null },
): Promise<Buffer> {
  if (file.storage_path) return driveStorage().get(file.storage_path);

  const sql = adminSql();
  let externalId: string | undefined;
  try {
    const rows = await sql<{ external_id: string }[]>`
      select external_id from google_drive_files
       where file_id = ${file.id} and company_id = ${scope.companyId}
       limit 1
    `;
    externalId = rows[0]?.external_id;
  } finally {
    await sql.end();
  }
  if (!externalId) {
    throw new CheckRejected('That file was read without being kept, and its source is no longer known.');
  }

  const { requireConnected } = await import('../integrations/googleDrive/connection');
  const { googleDrive } = await import('../integrations/googleDrive');
  const connection = await requireConnected(scope);
  return googleDrive().download(connection.accessToken, externalId);
}

/** What is being checked, resolved to bytes and to the brand it is for. */
/**
 * Photographs of the approved pack, for the checker to compare against.
 *
 * Until now the checker judged a bottle it had never seen. Asked whether the
 * packaging was distorted, whether the logo had been recoloured, whether this
 * was even the approved pack, it had nothing but sentences describing a brand -
 * and every one of those questions is a comparison.
 *
 * The same retrieval the generator uses, and for the same reason: a photograph
 * of the product is what tells a real bottle from an invented one. Similarity
 * search answers "what resembles this creative", which for a Diwali banner is
 * every Diwali banner; these are found by what the Brain called them while it
 * looked, so what comes back is packshots.
 *
 * Failing a check because a reference will not load would be the wrong trade:
 * the check can still be run without them, only less well.
 */
async function packReferences(
  scope: CompanyScope,
  brand: string | null,
): Promise<{ bytes: Buffer; mimeType: string; name: string }[]> {
  if (!brand) return [];

  const shots = await productShots(scope, {
    brand,
    requestText: 'the approved pack and logo',
    limit: 3,
  }).catch(() => []);
  if (shots.length === 0) return [];

  const rows = await withCompanyScope(scope, (tx) =>
    tx<{ id: string; name: string; mime_type: string; storage_path: string | null }[]>`
      select id, name, mime_type, storage_path
        from drive_files
       where company_id = ${scope.companyId}
         and id = any(${shots.map((s) => s.fileId)}::uuid[])
         and archived_at is null
    `,
  );

  const store = driveStorage();
  const references: { bytes: Buffer; mimeType: string; name: string }[] = [];
  for (const row of rows) {
    if (!row.storage_path) continue;
    if (!CHECKABLE_IMAGES.has(row.mime_type.toLowerCase())) continue;
    try {
      const raw = await store.get(row.storage_path);
      const fitted = await fitForVision(raw, row.mime_type);
      references.push({ bytes: fitted.bytes, mimeType: fitted.mimeType, name: row.name });
    } catch {
      // One unreadable reference is not worth failing a check over.
    }
  }
  return references;
}

async function resolveSubject(
  scope: CompanyScope,
  input: {
    fileId?: string | null;
    generationId?: string | null;
    assetId?: string | null;
    /** Which page of a PDF to look at. Ignored for anything else. */
    page?: number | null;
  },
): Promise<{
  fileId: string | null;
  generationId: string | null;
  subject: string;
  bytes: Buffer;
  mimeType: string;
  brand: string | null;
  market: string | null;
  /** True only for a page drawn out of a PDF. */
  fromDocument: boolean;
  /** Set when the image is a video laid out frame by frame. */
  sequence?: VideoSequence | null;
  /** The sheet's frames at full size, in order. */
  frames?: SampledFrame[];
  /** The video itself, kept for timing what is on screen once the rules are known. */
  film?: { bytes: Buffer; extension: string };
}> {
  const fileId = input.fileId?.trim() || null;
  const generationId = input.generationId?.trim() || null;

  if ((fileId === null) === (generationId === null)) {
    throw new CheckRejected('Choose one creative to check: an uploaded file or something CIP made.');
  }

  if (fileId) {
    if (!UUID.test(fileId)) throw new CheckRejected('That file is not in this workspace.');
    const rows = await withCompanyScope(scope, (tx) =>
      tx<{ id: string; name: string; mime_type: string; storage_path: string | null; brand: string | null; market: string | null }[]>`
        select id, name, mime_type, storage_path, brand, market
          from drive_files
         where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
      `,
    );
    const file = rows[0];
    if (!file) throw new CheckRejected('That file is not in this workspace.');
    const mime = file.mime_type.toLowerCase();

    /**
     * A PDF is checked a page at a time, by looking at it.
     *
     * The page is drawn here rather than read from `pdf_page_understanding`,
     * because that table is filled by the worker and the worker may not have
     * reached this file - or may not be running at all. A checker that can only
     * judge what has already been processed cannot judge what somebody just
     * uploaded, which is the whole point of uploading it.
     */
    if (mime === 'application/pdf') {
      const page = Math.max(1, Math.trunc(input.page ?? 1));
      const body = await fileBytes(scope, file);
      const { pages } = await renderPdfPages(body, [page]);
      const drawn = pages[0];
      if (!drawn || drawn.bands.length === 0) {
        throw new CheckRejected(`CIP could not draw page ${page} of that PDF.`);
      }
      // The whole page, not a strip of it: a rule about where the logo sits
      // cannot be judged from the top third of a page.
      const band = drawn.bands[0]!;
      return {
        fileId: file.id,
        generationId: null,
        subject: pages.length > 0 ? `${file.name} — page ${page}` : file.name,
        bytes: band.bytes,
        mimeType: band.mimeType,
        brand: file.brand,
        market: file.market,
        fromDocument: true,
      };
    }

    /**
     * A video is checked whole, as one sheet of frames in order.
     *
     * Not a frame at a time like the pages of a deck: a film's statutory
     * warning is often on the end card only, and every other frame would be
     * failed for lacking it. See contactSheet.ts.
     */
    if ((ANALYSABLE_VIDEO_TYPES as readonly string[]).includes(mime)) {
      const body = await fileBytes(scope, file);
      const sheet = await videoContactSheet(
        body,
        VIDEO_EXTENSIONS[mime] ?? 'mp4',
        file.name,
        (await companyBrands(scope)).map((b) => b.name),
      );
      return {
        fileId: file.id,
        generationId: null,
        subject: file.name,
        bytes: sheet.bytes,
        mimeType: sheet.mimeType,
        brand: file.brand,
        market: file.market,
        fromDocument: false,
        sequence: sheet.sequence,
        frames: sheet.frames,
        film: { bytes: body, extension: VIDEO_EXTENSIONS[mime] ?? 'mp4' },
      };
    }

    if (!CHECKABLE_IMAGES.has(mime)) {
      throw new CheckRejected(
        'CIP can look at a picture, a PDF or a video. A Word document or a ' +
          'spreadsheet has to be exported to one of those first.',
      );
    }
    return {
      fileId: file.id,
      generationId: null,
      subject: file.name,
      bytes: await fileBytes(scope, file),
      mimeType: file.mime_type,
      brand: file.brand,
      market: file.market,
      fromDocument: false,
    };
  }

  if (!UUID.test(generationId!)) throw new CheckRejected('That creative is not in this workspace.');
  const asset = await readAsset(scope, generationId!, input.assetId ?? null);
  if (!CHECKABLE_IMAGES.has(asset.mimeType.toLowerCase())) {
    throw new CheckRejected('Only images can be checked for now.');
  }

  // The brief that produced it already knows which brand and market it was for.
  const briefs = await withCompanyScope(scope, (tx) =>
    tx<{ brand: string | null; market: string | null }[]>`
      select brief->>'brand' as brand, brief->>'market' as market
        from generation_briefs
       where generation_id = ${generationId} and company_id = ${scope.companyId}
       order by created_at desc
       limit 1
    `,
  );

  return {
    fileId: null,
    generationId,
    subject: `Generated creative ${generationId!.slice(0, 8)}`,
    // CIP made it to be an advert. It does not get to claim it is a chart.
    fromDocument: false,
    bytes: asset.bytes,
    mimeType: asset.mimeType,
    brand: briefs[0]?.brand ?? null,
    market: briefs[0]?.market ?? null,
  };
}

/**
 * Rules that turn on on-screen text or how long something is shown. Only these
 * pay for reading the film every second; the rest are judged from its shots.
 */
const TIMED_TEXT =
  /warning|disclaimer|statutory|legal line|super\b|legib|on[- ]?screen|duration|throughout|entire|whole (film|video|ad)|second/i;

/** Moments read when timing on-screen text, at most. */
const MAX_TIMELINE_FRAMES = 30;

/**
 * When each line of text is on screen, read every second or so.
 *
 * Null when it could not be done: the check goes on without it and says
 * nothing about timing it did not measure.
 */
async function readTimeline(
  provider: BrainProvider,
  filename: string,
  film: { bytes: Buffer; extension: string },
): Promise<{ step: number; spans: TextSpan[] } | null> {
  try {
    const { frames, duration, step } = await withTempFile(film.bytes, film.extension, async (path) => {
      const metadata = await readVideoMetadata(path);
      const step = Math.max(1, Math.ceil(metadata.durationSeconds / MAX_TIMELINE_FRAMES));
      return { frames: await framesEvery(path, metadata.durationSeconds, step), duration: metadata.durationSeconds, step };
    });
    if (frames.length === 0) return null;
    const reading = await provider.readFrames({ filename, frames });
    const spans = textSpans(
      frames.map((f, i) => ({ at: f.atSeconds, text: reading.texts[i] ?? '' })),
      step,
      duration,
    );
    return { step, spans };
  } catch {
    return null;
  }
}

/** Frames looked at again, at most. Past this each close-up costs more than it settles. */
const MAX_CLOSE_UPS = 6;

/**
 * The words on every frame, read at full size. Null when they could not be
 * read - the check goes on from the sheet, as it did before, and the model is
 * not told there is no text when nobody looked.
 */
async function readOnScreen(
  provider: BrainProvider,
  filename: string,
  frames: SampledFrame[],
): Promise<string[] | null> {
  try {
    const fitted = await Promise.all(frames.map((f) => fitForVision(f.bytes, f.mimeType)));
    const reading = await provider.readFrames({
      filename,
      frames: fitted.map((f, i) => ({ bytes: f.bytes, mimeType: f.mimeType, atSeconds: frames[i]!.atSeconds })),
    });
    return frames.map((_, i) => reading.texts[i] ?? '');
  } catch {
    return null;
  }
}

/**
 * A second look at a video's findings, close up.
 *
 * The first look saw a dozen thumbnails on one sheet, where a health warning is
 * a smudge and "missing" and "too small to read" look the same. Every finding
 * that would cost the film anything - critical or warning - is held up against
 * its own frames at full size, the text read off every frame, and the
 * soundtrack.
 *
 * Only a plain "this is wrong" removes a finding. "Not sure" keeps it, and so
 * does a second look that fails: a missed fault goes out to the public, a
 * wrong flag only costs a reviewer a minute. What was removed is kept, with the
 * reason, so the reviewer can see it and disagree.
 */
export async function lookAgain<F extends { ref: string; severity: CheckFinding['severity']; message: string; frames: number[] }>(
  provider: BrainProvider,
  input: {
    filename: string;
    brand: string | null;
    findings: F[];
    rules: Map<string, CheckRule>;
    frames: SampledFrame[];
    video: VideoSequence;
  },
): Promise<{ kept: F[]; secondLook: SecondLook | null }> {
  const serious = input.findings.filter((f) => f.severity !== 'note');
  if (serious.length === 0) return { kept: input.findings, secondLook: null };

  // The frames the findings point at, then the end card, then an even spread
  // for findings about the film as a whole.
  const count = input.frames.length;
  const wanted: number[] = [];
  const add = (n: number) => {
    if (n >= 1 && n <= count && !wanted.includes(n) && wanted.length < MAX_CLOSE_UPS) wanted.push(n);
  };
  serious.forEach((f) => f.frames.forEach(add));
  add(count);
  for (let i = 0; i < MAX_CLOSE_UPS && wanted.length < MAX_CLOSE_UPS; i += 1) {
    add(1 + Math.round((i * (count - 1)) / Math.max(1, MAX_CLOSE_UPS - 1)));
  }
  wanted.sort((a, b) => a - b);

  const heard =
    input.video.heard.status === 'heard'
      ? input.video.heard.text
      : input.video.heard.status === 'nothing_said'
        ? '(it has sound, but nothing is said)'
        : input.video.heard.status === 'no_audio'
          ? '(it has no sound)'
          : '(the soundtrack could not be transcribed; what is said is unknown)';
  const onScreen =
    (input.video.onScreen
      ? input.video.onScreen
          .map((text, i) => `frame ${i + 1} (${(input.video.at[i] ?? 0).toFixed(1)}s): ${text || '(no text)'}`)
          .join('\n')
      : '') +
    (input.video.timeline
      ? `\n\nWhen each line was on screen, read every ${input.video.timeline.step}s:\n` +
        input.video.timeline.spans
          .map((s) => `"${s.text}": ${s.shown.map((r) => `${r.from.toFixed(0)}-${r.to.toFixed(0)}s`).join(', ')} (${s.seconds}s)`)
          .join('\n')
      : '');

  const ruleText = (ref: string): string => {
    const rule = input.rules.get(ref);
    if (!rule) return ref;
    let line = `${rule.kind ?? rule.requirement}: ${rule.statement}`;
    if (rule.allowed && rule.allowed.length > 0) line += ` (allows: ${rule.allowed.join(', ')})`;
    if (rule.prohibited && rule.prohibited.length > 0) line += ` (forbids: ${rule.prohibited.join(', ')})`;
    return line;
  };

  let verdicts;
  try {
    const closeUps = await Promise.all(
      wanted.map(async (n) => {
        const frame = input.frames[n - 1]!;
        const fitted = await fitForVision(frame.bytes, frame.mimeType);
        return {
          bytes: fitted.bytes,
          mimeType: fitted.mimeType,
          label: `Frame ${n} (${frame.atSeconds.toFixed(1)}s)${n === count ? ', the end card' : ''}:`,
        };
      }),
    );
    const review = await provider.reviewFindings({
      filename: input.filename,
      brand: input.brand,
      findings: serious.map((f) => ({
        id: f.ref,
        rule: ruleText(f.ref),
        severity: f.severity,
        message: f.frames.length > 0 ? `${f.message} (frames ${f.frames.join(', ')})` : f.message,
      })),
      frames: closeUps,
      onScreen,
      heard,
    });
    verdicts = new Map(review.verdicts.map((v) => [v.id, v]));
  } catch {
    return {
      kept: input.findings,
      secondLook: { status: 'failed', reviewed: 0, unsure: 0, dropped: [] },
    };
  }

  const dropped: SecondLook['dropped'] = [];
  let unsure = 0;
  const kept = input.findings.filter((f) => {
    if (f.severity === 'note') return true;
    const verdict = verdicts.get(f.ref);
    if (verdict?.verdict === 'rejected') {
      dropped.push({ rule: input.rules.get(f.ref)?.statement ?? f.ref, message: f.message, reason: verdict.reason });
      return false;
    }
    // No answer about it is not an answer: it stays.
    if (!verdict || verdict.verdict === 'unsure') unsure += 1;
    return true;
  });

  return { kept, secondLook: { status: 'done', reviewed: serious.length, unsure, dropped } };
}

/**
 * Checks one creative, start to finish.
 *
 * The provider call happens between two short transactions rather than inside
 * one: a check is written as pending first, so a failure mid-call leaves a
 * record that says it failed rather than nothing at all.
 */
export async function runCheck(
  scope: CompanyScope,
  input: {
    fileId?: string | null;
    generationId?: string | null;
    assetId?: string | null;
    brand?: string | null;
    market?: string | null;
    /** Which page of a PDF to check. Defaults to the first. */
    page?: number | null;
  },
): Promise<CreativeCheck> {
  const provider = brain();
  if (!provider.configured) {
    throw new BrainFailed('NOT_CONFIGURED', 'permanent', 'The Brain is not configured.');
  }

  const subject = await resolveSubject(scope, input);
  // Only a reviewer's own choice skips the look. What the file is tagged with
  // is the weakest answer of the three and is used last - see below.
  let brand = input.brand?.trim() || null;
  const market = input.market?.trim() || subject.market;

  /**
   * When nobody has said which brand it is, look at the creative and find out.
   *
   * Which rules apply depends entirely on the answer. 8PM Honey's prohibition
   * on bees is not Royal Ranthambore's approval of tigers, and with no brand
   * named only the thirteen house-wide rules were ever fetched - so the picker
   * offering "Let CIP work it out" was describing something CIP did not do.
   *
   * The roster is sent, and an answer that is not on it is discarded. A brand
   * this company does not have is not a brand, and a guessed one is worse than
   * none: it pulls in another product's rules and fails a creative against
   * standards never written for it.
   */
  let identified: { brand: string | null; product: string | null; confidence: number; evidence: string | null } | null = null;
  if (!brand) {
    const roster = await companyBrands(scope);
    const names = roster.map((b) => b.name);
    if (names.length > 0) {
      const fitted = await fitForVision(subject.bytes, subject.mimeType);
      const said = await provider
        .identifyCreative({
          bytes: fitted.bytes,
          mimeType: fitted.mimeType,
          filename: subject.subject,
          brands: names,
        })
        .catch(() => null);

      if (said) {
        const match = names.find((name) => name.toLowerCase() === said.brand?.trim().toLowerCase());
        identified = { ...said, brand: match ?? null };
        // Below this, the reading is a guess dressed as a fact. Radico's own
        // document: "Do not invent missing information."
        if (match && said.confidence >= 0.7) brand = match;
      }
    }
  }

  /**
   * The file's own tag, last of the three.
   *
   * It used to be second, ahead of looking at the creative, and it is the least
   * trustworthy of them: a tag is often nobody's decision at all. A Magic
   * Moments creative named "ChatGPT Image Sep 22, 2026, 03_53_48 PM.png" was
   * filed under 8PM because "8 PM" appears in the timestamp, and every check of
   * it then ran against 8PM's rules and reported the Magic Moments logo as a
   * competitor's. The creative itself is better evidence than a label somebody
   * - or something - once put on the file.
   */
  if (!brand) brand = subject.brand;

  // What the brand has consistently done. Patterns only - a single observation
  // is not something a creative can be faulted for departing from.
  const facts = (
    await readBrandDna(scope, {
      brand,
      market,
      limit: MAX_FACTS,
      minEvidence: BRAIN_LIMITS.factMinEvidence,
    })
  ).filter((f) => f.section !== 'video');

  // What the category requires, read exactly as the planner reads it.
  const rules = await rulesForBrief(scope, { brand, market });

  const refs = new Map<string, RefTarget>();
  const sent: CheckRule[] = [];
  facts.forEach((fact, index) => {
    const ref = `F${index + 1}`;
    const dimension: CheckDimension = fact.section === 'content' ? 'verbal' : 'visual';
    refs.set(ref, { kind: 'fact', id: fact.id, dimension, requirement: 'observed' });
    sent.push({ ref, dimension, requirement: 'observed', statement: `${fact.attribute}: ${fact.value}` });
  });
  rules.forEach((rule, index) => {
    const ref = `R${index + 1}`;
    refs.set(ref, {
      kind: 'rule',
      id: rule.id,
      dimension: 'compliance',
      requirement: rule.requirement,
      advisory: rule.source === 'suggested' && rule.verifiedAt === null,
      graded: rule.ruleCode && rule.severity ? FROM_RULE[rule.severity] : undefined,
      permits: rule.ruleType === 'allowed',
      soft: rule.ruleType === 'preferred',
    });
    // Named, once more than one country's rules are in play: a West African
    // creative is judged against Ghana's rules and Nigeria's, and "the
    // statutory warning is missing" is only actionable once it says whose.
    sent.push({
      ref,
      dimension: 'compliance',
      requirement: rule.requirement,
      statement: rule.market ? `(${rule.market}) ${rule.rule}` : rule.rule,
      kind: rule.ruleType,
      allowed: rule.allowed ?? [],
      prohibited: rule.prohibited ?? [],
    });
  });

  const judged: Record<CheckDimension, boolean> = {
    visual: sent.some((r) => r.dimension === 'visual'),
    verbal: sent.some((r) => r.dimension === 'verbal'),
    compliance: sent.some((r) => r.dimension === 'compliance'),
  };

  const created = await withCompanyScope(scope, (tx) =>
    tx<{ id: string }[]>`
      insert into creative_checks
        (company_id, file_id, generation_id, brand, market, status,
         facts_considered, rules_considered, provider, model, created_by)
      values
        (${scope.companyId}, ${subject.fileId}, ${subject.generationId}, ${brand}, ${market},
         'pending', ${facts.length}, ${rules.length}, ${provider.name}, ${provider.model},
         ${scope.userId})
      returning id
    `,
  );
  const checkId = created[0]!.id;

  const frames = subject.frames ?? [];
  let video = subject.sequence ?? null;

  let analysis;
  let closeUps: { bytes: Buffer; mimeType: string; label: string }[] = [];
  try {
    if (video && frames.length > 0) {
      const [onScreen, timeline] = await Promise.all([
        readOnScreen(provider, subject.subject, frames),
        subject.film && sent.some((r) => TIMED_TEXT.test(r.statement))
          ? readTimeline(provider, subject.subject, subject.film)
          : Promise.resolve(null),
      ]);
      video = { ...video, onScreen, timeline };
      // The end card again, at full size: on the sheet it is one thumbnail
      // among a dozen, and it carries the warning, the logo and the pack.
      const end = frames.at(-1)!;
      const fittedEnd = await fitForVision(end.bytes, end.mimeType);
      closeUps = [{
        bytes: fittedEnd.bytes,
        mimeType: fittedEnd.mimeType,
        label:
          `The next image is frame ${frames.length} (${end.atSeconds.toFixed(1)}s), the end card, ` +
          'at full size. It is the same frame as the last one on the sheet - judge its small ' +
          'print from here.',
      }];
    }

    const fitted = await fitForVision(subject.bytes, subject.mimeType);
    analysis = await provider.checkCreative({
      bytes: fitted.bytes,
      mimeType: fitted.mimeType,
      filename: subject.subject,
      brand,
      market,
      rules: sent,
      houseBrands: (await companyBrands(scope)).map((b) => b.name),
      references: await packReferences(scope, brand),
      fromDocument: subject.fromDocument,
      sequence: video,
      closeUps,
    });
  } catch (error) {
    const failure =
      error instanceof BrainFailed
        ? error
        : new BrainFailed('PROVIDER_ERROR', 'transient', 'The creative could not be checked.');
    await withCompanyScope(scope, (tx) => tx`
      update creative_checks
         set status = 'failed', error_code = ${failure.code}, error_message = ${failure.message},
             completed_at = now()
       where id = ${checkId} and company_id = ${scope.companyId}
    `);
    throw failure;
  }

  let grounded = groundFindings(analysis.findings, refs, frames.length);

  // A video's findings were made from thumbnails. Each one that would cost the
  // film anything is looked at again, close up, before it is reported.
  let secondLook: SecondLook | null = null;
  if (video && frames.length > 0 && analysis.assetKind === 'creative') {
    const looked = await lookAgain(provider, {
      filename: subject.subject,
      brand,
      findings: grounded,
      rules: new Map(sent.map((r) => [r.ref, r])),
      frames,
      video,
    });
    grounded = looked.kept;
    secondLook = looked.secondLook;
  }

  const scores = scoreFrom(grounded, judged);

  let summary = analysis.summary.slice(0, 600) || null;
  if (sent.length === 0) {
    summary = 'Nothing to check against yet: CIP holds no established patterns or rules for this brand and market.';
  }
  // A page that is not an advert was not judged against advertising rules, and
  // the summary should not imply it was.
  if (analysis.assetKind !== 'creative') {
    summary =
      analysis.assetKind === 'blank'
        ? 'This page is blank. Nothing here to check.'
        : 'This is a page of a document rather than a creative, so the advertising rules were not applied to it.';
  }

  await withCompanyScope(scope, async (tx) => {
    for (const finding of grounded) {
      await tx`
        insert into check_flags
          (company_id, check_id, dimension, severity, message, fact_id, rule_id, at_seconds)
        values
          (${scope.companyId}, ${checkId}, ${finding.dimension}, ${finding.severity}, ${finding.message},
           ${finding.target.kind === 'fact' ? finding.target.id : null},
           ${finding.target.kind === 'rule' ? finding.target.id : null},
           ${finding.frames.map((n) => frames[n - 1]!.atSeconds)}::real[])
      `;
    }
    await tx`
      update creative_checks
         set status = 'ready', summary = ${summary}, asset_kind = ${analysis.assetKind},
             brand = ${brand}, detected_product = ${identified?.product ?? null},
             detected_confidence = ${identified ? identified.confidence : null},
             detected_evidence = ${identified?.evidence ?? null},
             score = ${scores.score}, visual_score = ${scores.visual},
             verbal_score = ${scores.verbal}, compliance_score = ${scores.compliance},
             video_seconds = ${video?.durationSeconds ?? null}::real,
             video_shots = ${video?.shots ?? null}::int,
             video_frames = ${video ? video.at : null}::real[],
             video_complete = ${video ? video.complete : null}::boolean,
             heard = ${video?.heard.status === 'heard' ? video.heard.text : null}::text,
             heard_status = ${video?.heard.status ?? null}::text,
             video_text = ${video?.onScreen ?? null}::text[],
             video_timeline = ${video?.timeline ? tx.json(video.timeline) : null},
             heard_language = ${video?.heard.status === 'heard' ? (video.heard.language ?? null) : null}::text,
             second_look = ${secondLook ? tx.json(secondLook) : null},
             completed_at = now()
       where id = ${checkId} and company_id = ${scope.companyId}
    `;
  });

  return (await getCheck(scope, checkId))!;
}

type VideoColumns = {
  video_seconds: number | null;
  video_shots: number | null;
  video_frames: number[] | null;
  video_complete: boolean | null;
  heard: string | null;
  heard_status: VideoCheck['heardStatus'] | null;
  video_text: string[] | null;
  second_look: SecondLook | null;
  video_timeline: VideoCheck['timeline'];
  heard_language: string | null;
};

function videoOf(row: VideoColumns): VideoCheck | null {
  if (row.video_seconds === null || row.heard_status === null) return null;
  return {
    durationSeconds: row.video_seconds,
    shots: row.video_shots ?? 0,
    framesAt: (row.video_frames ?? []).map(Number),
    complete: row.video_complete ?? true,
    heardStatus: row.heard_status,
    heard: row.heard,
    onScreen: row.video_text,
    secondLook: row.second_look,
    timeline: row.video_timeline,
    heardLanguage: row.heard_language,
  };
}

/** One check with its flags, and what each flag was judged against. */
export async function getCheck(scope: CompanyScope, checkId: string): Promise<CreativeCheck | null> {
  if (!UUID.test(checkId)) return null;

  return withCompanyScope(scope, async (tx) => {
    const checks = await tx<({
      id: string; file_id: string | null; generation_id: string | null; subject: string | null;
      brand: string | null; market: string | null; status: CreativeCheck['status'];
      score: number | null; visual_score: number | null; verbal_score: number | null;
      compliance_score: number | null; summary: string | null; facts_considered: number;
      rules_considered: number; error_message: string | null; created_at: Date;
      asset_kind: AssetKind; detected_product: string | null;
      detected_confidence: number | null; detected_evidence: string | null;
    } & VideoColumns)[]>`
      select c.id, c.file_id, c.generation_id, f.name as subject, c.brand, c.market, c.status,
             c.score, c.visual_score, c.verbal_score, c.compliance_score, c.summary,
             c.facts_considered, c.rules_considered, c.error_message, c.created_at,
             c.asset_kind, c.detected_product, c.detected_confidence, c.detected_evidence,
             c.video_seconds, c.video_shots, c.video_frames, c.video_complete, c.heard, c.heard_status,
             c.video_text, c.second_look, c.video_timeline, c.heard_language
        from creative_checks c
        left join drive_files f on f.id = c.file_id and f.company_id = c.company_id
       where c.id = ${checkId} and c.company_id = ${scope.companyId}
    `;
    const check = checks[0];
    if (!check) return null;

    const flags = await tx<{
      id: string; dimension: CheckDimension; severity: CheckFlag['severity']; message: string;
      fact_id: string | null; fact_attribute: string | null; fact_value: string | null; fact_brand: string | null;
      rule_id: string | null; rule_text: string | null; rule_source: RuleSource | null; rule_url: string | null;
      status: CheckFlag['status']; dispute_reason: CheckFlag['disputeReason']; correction: string | null;
      at_seconds: number[] | null;
    }[]>`
      select g.id, g.dimension, g.severity, g.message,
             g.fact_id, b.attribute as fact_attribute, b.value as fact_value, b.brand as fact_brand,
             g.rule_id, r.rule as rule_text, r.source as rule_source, r.reference_url as rule_url,
             g.status, g.dispute_reason, g.correction, g.at_seconds
        from check_flags g
        left join brand_dna_facts b on b.id = g.fact_id and b.company_id = g.company_id
        left join compliance_rules r on r.id = g.rule_id and r.company_id = g.company_id
       where g.check_id = ${checkId} and g.company_id = ${scope.companyId}
       order by case g.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
                g.dimension, g.created_at
    `;

    return {
      id: check.id,
      fileId: check.file_id,
      generationId: check.generation_id,
      subject: check.subject ?? (check.generation_id ? `Generated creative ${check.generation_id.slice(0, 8)}` : 'Creative'),
      assetKind: check.asset_kind,
      detected:
        check.detected_confidence === null
          ? null
          : {
              product: check.detected_product,
              confidence: check.detected_confidence,
              evidence: check.detected_evidence,
            },
      brand: check.brand,
      market: check.market,
      status: check.status,
      score: check.score,
      visualScore: check.visual_score,
      verbalScore: check.verbal_score,
      complianceScore: check.compliance_score,
      summary: check.summary,
      factsConsidered: check.facts_considered,
      rulesConsidered: check.rules_considered,
      errorMessage: check.error_message,
      createdAt: check.created_at.toISOString(),
      video: videoOf(check),
      flags: flags.map((g) => ({
        id: g.id,
        dimension: g.dimension,
        severity: g.severity,
        message: g.message,
        citedFact: g.fact_id
          ? { id: g.fact_id, attribute: g.fact_attribute ?? '', value: g.fact_value ?? '', brand: g.fact_brand }
          : null,
        citedRule: g.rule_id
          ? { id: g.rule_id, rule: g.rule_text ?? '', source: g.rule_source ?? 'manual', referenceUrl: g.rule_url }
          : null,
        status: g.status,
        disputeReason: g.dispute_reason,
        atSeconds: (g.at_seconds ?? []).map(Number),
        correction: g.correction,
      })),
    };
  });
}

/** Recent checks, newest first, without their flags. */
export async function listChecks(
  scope: CompanyScope,
  limit = 30,
): Promise<Omit<CreativeCheck, 'flags'>[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<({
      id: string; file_id: string | null; generation_id: string | null; subject: string | null;
      brand: string | null; market: string | null; status: CreativeCheck['status'];
      score: number | null; visual_score: number | null; verbal_score: number | null;
      compliance_score: number | null; summary: string | null; facts_considered: number;
      rules_considered: number; error_message: string | null; created_at: Date;
      asset_kind: AssetKind; detected_product: string | null;
      detected_confidence: number | null; detected_evidence: string | null;
    } & VideoColumns)[]>`
      select c.id, c.file_id, c.generation_id, f.name as subject, c.brand, c.market, c.status,
             c.score, c.visual_score, c.verbal_score, c.compliance_score, c.summary,
             c.facts_considered, c.rules_considered, c.error_message, c.created_at,
             c.asset_kind, c.detected_product, c.detected_confidence, c.detected_evidence,
             c.video_seconds, c.video_shots, c.video_frames, c.video_complete, c.heard, c.heard_status,
             c.video_text, c.second_look, c.video_timeline, c.heard_language
        from creative_checks c
        left join drive_files f on f.id = c.file_id and f.company_id = c.company_id
       where c.company_id = ${scope.companyId}
       order by c.created_at desc
       limit ${Math.min(Math.max(limit, 1), 100)}
    `;
    return rows.map((c) => ({
      id: c.id,
      fileId: c.file_id,
      generationId: c.generation_id,
      subject: c.subject ?? (c.generation_id ? `Generated creative ${c.generation_id.slice(0, 8)}` : 'Creative'),
      assetKind: c.asset_kind,
      detected:
        c.detected_confidence === null
          ? null
          : {
              product: c.detected_product,
              confidence: c.detected_confidence,
              evidence: c.detected_evidence,
            },
      brand: c.brand,
      market: c.market,
      status: c.status,
      score: c.score,
      visualScore: c.visual_score,
      verbalScore: c.verbal_score,
      complianceScore: c.compliance_score,
      summary: c.summary,
      factsConsidered: c.facts_considered,
      rulesConsidered: c.rules_considered,
      errorMessage: c.error_message,
      createdAt: c.created_at.toISOString(),
      video: videoOf(c),
    }));
  });
}

export type Correction =
  | { decision: 'accept' }
  | { decision: 'dispute'; reason: 'exception' | 'wrong_rule'; correction?: string | null };

/** What a correction changed in what CIP believes, if anything. */
export type Learned = 'fact_rejected' | 'rule_retired' | 'rule_kept' | null;

/**
 * A reviewer agreeing or disagreeing with one flag.
 *
 * Disputed flags stop counting against the score. Beyond that, only "this rule
 * is wrong" changes what CIP believes, and even then a rule that came from a
 * regulator is kept: one reviewer disagreeing with a statutory requirement is
 * recorded, not obeyed, because the regulator did not change its mind.
 */
export async function correctFlag(
  scope: CompanyScope,
  flagId: string,
  correction: Correction,
): Promise<{ check: CreativeCheck; learned: Learned }> {
  if (!UUID.test(flagId)) throw new CheckRejected('That flag is not in this workspace.');

  const outcome = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{
      check_id: string; fact_id: string | null; rule_id: string | null; rule_source: RuleSource | null;
    }[]>`
      select g.check_id, g.fact_id, g.rule_id, r.source as rule_source
        from check_flags g
        left join compliance_rules r on r.id = g.rule_id and r.company_id = g.company_id
       where g.id = ${flagId} and g.company_id = ${scope.companyId}
    `;
    const flag = rows[0];
    if (!flag) throw new CheckRejected('That flag is not in this workspace.');

    let learned: Learned = null;

    if (correction.decision === 'accept') {
      await tx`
        update check_flags
           set status = 'accepted', dispute_reason = null, correction = null,
               corrected_by = ${scope.userId}, corrected_at = now()
         where id = ${flagId} and company_id = ${scope.companyId}
      `;
    } else {
      if (correction.reason !== 'exception' && correction.reason !== 'wrong_rule') {
        throw new CheckRejected('Say whether this creative is an exception, or the rule itself is wrong.');
      }
      const note = correction.correction?.trim().slice(0, 600) || null;
      await tx`
        update check_flags
           set status = 'disputed', dispute_reason = ${correction.reason}, correction = ${note},
               corrected_by = ${scope.userId}, corrected_at = now()
         where id = ${flagId} and company_id = ${scope.companyId}
      `;

      if (correction.reason === 'wrong_rule') {
        if (flag.fact_id) {
          // A person said the brand does not actually do this. Nothing
          // automatic ever overturns a rejection.
          await tx`
            update brand_dna_facts set status = 'rejected', updated_at = now()
             where id = ${flag.fact_id} and company_id = ${scope.companyId}
          `;
          learned = 'fact_rejected';
        } else if (flag.rule_id) {
          if (flag.rule_source === 'regulation') {
            learned = 'rule_kept';
          } else {
            await tx`
              update compliance_rules set active = false, updated_at = now()
               where id = ${flag.rule_id} and company_id = ${scope.companyId}
            `;
            learned = 'rule_retired';
          }
        }
      }
    }

    // Re-score from the flags that still stand. A dimension that was not judged
    // before is not judged now: its score stays null.
    const check = await tx<{ visual_score: number | null; verbal_score: number | null; compliance_score: number | null }[]>`
      select visual_score, verbal_score, compliance_score from creative_checks
       where id = ${flag.check_id} and company_id = ${scope.companyId}
    `;
    const standing = await tx<{ dimension: CheckDimension; severity: CheckFinding['severity'] }[]>`
      select dimension, severity from check_flags
       where check_id = ${flag.check_id} and company_id = ${scope.companyId} and status <> 'disputed'
    `;
    const current = check[0]!;
    const scores = scoreFrom(standing, {
      visual: current.visual_score !== null,
      verbal: current.verbal_score !== null,
      compliance: current.compliance_score !== null,
    });
    await tx`
      update creative_checks
         set score = ${scores.score}, visual_score = ${scores.visual},
             verbal_score = ${scores.verbal}, compliance_score = ${scores.compliance}
       where id = ${flag.check_id} and company_id = ${scope.companyId}
    `;

    return { checkId: flag.check_id, learned };
  });

  return { check: (await getCheck(scope, outcome.checkId))!, learned: outcome.learned };
}

// --- generated creatives ----------------------------------------------------

/** The newest check of a generated creative, if it has been checked. */
export async function latestCheckForGeneration(
  scope: CompanyScope,
  generationId: string,
): Promise<CreativeCheck | null> {
  if (!UUID.test(generationId)) return null;
  const rows = await withCompanyScope(scope, (tx) =>
    tx<{ id: string }[]>`
      select id from creative_checks
       where company_id = ${scope.companyId} and generation_id = ${generationId}
       order by created_at desc
       limit 1
    `,
  );
  return rows[0] ? getCheck(scope, rows[0].id) : null;
}

/**
 * Checks the next generated image nobody has checked, across companies.
 *
 * The guidebook's rule: nothing CIP makes is treated as final until it has been
 * through the checker. Run from the worker rather than from the request that
 * made the picture, so nobody waits on a second vision call - the result card
 * fills in the verdict when it lands.
 *
 * Only images from the last week, and only ones a person asked for, because a
 * check is recorded against whoever made the request.
 */
export async function checkNextGeneration(): Promise<'checked' | 'failed' | null> {
  const sql = adminSql();
  let claim: { company_id: string; created_by: string; id: string } | undefined;
  try {
    const rows = await sql<{ company_id: string; created_by: string; id: string }[]>`
      select g.company_id, g.created_by, g.id
        from media_generations g
       where g.type = 'image'
         and g.status = 'completed'
         and g.created_by is not null
         and g.completed_at > now() - interval '7 days'
         and not exists (
           select 1 from creative_checks c
            where c.company_id = g.company_id and c.generation_id = g.id
         )
       order by g.completed_at
       limit 1
    `;
    claim = rows[0];
  } finally {
    await sql.end();
  }
  if (!claim) return null;

  const scope: CompanyScope = { companyId: claim.company_id, userId: claim.created_by, role: 'owner' };
  try {
    await runCheck(scope, { generationId: claim.id });
    return 'checked';
  } catch (error) {
    // A check that failed after it started has already recorded that. One that
    // could not start - the picture is gone - records it here, so the same
    // generation is not picked up on every pass for a week.
    const provider = brain();
    const message = error instanceof Error ? error.message.slice(0, 300) : 'The creative could not be checked.';
    await withCompanyScope(scope, (tx) => tx`
      insert into creative_checks
        (company_id, generation_id, status, error_message, facts_considered, rules_considered,
         provider, model, created_by, completed_at)
      select ${scope.companyId}::uuid, ${claim.id}::uuid, 'failed', ${message}, 0, 0,
             ${provider.name}, ${provider.model}, ${scope.userId}::uuid, now()
       where not exists (
         select 1 from creative_checks
          where company_id = ${scope.companyId} and generation_id = ${claim.id}
       )
    `).catch(() => {});
    return 'failed';
  }
}

/** A person confirming a rule is right, or taking that back. */
export async function setRuleVerified(scope: CompanyScope, ruleId: string, verified: boolean): Promise<boolean> {
  if (!UUID.test(ruleId)) return false;
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update compliance_rules
         set verified_at = ${verified ? new Date() : null},
             verified_by = ${verified ? scope.userId : null},
             updated_at = now()
       where id = ${ruleId} and company_id = ${scope.companyId}
      returning id
    `;
    return rows.length > 0;
  });
}

// --- compliance rules --------------------------------------------------------

/** Every rule, active first, grouped the way a reviewer reads them. */
export type BriefRule = {
  id: string;
  rule: string;
  requirement: 'required' | 'forbidden';
  category: RuleCategory;
  source: RuleSource;
  verifiedAt: Date | null;
  /**
   * The identifier the rule was written under, where it came from a document
   * that grades its own rules. Null for a rule somebody typed in, and that is
   * what tells the checker whether the severity below was stated or defaulted.
   */
  ruleCode: string | null;
  severity: RuleSeverity;
  ruleType: RuleType;
  /** The country or region whose rule this is. Null for one that applies everywhere. */
  market: string | null;
  /** Things the rule explicitly permits and forbids. */
  allowed: string[];
  prohibited: string[];
};

export type RuleSeverity = 'critical' | 'major' | 'minor' | 'informational';
export type RuleType =
  | 'mandatory' | 'prohibited' | 'preferred' | 'allowed'
  | 'conditional' | 'contextual' | 'human_review';

/**
 * A rule's own severity, in the three the checker scores with.
 *
 * A rule says how serious breaking it is; the model says whether it was broken.
 * Letting the model grade its own finding is letting it mark its own homework,
 * and it is why "tiger imagery is an approved association" could otherwise come
 * back as a critical failure for a creative that did exactly the right thing.
 *
 * Only rules that actually state a severity are graded this way. A rule typed
 * straight into CIP has no stated severity - the column has a default, and a
 * default is not a statement - so the model's own reading still decides. Taking
 * the default as though somebody had chosen it turned every rule already in the
 * database into a warning, and a missing statutory warning stopped failing.
 */
const FROM_RULE: Record<RuleSeverity, CheckFinding['severity']> = {
  critical: 'critical',
  major: 'warning',
  minor: 'note',
  informational: 'note',
};

/**
 * The rules that apply to one brand in one market.
 *
 * Rules about where and when an advert may run are left out: a picture cannot
 * show what time it was broadcast, and a generator has no use for them either.
 *
 * Shared by the checker and the planner, because a rule the checker will fail
 * a creative for is a rule the brief has to carry. They were separate, and the
 * consequence was exactly what you would expect - CIP made Indian creatives
 * with no statutory warning on them, then flagged them for not having one.
 */
export async function rulesForBrief(
  scope: CompanyScope,
  context: { brand?: string | null; market?: string | null },
): Promise<BriefRule[]> {
  const brand = context.brand?.trim() || null;
  const market = context.market?.trim() || null;
  // "West Africa" is Ghana and Nigeria, and a creative for it answers to both.
  // Matching the name alone applied neither. See marketsCovering.
  const covering = market ? marketsCovering(market).map((m) => m.toLowerCase()) : [];

  return withCompanyScope(scope, (tx) =>
    tx<BriefRule[]>`
      select id, rule, requirement, category, source, verified_at as "verifiedAt",
             rule_code as "ruleCode", severity, rule_type as "ruleType", market,
             allowed, prohibited
        from compliance_rules
       where company_id = ${scope.companyId}
         and active
         and category <> 'medium'
         and (brand is null or brand = ${brand})
         and (market is null or lower(market) = any(${covering}::text[]))
       order by requirement, rule
    `,
  );
}

export async function listRules(scope: CompanyScope): Promise<ComplianceRule[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{
      id: string; brand: string | null; market: string | null; category: RuleCategory;
      requirement: 'required' | 'forbidden'; rule: string; note: string | null;
      reference_url: string | null; source: RuleSource; active: boolean; verified_at: Date | null;
    }[]>`
      select id, brand, market, category, requirement, rule, note, reference_url, source, active, verified_at
        from compliance_rules
       where company_id = ${scope.companyId}
       order by active desc, market nulls first, brand nulls first, category, rule
    `;
    return rows.map((r) => ({
      id: r.id,
      brand: r.brand,
      market: r.market,
      category: r.category,
      requirement: r.requirement,
      rule: r.rule,
      note: r.note,
      referenceUrl: r.reference_url,
      source: r.source,
      active: r.active,
      verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
    }));
  });
}

/**
 * Keeps a rule a person stated, in the chat or anywhere else they say one.
 *
 * Verified as it is kept: the person who said it is the one confirming it, and
 * a brand's own team saying "the black logo is approved" is the authority on
 * that. Idempotent on the wording, brand and market, like every rule; saying it
 * again refreshes it, and brings back a rule that had been retired.
 */
export async function addStatedRule(
  scope: CompanyScope,
  input: {
    brand: string | null;
    market: string | null;
    kind: 'mandatory' | 'prohibited' | 'preferred' | 'allowed';
    statement: string;
    allowed: string[];
    prohibited: string[];
    note: string;
  },
): Promise<string> {
  const rule = input.statement.trim().slice(0, 500);
  if (rule.length === 0) throw new CheckRejected('A rule needs some words in it.');
  const requirement = input.kind === 'prohibited' ? 'forbidden' : 'required';
  const severity = { mandatory: 'major', prohibited: 'major', preferred: 'minor', allowed: 'informational' }[input.kind];
  const list = (values: string[]) => values.map((v) => v.trim().slice(0, 120)).filter(Boolean).slice(0, 12);

  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into compliance_rules
        (company_id, brand, market, category, requirement, rule, note, source, created_by,
         rule_type, severity, allowed, prohibited, verified_at, verified_by)
      values
        (${scope.companyId}, ${input.brand}, ${input.market}, 'other', ${requirement}, ${rule},
         ${input.note.slice(0, 1000)}, 'manual', ${scope.userId},
         ${input.kind}, ${severity}, ${list(input.allowed)}::text[], ${list(input.prohibited)}::text[],
         now(), ${scope.userId})
      on conflict (company_id, rule, coalesce(brand, ''), coalesce(market, ''))
        do update set
          requirement = excluded.requirement,
          rule_type = excluded.rule_type,
          severity = excluded.severity,
          allowed = excluded.allowed,
          prohibited = excluded.prohibited,
          note = excluded.note,
          active = true,
          verified_at = now(),
          verified_by = excluded.verified_by,
          updated_at = now()
      returning id
    `;
    return rows[0]!.id;
  });
}

/**
 * Adds one rule, or refreshes it.
 *
 * Idempotent on the rule, brand and market, so loading a market's rules twice
 * leaves one of each. A rule a reviewer retired is not brought back by a reload
 * - the retirement was a decision, and a seed script is not.
 */
export async function addComplianceRule(scope: CompanyScope, input: NewComplianceRule): Promise<boolean> {
  const rule = input.rule.trim().slice(0, 500);
  if (rule.length === 0) throw new CheckRejected('A rule needs some words in it.');
  if (input.requirement !== 'required' && input.requirement !== 'forbidden') {
    throw new CheckRejected('A rule is either something required or something forbidden.');
  }

  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into compliance_rules
        (company_id, brand, market, category, requirement, rule, note, reference_url, source, created_by)
      values
        (${scope.companyId}, ${input.brand?.trim() || null}, ${input.market?.trim() || null},
         ${input.category ?? 'other'}, ${input.requirement}, ${rule},
         ${input.note?.trim() || null}, ${input.referenceUrl?.trim() || null},
         ${input.source ?? 'manual'}, ${scope.userId})
      on conflict (company_id, rule, coalesce(brand, ''), coalesce(market, ''))
        do update set
          category = excluded.category,
          requirement = excluded.requirement,
          note = coalesce(excluded.note, compliance_rules.note),
          reference_url = coalesce(excluded.reference_url, compliance_rules.reference_url),
          updated_at = now()
      returning id
    `;
    return rows.length > 0;
  });
}

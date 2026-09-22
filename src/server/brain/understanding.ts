import 'server-only';
import { EXTRACTABLE_FILE_TYPES, isExtractable } from '@/lib/fileTypes';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { driveStorage } from '../drive/storage';
import { embedder, toVectorLiteral } from '../drive/embedding';
import { brain } from './providers';
import { similaritySupported } from './capabilities';
import { fitForVision } from './fitImage';
import { readPalette, withMeasuredPalette } from './palette';
import {
  ANALYSABLE_IMAGE_TYPES,
  ANALYSABLE_VIDEO_TYPES,
  BRAIN_LIMITS,
  BrainFailed,
} from './providers/types';
import type { AssetAnalysis, AssetFact, BrandRoster } from './providers/types';
import { needsVisualPass, understandPdfVisually } from './pdfVisual';
import { profilePdf } from '../drive/extraction/pdfRender';
import {
  extractAudio,
  ffmpegAvailable,
  readVideoMetadata,
  sampleFrames,
  transcribe,
  withTempFile,
} from './media';

/**
 * Turning a company's assets into understanding.
 *
 * An asset needs analysing when there is no ready row for its current content
 * hash. That is derived from the bytes, not stored as a flag, so re-syncing an
 * unchanged file costs nothing and a changed file is picked up automatically —
 * which is what keeps the Google Drive sync idempotent all the way through.
 *
 * Finding work is the only statement that looks across companies, exactly as in
 * Phases 3 and 4. Everything after the claim runs inside that company's scope,
 * so row-level security applies to every read and write that follows.
 */

export type AssetKind = 'image' | 'video' | 'document' | 'pdf_visual';

/** Which kind of understanding an asset needs, if any. */
export function kindFor(mimeType: string, fileType: string): AssetKind | null {
  const mime = mimeType.toLowerCase();
  if ((ANALYSABLE_IMAGE_TYPES as readonly string[]).includes(mime)) return 'image';
  if ((ANALYSABLE_VIDEO_TYPES as readonly string[]).includes(mime)) return 'video';
  // The types Phase 3 reads as text, taken from the one list that decides it.
  // This used to repeat them, and adding Markdown in two of the three places it
  // is named left a file that extracted cleanly and was never understood.
  if (isExtractable(fileType)) return 'document';
  return null;
}

/**
 * Queues everything in a company that has not been understood yet.
 *
 * Rows are created pending rather than analysed here: this is called from a
 * request, and analysing a video takes minutes.
 */
export async function enqueueUnderstanding(scope: CompanyScope): Promise<number> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ n: number }[]>`
      with candidate as (
        select f.id, f.company_id, f.mime_type, f.file_type, f.checksum_sha256
          from drive_files f
         where f.archived_at is null
           -- Brand material only. A market report or a book is read for what it
           -- says, never for what this brand looks and sounds like.
           and f.knowledge_role = 'brand'
           and f.checksum_sha256 is not null
           -- Once per content, not once per file.
           --
           -- Keyed on the file, the same deck uploaded twice was read twice,
           -- and Brand DNA counted the two readings as two assets agreeing
           -- with each other. They are one asset with two names, so the
           -- evidence behind a claim was inflated by however many copies of a
           -- file somebody had. Radico has the same earnings presentation in
           -- twice. Keyed on the bytes, the second copy costs nothing and
           -- proves nothing, which is right on both counts.
           and not exists (
             select 1 from asset_understanding u
              where u.company_id = f.company_id
                and u.content_hash = f.checksum_sha256
           )
      ),
      readable as (
        select c.* from candidate c
         where lower(c.mime_type) in ('image/png','image/jpeg','image/webp','image/gif',
                                      'video/mp4','video/quicktime','video/webm','video/x-matroska')
            -- Passed in rather than written out again. The readable types were
            -- listed in three places, and adding Markdown to two of them left a
            -- file that extracted cleanly and was never understood.
            or lower(c.file_type) = any(${[...EXTRACTABLE_FILE_TYPES]})
      )
      insert into asset_understanding (company_id, file_id, kind, provider, model, content_hash, status)
      -- One row per content, inside this statement as well as against what is
      -- already stored: two copies queued in the same pass would both pass the
      -- check above, which is evaluated before either of them exists.
      select distinct on (r.company_id, r.checksum_sha256)
             r.company_id, r.id,
             case
               when lower(r.mime_type) in ('image/png','image/jpeg','image/webp','image/gif') then 'image'
               when lower(r.mime_type) in ('video/mp4','video/quicktime','video/webm','video/x-matroska') then 'video'
               else 'document'
             end,
             ${brain().name}, ${brain().model}, r.checksum_sha256, 'pending'
        from readable r
       order by r.company_id, r.checksum_sha256, r.id
      on conflict (file_id, content_hash) do nothing
      returning 1 as n
    `;
    return rows.length;
  });
}

export type ClaimedAsset = {
  understandingId: string;
  companyId: string;
  fileId: string;
  kind: AssetKind;
  filename: string;
  fileType: string;
  mimeType: string;
  storagePath: string | null;
  attempts: number;
};

/** A scope for the worker, which has no session to derive one from. */
function workerScope(companyId: string): CompanyScope {
  return { companyId, userId: '00000000-0000-0000-0000-000000000000', role: 'owner' };
}

/**
 * Takes the next asset needing understanding, and marks it taken.
 *
 * The marking is the point, exactly as in the media queue: a bare
 * SELECT ... FOR UPDATE SKIP LOCKED releases its lock as soon as the statement
 * commits, which is long before a minute-long video analysis finishes, and two
 * workers would then pay to analyse the same asset.
 */
const CLAIM_LEASE_SECONDS = 900;

export async function claimAssetForUnderstanding(): Promise<ClaimedAsset | null> {
  const sql = adminSql();
  try {
    const rows = await sql<
      {
        id: string; company_id: string; file_id: string; kind: AssetKind;
        name: string; file_type: string; mime_type: string; storage_path: string | null;
        attempts: number;
      }[]
    >`
      update asset_understanding u
         set status = 'processing',
             next_attempt_at = now() + (${CLAIM_LEASE_SECONDS} * interval '1 second'),
             updated_at = now()
       where u.id = (
         select u2.id
           from asset_understanding u2
           join drive_files f on f.id = u2.file_id
          where u2.status in ('pending', 'processing')
            and u2.attempts < ${BRAIN_LIMITS.maxAttempts}
            and (u2.next_attempt_at is null or u2.next_attempt_at <= now())
            and f.archived_at is null
          order by u2.created_at
            for update of u2 skip locked
          limit 1
       )
      returning u.id, u.company_id, u.file_id, u.kind, u.attempts,
                (select name from drive_files where id = u.file_id) as name,
                (select file_type from drive_files where id = u.file_id) as file_type,
                (select mime_type from drive_files where id = u.file_id) as mime_type,
                (select storage_path from drive_files where id = u.file_id) as storage_path
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      understandingId: row.id,
      companyId: row.company_id,
      fileId: row.file_id,
      kind: row.kind,
      filename: row.name,
      fileType: row.file_type,
      mimeType: row.mime_type,
      storagePath: row.storage_path,
      attempts: row.attempts,
    };
  } finally {
    await sql.end();
  }
}

export type UnderstandingOutcome =
  | { status: 'understood'; kind: AssetKind; facts: number }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; message: string; willRetry: boolean };

/**
 * What kind of thing went wrong, with nothing of the asset in it.
 *
 * An error's message and stack can quote the content that was being analysed,
 * so neither is ever recorded. The constructor name cannot: it is a name
 * chosen by whoever wrote the class. It is still bounded in alphabet and
 * length, because some of these classes come from a remote SDK.
 */
function errorKind(error: unknown): string {
  const raw =
    error instanceof Error
      ? (error.name || error.constructor?.name || 'Error')
      : typeof error;
  return raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'unknown';
}

/**
 * The design block, turned into facts CIP can compare across assets.
 *
 * These carry fixed attribute names, and that is the entire point. Every other
 * fact is phrased freshly by the model, so the same observation arrived as
 * "logo or emblem visible", "logo placement" and "brand mark position" and
 * nothing could be compared between two assets - on a real roster that meant
 * 1231 facts of which not one was held by two brands.
 *
 * A name here never changes, so forty packshots that all put the logo top-left
 * accumulate as forty pieces of evidence for one fact rather than forty facts.
 * Which is what turns "somebody once saw a logo" into "this brand puts its
 * logo top-left", and it is what a brief needs to say.
 */
export function designFacts(structured: Record<string, unknown>, brand: string | null): AssetFact[] {
  const design = structured.design;
  if (!design || typeof design !== 'object') return [];

  const block = design as Record<string, unknown>;
  const facts: AssetFact[] = [];

  /** One stated value, if it was stated. Null is a real answer and is kept out. */
  const single = (key: string, attribute: string): void => {
    const raw = block[key];
    if (typeof raw !== 'string') return;
    const value = raw.trim();
    // "unknown" and "not visible" are the model saying null in prose. Storing
    // them would build evidence for a brand whose logo is placed "unknown".
    if (value.length < 2 || /^(unknown|none|n\/a|not visible|not applicable)$/i.test(value)) return;
    facts.push({ section: 'visual', attribute, value: value.slice(0, 160), brand });
  };

  const many = (key: string, attribute: string, limit: number): void => {
    const raw = block[key];
    if (!Array.isArray(raw)) return;
    for (const item of raw.slice(0, limit)) {
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (value.length < 2) continue;
      facts.push({ section: 'visual', attribute, value: value.slice(0, 160), brand });
    }
  };

  single('logoPlacement', 'logo placement');
  single('logoScale', 'logo scale');
  single('productPlacement', 'product placement');
  single('headlinePlacement', 'headline placement');
  single('headlineCase', 'headline case');
  single('safeArea', 'safe area');
  many('fonts', 'font', 3);
  many('paletteHex', 'palette', 6);

  return facts;
}

/**
 * Analyses one claimed asset and stores what it means.
 *
 * The provider sees the asset's content and its display name. It never sees the
 * company, the file id or the storage path.
 */
export async function understandClaimedAsset(claim: ClaimedAsset): Promise<UnderstandingOutcome> {
  const scope = workerScope(claim.companyId);
  const provider = brain();

  try {
    if (!provider.configured) {
      throw new BrainFailed('NOT_CONFIGURED', 'permanent', 'The Brain is not configured.');
    }

    const bytes = await bytesFor(claim);

    // A PDF is decided here rather than at enqueue, because the decision needs
    // the bytes: whether it has a text layer, and whether it shows anything.
    // An Instagram page exported to PDF has no text at all, and reading it as
    // a document produces nothing at all.
    const kind = claim.kind === 'document' && claim.fileType.toLowerCase() === 'pdf'
      ? await pdfKind(bytes)
      : claim.kind;

    // The brands this company works on, so a fact can be attributed to one.
    // Empty for most companies, and then nothing about this changes.
    const brands = await rosterFor(scope);

    // Print-resolution artwork is scaled to something a vision model will
    // actually accept. A brand's own asset library is full of it, and refusing
    // a 90 MB bottle shot taught CIP nothing about that brand at all.
    const fitted = kind === 'image' ? await fitForVision(bytes, claim.mimeType) : null;

    const analysis =
      kind === 'image'
        ? await provider.analyzeImage({
            bytes: fitted!.bytes,
            mimeType: fitted!.mimeType,
            filename: claim.filename,
            brands,
          })
        : kind === 'video'
          ? await understandVideo(claim, bytes, brands)
          : kind === 'pdf_visual'
            ? (await understandPdfVisually(scope, {
                fileId: claim.fileId,
                understandingId: claim.understandingId,
                filename: claim.filename,
                bytes,
              })).analysis
            : await understandDocument(scope, claim, brands);

    // The colours are measured, not asked for. See palette.ts: the model is
    // right to refuse to eyeball a hex value, so the pixels are counted here
    // and written over whatever the model left in the field.
    if (kind === 'image' && fitted) {
      withMeasuredPalette(analysis, await readPalette(fitted.bytes, fitted.mimeType));
    }

    await store(scope, { ...claim, kind }, analysis);

    // The facts of a visually-read PDF are recorded per page, against the page
    // they were seen on, so counting analysis.facts here would report zero for
    // a document that produced dozens. Ask the database what it actually holds.
    const facts = kind === 'pdf_visual'
      ? await countPdfFacts(scope, claim.fileId)
      : analysis.facts.length;

    return { status: 'understood', kind, facts };
  } catch (error) {
    const failure =
      error instanceof BrainFailed
        ? error
        : new BrainFailed(
            'PROVIDER_ERROR',
            'transient',
            // The error's class name, and nothing else from it. A TimeoutError
            // and a SyntaxError are entirely different problems with entirely
            // different fixes, and "the asset could not be understood" said
            // neither — a video failed for an hour with nothing to go on.
            `The asset could not be understood (${errorKind(error)}).`,
          );

    if (!(error instanceof BrainFailed)) {
      // The class name only. Never the message or the stack: both can quote
      // the asset's content, which belongs to the company and not in a log.
      console.error(`[brain] an asset failed to analyse unexpectedly: ${errorKind(error)}`);
    }

    if (failure.code === 'UNSUPPORTED_ASSET' || failure.code === 'ASSET_TOO_SMALL') {
      await markUnsupported(scope, claim.understandingId, failure.message);
      return { status: 'unsupported', reason: failure.message };
    }

    await recordFailure(scope, claim.understandingId, failure);
    return {
      status: 'failed',
      message: failure.message,
      willRetry: failure.kind !== 'permanent' && claim.attempts + 1 < BRAIN_LIMITS.maxAttempts,
    };
  }
}

/**
 * The asset's bytes, wherever they are.
 *
 * Almost always the object store. The exception is a file too large for it —
 * 52.84 MB against a 50 MB cap — which was read at sync time and deliberately
 * not kept. There is nothing to fetch locally for those, so they are fetched
 * from the source that has them, once, and released when this returns.
 *
 * Keeping the original was never the point: what CIP needs from a deck of
 * Instagram posts is the posts. This is what makes "read it, keep what you
 * learned" work rather than refusing the file outright.
 */
async function bytesFor(claim: ClaimedAsset): Promise<Buffer> {
  if (claim.storagePath) return driveStorage().get(claim.storagePath);

  const rows = await adminSql()<{ external_id: string }[]>`
    select g.external_id
      from google_drive_files g
     where g.file_id = ${claim.fileId} and g.company_id = ${claim.companyId}
     limit 1
  `;

  const externalId = rows[0]?.external_id;
  if (!externalId) {
    throw new BrainFailed(
      'UNSUPPORTED_ASSET',
      'permanent',
      'This file was read without being kept, and its source is no longer known.',
    );
  }

  const { requireConnected } = await import('../integrations/googleDrive/connection');
  const { googleDrive } = await import('../integrations/googleDrive');

  const scope = workerScope(claim.companyId);
  const connection = await requireConnected(scope);
  return googleDrive().download(connection.accessToken, externalId);
}

/**
 * The brands this company works on, as the analysis providers want them.
 *
 * Empty for a company that has not listed any, which is most of them — and
 * then every fact comes back with no brand and nothing downstream changes.
 */
async function rosterFor(scope: CompanyScope): Promise<BrandRoster> {
  const { companyBrands } = await import('./brands');
  const brands = await companyBrands(scope);
  return brands.map((b) => ({ name: b.name, note: b.note }));
}

/**
 * A video, reduced to something analysable.
 *
 * Metadata, then a bounded sample of frames, then the audio if there is any.
 * Never the whole file.
 */
async function understandVideo(
  claim: ClaimedAsset,
  bytes: Buffer,
  brands: BrandRoster,
): Promise<AssetAnalysis> {
  if (bytes.byteLength > BRAIN_LIMITS.maxVideoBytes) {
    throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'That video is too large to analyse.');
  }
  if (!(await ffmpegAvailable())) {
    throw new BrainFailed(
      'UNSUPPORTED_ASSET',
      'permanent',
      'Videos cannot be analysed here: ffmpeg is not available.',
    );
  }

  return withTempFile(bytes, claim.fileType, async (path) => {
    const metadata = await readVideoMetadata(path);

    if (metadata.durationSeconds > BRAIN_LIMITS.maxVideoSeconds) {
      throw new BrainFailed(
        'UNSUPPORTED_ASSET',
        'permanent',
        `That video is longer than the ${BRAIN_LIMITS.maxVideoSeconds}s limit for analysis.`,
      );
    }

    const frames = await sampleFrames(path, metadata);
    if (frames.length === 0) {
      throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'No frames could be sampled from that video.');
    }

    // Best effort: a video with no speech, or one whose audio will not
    // transcribe, is still worth understanding from its frames.
    const audio = await extractAudio(path, metadata);
    const transcript = audio ? await transcribe(audio, claim.filename) : null;

    const analysis = await brain().analyzeFrames({
      brands,
      frames,
      durationSeconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      transcript,
      filename: claim.filename,
    });

    // Metadata is fact rather than inference, so it is recorded directly
    // instead of being left to the model to report.
    return {
      ...analysis,
      structured: {
        ...analysis.structured,
        durationSeconds: Math.round(metadata.durationSeconds),
        width: metadata.width,
        height: metadata.height,
        framesSampled: frames.length,
        hasAudio: metadata.hasAudio,
        transcribed: transcript !== null,
      },
    };
  });
}

/**
 * Whether this PDF should be read or looked at.
 *
 * Profiling is cheap — it parses the page tree without rendering anything — so
 * it runs on every PDF rather than being guessed from the filename. A brand
 * guidelines document with a real text layer and no pictures stays on the
 * cheap path; a deck of screenshots does not.
 *
 * A PDF that will not parse is left as a document, so the existing extractor
 * reports the problem in the words it already has for it.
 */
async function pdfKind(bytes: Buffer): Promise<AssetKind> {
  try {
    return needsVisualPass(await profilePdf(bytes)) ? 'pdf_visual' : 'document';
  } catch {
    return 'document';
  }
}

/** How many distinct facts this PDF's pages produced. */
async function countPdfFacts(scope: CompanyScope, fileId: string): Promise<number> {
  const rows = await withCompanyScope(scope, async (tx) =>
    tx<{ n: number }[]>`
      select count(distinct fact_id)::int as n
        from brand_dna_evidence
       where company_id = ${scope.companyId}
         and file_id = ${fileId}
         and source_type = 'pdf_visual'
    `,
  );
  return rows[0]?.n ?? 0;
}

/** A document, read from the text Phase 3 already extracted. */
async function understandDocument(
  scope: CompanyScope,
  claim: ClaimedAsset,
  brands: BrandRoster,
): Promise<AssetAnalysis> {
  const rows = await withCompanyScope(scope, async (tx) =>
    tx<{ content: string }[]>`
      select content from drive_file_extractions
       where file_id = ${claim.fileId} and kind = 'text'
       order by created_at desc
       limit 1
    `,
  );

  const text = rows[0]?.content;
  if (!text || text.trim().length === 0) {
    throw new BrainFailed(
      'UNSUPPORTED_ASSET',
      'permanent',
      'That document has not been extracted yet, or has no readable text.',
    );
  }

  return analyseWholeDocument(text, claim.filename, brands);
}

/**
 * Reads a document that is longer than one call can hold.
 *
 * A single analyse call takes about 12,000 characters. Radico's brand brief is
 * 51,000, so passing it straight through read the first quarter and silently
 * dropped the rest — a document that names nine brands produced facts about
 * whichever ones happened to appear early.
 *
 * So it is read in sections, the same way a tall PDF page is looked at in
 * bands. Sections overlap by a little, because the sentence that states a rule
 * and the sentence that qualifies it should not be separated by a cut, and the
 * facts are merged afterwards on what they actually say.
 */
async function analyseWholeDocument(
  text: string,
  filename: string,
  brands: BrandRoster,
): Promise<AssetAnalysis> {
  const sections = sectionsOf(text, BRAIN_LIMITS.maxDocumentChars);

  if (sections.length === 1) {
    return brain().analyzeDocument({ text, filename, brands });
  }

  const results: AssetAnalysis[] = [];
  for (const [index, section] of sections.entries()) {
    results.push(
      await brain().analyzeDocument({
        // Said plainly, so the model knows it is reading a part and does not
        // summarise the whole from a quarter of it.
        text: `[Part ${index + 1} of ${sections.length} of this document]\n\n${section}`,
        filename,
        brands,
      }),
    );
  }

  const seen = new Set<string>();
  const facts = results
    .flatMap((result) => result.facts)
    .filter((fact) => {
      const key = `${fact.section}|${fact.attribute}|${fact.value}|${fact.brand ?? ''}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const first = results[0]!;

  return {
    // The first section's summary describes the document's opening, which for a
    // brief is what it is about. The rest add detail, not a new subject.
    summary: first.summary,
    extractedText: null,
    structured: {
      ...first.structured,
      partsRead: sections.length,
      charactersRead: text.length,
    },
    facts,
    usage: {
      inputTokens: sumOf(results.map((r) => r.usage.inputTokens)),
      outputTokens: sumOf(results.map((r) => r.usage.outputTokens)),
      durationMs: sumOf(results.map((r) => r.usage.durationMs)),
    },
  };
}

/**
 * Cuts text into readable sections, preferring to cut where it already breaks.
 *
 * A cut through the middle of a sentence loses the half-rule on either side of
 * it, so the split walks back to the last blank line — a heading boundary in
 * anything structured — and only falls back to a hard cut when there is none.
 */
export function sectionsOf(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const overlap = Math.floor(limit * 0.08);
  const sections: string[] = [];
  let start = 0;

  while (start < text.length) {
    const hardEnd = Math.min(start + limit, text.length);

    let end = hardEnd;
    if (hardEnd < text.length) {
      // Look for a paragraph break in the last fifth of the window.
      const window = text.slice(start + Math.floor(limit * 0.8), hardEnd);
      const brk = window.lastIndexOf('\n\n');
      if (brk > 0) end = start + Math.floor(limit * 0.8) + brk;
    }

    sections.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return sections;
}

function sumOf(values: (number | null | undefined)[]): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
}

/**
 * Stores the understanding and its vector.
 *
 * The summary is embedded with the same embedder the Drive uses, so Brain
 * memory and document chunks live in one vector space and retrieval does not
 * need a second system.
 */
async function store(
  scope: CompanyScope,
  claim: ClaimedAsset,
  analysis: AssetAnalysis,
): Promise<void> {
  const active = embedder();
  const canEmbed = await similaritySupported(scope);

  let vector: number[] | null = null;
  if (canEmbed) {
    try {
      const [embedded] = await active.embed([analysis.summary]);
      vector = embedded ?? null;
    } catch {
      // An understanding without a vector is still worth keeping: it shows in
      // the Brain UI and counts as evidence. Only similarity search misses it.
      vector = null;
    }
  }

  await withCompanyScope(scope, async (tx) => {
    await tx`
      update asset_understanding
         set status = 'ready',
             kind = ${claim.kind},
             provider = ${brain().name},
             model = ${brain().model},
             summary = ${analysis.summary},
             structured = ${tx.json(analysis.structured as never)},
             extracted_text = ${analysis.extractedText},
             embed_model = ${vector ? active.model : null},
             duration_ms = ${analysis.usage.durationMs ?? null},
             input_tokens = ${analysis.usage.inputTokens ?? null},
             output_tokens = ${analysis.usage.outputTokens ?? null},
             error_code = null,
             error_message = null,
             next_attempt_at = null,
             updated_at = now()
       where id = ${claim.understandingId}
    `;

    // Written on its own so the column can be absent altogether on a database
    // without pgvector, rather than breaking the whole update.
    if (vector) {
      await tx`
        update asset_understanding
           set embedding = ${toVectorLiteral(vector)}::vector
         where id = ${claim.understandingId}
      `;
    }

    // Each claim becomes evidence towards Brand DNA. Counted, never asserted:
    // a fact only becomes something the Brain states once enough assets agree.
    // What the model observed freely, plus the layout read into fixed names.
    // The second is what makes a rule out of a repeated observation.
    const everyFact = [
      ...analysis.facts,
      ...designFacts(analysis.structured, analysis.facts[0]?.brand ?? null),
    ];

    for (const fact of everyFact) {
      const factRows = await tx<{ id: string }[]>`
        insert into brand_dna_facts
          (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
        values
          (${scope.companyId}, ${fact.section}, ${fact.attribute}, ${fact.value},
           ${fact.brand ?? null}, 'observed', 0.2, 1)
        on conflict (company_id, section, attribute, value, coalesce(brand, '')) do update
           set evidence_count = brand_dna_facts.evidence_count + 1,
               updated_at = now()
        returning id
      `;

      const factId = factRows[0]?.id;
      if (!factId) continue;

      // Provenance: which asset supported this claim. Unique per (fact, file),
      // so re-analysing the same asset cannot inflate its own evidence.
      await tx`
        insert into brand_dna_evidence (company_id, fact_id, file_id)
        select ${scope.companyId}, ${factId}, ${claim.fileId}
         where not exists (
           select 1 from brand_dna_evidence
            where fact_id = ${factId} and file_id = ${claim.fileId}
         )
      `;
    }
  });
}

async function markUnsupported(
  scope: CompanyScope,
  understandingId: string,
  reason: string,
): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      update asset_understanding
         set status = 'unsupported',
             error_code = 'UNSUPPORTED_ASSET',
             error_message = ${reason.slice(0, 500)},
             next_attempt_at = null,
             updated_at = now()
       where id = ${understandingId}
    `;
  });
}

/**
 * Records a failure.
 *
 * Rate limiting does not spend an attempt — the asset did nothing wrong, and
 * counting it would exhaust every try during one busy minute. Same reasoning as
 * the embedding and media queues.
 */
async function recordFailure(
  scope: CompanyScope,
  understandingId: string,
  failure: BrainFailed,
): Promise<void> {
  const message = failure.message.slice(0, 500);

  await withCompanyScope(scope, async (tx) => {
    if (failure.kind === 'rate_limited') {
      const seconds = failure.retryAfterSeconds ?? 60;
      await tx`
        update asset_understanding
           set status = 'pending',
               error_code = ${failure.code},
               error_message = ${message},
               next_attempt_at = now() + (${seconds} * interval '1 second'),
               updated_at = now()
         where id = ${understandingId}
      `;
      return;
    }

    if (failure.kind === 'permanent') {
      await tx`
        update asset_understanding
           set status = 'failed',
               attempts = ${BRAIN_LIMITS.maxAttempts},
               error_code = ${failure.code},
               error_message = ${message},
               next_attempt_at = null,
               updated_at = now()
         where id = ${understandingId}
      `;
      return;
    }

    // Transient: spend an attempt and back off 2, 4 then 8 minutes.
    await tx`
      update asset_understanding
         set attempts = attempts + 1,
             error_code = ${failure.code},
             error_message = ${message},
             status = case when attempts + 1 >= ${BRAIN_LIMITS.maxAttempts} then 'failed' else 'pending' end,
             next_attempt_at = case
               when attempts + 1 >= ${BRAIN_LIMITS.maxAttempts} then null
               else now() + (power(2, least(attempts + 1, 3)) * interval '1 minute')
             end,
             updated_at = now()
       where id = ${understandingId}
    `;
  });
}

/** How much is waiting. Used by the worker summary and the Brain UI. */
export async function understandingQueueDepth(): Promise<{
  pending: number;
  processing: number;
  ready: number;
  failed: number;
  unsupported: number;
}> {
  const sql = adminSql();
  try {
    const rows = await sql<
      { pending: number; processing: number; ready: number; failed: number; unsupported: number }[]
    >`
      select
        count(*) filter (where status = 'pending')::int     as pending,
        count(*) filter (where status = 'processing')::int  as processing,
        count(*) filter (where status = 'ready')::int       as ready,
        count(*) filter (where status = 'failed')::int      as failed,
        count(*) filter (where status = 'unsupported')::int as unsupported
        from asset_understanding
    `;
    return rows[0] ?? { pending: 0, processing: 0, ready: 0, failed: 0, unsupported: 0 };
  } finally {
    await sql.end();
  }
}

/**
 * Queues work for every company that has assets needing it.
 *
 * The worker has no session, so it enqueues per company under a worker scope.
 * This is the only place that looks across companies, and it writes nothing
 * outside the company it is working on.
 */
export async function enqueueEverywhere(): Promise<number> {
  const sql = adminSql();
  let companies: { id: string }[];
  try {
    companies = await sql<{ id: string }[]>`select id from companies`;
  } finally {
    await sql.end();
  }

  let queued = 0;
  for (const company of companies) {
    queued += await enqueueUnderstanding(workerScope(company.id));
  }
  return queued;
}

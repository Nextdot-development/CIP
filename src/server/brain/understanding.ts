import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { driveStorage } from '../drive/storage';
import { embedder, toVectorLiteral } from '../drive/embedding';
import { brain } from './providers';
import { similaritySupported } from './capabilities';
import {
  ANALYSABLE_IMAGE_TYPES,
  ANALYSABLE_VIDEO_TYPES,
  BRAIN_LIMITS,
  BrainFailed,
} from './providers/types';
import type { AssetAnalysis } from './providers/types';
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

export type AssetKind = 'image' | 'video' | 'document';

/** Which kind of understanding an asset needs, if any. */
export function kindFor(mimeType: string, fileType: string): AssetKind | null {
  const mime = mimeType.toLowerCase();
  if ((ANALYSABLE_IMAGE_TYPES as readonly string[]).includes(mime)) return 'image';
  if ((ANALYSABLE_VIDEO_TYPES as readonly string[]).includes(mime)) return 'video';
  if (['pdf', 'docx', 'txt', 'csv'].includes(fileType.toLowerCase())) return 'document';
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
           and f.checksum_sha256 is not null
           and not exists (
             select 1 from asset_understanding u
              where u.file_id = f.id
                and u.content_hash = f.checksum_sha256
           )
      )
      insert into asset_understanding (company_id, file_id, kind, provider, model, content_hash, status)
      select c.company_id, c.id,
             case
               when lower(c.mime_type) in ('image/png','image/jpeg','image/webp','image/gif') then 'image'
               when lower(c.mime_type) in ('video/mp4','video/quicktime','video/webm','video/x-matroska') then 'video'
               else 'document'
             end,
             ${brain().name}, ${brain().model}, c.checksum_sha256, 'pending'
        from candidate c
       where lower(c.mime_type) in ('image/png','image/jpeg','image/webp','image/gif',
                                    'video/mp4','video/quicktime','video/webm','video/x-matroska')
          or lower(c.file_type) in ('pdf','docx','txt','csv')
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
  storagePath: string;
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
        name: string; file_type: string; mime_type: string; storage_path: string; attempts: number;
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

    const bytes = await driveStorage().get(claim.storagePath);

    const analysis =
      claim.kind === 'image'
        ? await provider.analyzeImage({ bytes, mimeType: claim.mimeType, filename: claim.filename })
        : claim.kind === 'video'
          ? await understandVideo(claim, bytes)
          : await understandDocument(scope, claim);

    await store(scope, claim, analysis);
    return { status: 'understood', kind: claim.kind, facts: analysis.facts.length };
  } catch (error) {
    const failure =
      error instanceof BrainFailed
        ? error
        : new BrainFailed('PROVIDER_ERROR', 'transient', 'The asset could not be understood.');

    if (!(error instanceof BrainFailed)) {
      // Never log the error itself: it can carry the asset's content.
      console.error('[brain] an asset failed to analyse unexpectedly');
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
 * A video, reduced to something analysable.
 *
 * Metadata, then a bounded sample of frames, then the audio if there is any.
 * Never the whole file.
 */
async function understandVideo(claim: ClaimedAsset, bytes: Buffer): Promise<AssetAnalysis> {
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

/** A document, read from the text Phase 3 already extracted. */
async function understandDocument(scope: CompanyScope, claim: ClaimedAsset): Promise<AssetAnalysis> {
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

  return brain().analyzeDocument({ text, filename: claim.filename });
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
    for (const fact of analysis.facts) {
      const factRows = await tx<{ id: string }[]>`
        insert into brand_dna_facts
          (company_id, section, attribute, value, kind, confidence, evidence_count)
        values
          (${scope.companyId}, ${fact.section}, ${fact.attribute}, ${fact.value},
           'observed', 0.2, 1)
        on conflict (company_id, section, attribute, value) do update
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

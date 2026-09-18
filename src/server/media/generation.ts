import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { driveStorage } from '../drive/storage';
import { allowedImageChoices, imageGenerationProvider, videoGenerationProvider } from './providers';
import type { ImageProviderChoice } from './providers/types';
import { MEDIA_LIMITS, ProviderFailed } from './providers/types';
import type { GeneratedAsset, ProviderUsage, ReferenceImage } from './providers/types';
import { extensionFor, mediaStorageKey, putMediaAsset } from './storage';
import {
  MediaConflict,
  MediaNotFound,
  MediaProviderUnavailable,
  MediaRejected,
  isSupportedImageType,
  validateChoice,
  validateDuration,
  validateIdempotencyKey,
  validatePrompt,
  validateReferenceIds,
} from './types';
import type { MediaAssetDTO, MediaGenerationDTO, MediaStatus, MediaType } from './types';
import { fitForVision } from '../brain/fitImage';
import { reframe } from './reframe';
import type { TargetShape } from './reframe';

/**
 * Creating, reading and finishing generations.
 *
 * Every function here takes a CompanyScope and no company parameter, so there
 * is no argument a request body could fill in to reach another company. Every
 * statement runs inside withCompanyScope, so row-level security is the filter
 * even where a WHERE clause is also present.
 *
 * Images are produced during the request because they take seconds. Videos are
 * queued, because they take minutes and an HTTP request must not wait for one.
 * Both leave the same kind of record behind, so history, retry and download do
 * not care which kind they are looking at.
 */

type GenerationRow = {
  id: string;
  type: MediaType;
  provider: string;
  model: string;
  prompt: string;
  status: MediaStatus;
  width: number | null;
  height: number | null;
  duration_seconds: string | null;
  error_code: string | null;
  error_message: string | null;
  input_metadata: { aspectRatio?: string | null } | null;
  storage_path: string | null;
  asset_count: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

/** The only place a row becomes something a caller can see. */
function toDTO(row: GenerationRow): MediaGenerationDTO {
  return {
    id: row.id,
    type: row.type,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    status: row.status,
    width: row.width,
    height: row.height,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    errorCode: (row.error_code as MediaGenerationDTO['errorCode']) ?? null,
    errorMessage: row.error_message,
    aspectRatio: row.input_metadata?.aspectRatio ?? null,
    // Whether bytes exist, never where they are.
    hasAsset: row.storage_path !== null,
    assetCount: Number(row.asset_count ?? 0),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

const SELECT_COLUMNS = `
  g.id, g.type, g.provider, g.model, g.prompt, g.status,
  g.width, g.height, g.duration_seconds,
  g.error_code, g.error_message, g.input_metadata,
  g.storage_path, g.created_at, g.started_at, g.completed_at,
  (select count(*) from media_generation_assets a
    where a.generation_id = g.id and a.company_id = g.company_id)::int as asset_count
`;

export type ImageGenerationInput = {
  prompt: unknown;
  /** 'openai' or 'gemini'. Omitted means the configured default. */
  provider?: unknown;
  referenceFileIds?: unknown;
  aspectRatio?: unknown;
  imageSize?: unknown;
  idempotencyKey?: unknown;
  /**
   * The shape to deliver, which need not be one the generator offers.
   *
   * A generator makes a handful of shapes. Asked for 4:5, CIP produced the
   * nearest and told the person to crop it themselves — handing its own job
   * back. The nearest is still what gets generated; this is what comes out.
   */
  deliverShape?: TargetShape | null;
  /**
   * A picture CIP made earlier, to carry into this one.
   *
   * "Make it 9:16", "same thing with less text" - every one of those started
   * again from nothing, because the only references a generation could take
   * were files in the Drive, and what CIP makes does not go there. The earlier
   * image goes in as a reference image like any other.
   */
  basedOnGenerationId?: unknown;
};

export type VideoGenerationInput = {
  prompt: unknown;
  referenceFileId?: unknown;
  durationSeconds?: unknown;
  resolution?: unknown;
  aspectRatio?: unknown;
  idempotencyKey?: unknown;
};

/**
 * Generates an image and stores it.
 *
 * The row is written before the provider is called, so a call that succeeds
 * and then fails to store still leaves a record saying what happened rather
 * than a charge with nothing to show for it.
 */
export async function generateImage(
  scope: CompanyScope,
  input: ImageGenerationInput,
): Promise<MediaGenerationDTO> {
  const provider = imageGenerationProvider(validateProviderChoice(input.provider));
  const prompt = validatePrompt(input.prompt);

  // Refuse before writing a record or calling anything: a provider with no key
  // cannot produce an image, and saying so now is better than a failed
  // generation the caller has to go and read.
  if (!provider.configured && provider.name !== 'fake-image') {
    throw new MediaProviderUnavailable(
      `${provider.name === 'openai' ? 'OpenAI' : 'Gemini'} image generation is not configured.`,
    );
  }
  const aspectRatio = validateChoice(input.aspectRatio, provider.aspectRatios, 'Aspect ratio');
  const imageSize = validateChoice(input.imageSize, provider.imageSizes, 'Image size');
  const referenceIds = validateReferenceIds(input.referenceFileIds);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);

  const existing = await findByIdempotencyKey(scope, idempotencyKey);
  if (existing) return existing;

  // Resolved under this company's scope. A Drive file id belonging to another
  // company is simply not found, so it cannot become a reference image.
  const { references, skipped: skippedReferences } = await resolveReferences(scope, referenceIds);

  // The picture this one is being built from, resolved through the same scope:
  // a generation belonging to another company is simply not found.
  const basedOn = await carriedForward(scope, input.basedOnGenerationId, references.length);
  const allReferences = [...references, ...basedOn.references];

  const id = await insertGeneration(scope, {
    type: 'image',
    provider: provider.name,
    model: provider.model,
    prompt,
    status: 'processing',
    inputMetadata: {
      aspectRatio,
      imageSize,
      referenceCount: allReferences.length,
      /** The generation this one was built from, so a chain can be followed back. */
      basedOn: basedOn.id,
      // Recorded rather than silently dropped: a picture made with one
      // reference instead of four looks different, and this is the only place
      // that says why.
      referencesSkipped: skippedReferences,
      // What was asked for, next to what the generator could make. The two
      // differ whenever a shape is not on the generator's own list.
      deliveredShape: input.deliverShape?.label ?? null,
      // Kept so a retry goes back to the provider that was chosen, rather than
      // to whatever the default happens to be by then.
      providerChoice: validateProviderChoice(input.provider),
    },
    idempotencyKey,
  });

  try {
    const result = await provider.generate({
      prompt, references: allReferences, aspectRatio, imageSize,
    });

    // Cut to the shape that was asked for, before anything is stored. Storing
    // the generator's shape and cropping on the way out would mean the file
    // somebody downloads and the file CIP kept are different pictures.
    const assets = input.deliverShape
      ? await Promise.all(
          result.assets.map(async (asset) => {
            const framed = await reframe(asset.bytes, asset.mimeType, input.deliverShape!);
            // A picture that cannot be re-cut is delivered as it came. This
            // step makes a result better and must never remove one.
            return framed
              ? { ...asset, bytes: framed.bytes, mimeType: framed.mimeType,
                  width: framed.width, height: framed.height }
              : asset;
          }),
        )
      : result.assets;

    await completeGeneration(scope, id, assets, result.usage, result.model);
  } catch (error) {
    await failGeneration(scope, id, error);
    // Re-thrown so the caller learns immediately rather than polling a record
    // it just created to find out its request did not work.
    throw asPublicError(error);
  }

  const generation = await getGeneration(scope, id);
  return generation.generation;
}

/**
 * Queues a video. Returns as soon as the record exists.
 *
 * Nothing is submitted to the provider here: submission and polling both
 * belong to the worker, so a slow provider cannot hold an HTTP request open
 * and a restart cannot lose a job that was only half started.
 */
export async function generateVideo(
  scope: CompanyScope,
  input: VideoGenerationInput,
): Promise<MediaGenerationDTO> {
  const provider = videoGenerationProvider();
  const prompt = validatePrompt(input.prompt);
  const resolution = validateChoice(input.resolution, provider.resolutions, 'Resolution');
  const durationSeconds = validateDuration(input.durationSeconds);
  const aspectRatio = typeof input.aspectRatio === 'string' ? input.aspectRatio : null;
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);

  const referenceIds =
    typeof input.referenceFileId === 'string' && input.referenceFileId.length > 0
      ? [input.referenceFileId]
      : [];

  const existing = await findByIdempotencyKey(scope, idempotencyKey);
  if (existing) return existing;

  // Resolved now rather than in the worker so a bad reference is a 404 the
  // caller sees, not a job that fails a minute later for no visible reason.
  const { references, skipped: skippedReferences } = await resolveReferences(scope, referenceIds);

  const id = await insertGeneration(scope, {
    type: 'video',
    provider: provider.name,
    model: provider.model,
    prompt,
    status: 'queued',
    inputMetadata: {
      aspectRatio,
      resolution,
      durationSeconds,
      referenceFileId: references.length > 0 ? referenceIds[0] : null,
      referencesSkipped: skippedReferences,
    },
    idempotencyKey,
  });

  const generation = await getGeneration(scope, id);
  return generation.generation;
}

export async function listGenerations(
  scope: CompanyScope,
  options: { limit?: number; type?: MediaType | null } = {},
): Promise<{ generations: MediaGenerationDTO[] }> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const type = options.type ?? null;

  const rows = await withCompanyScope(scope, async (tx) => {
    return tx.unsafe<GenerationRow[]>(
      `select ${SELECT_COLUMNS}
         from media_generations g
        where ($1::text is null or g.type = $1::text)
        order by g.created_at desc
        limit $2`,
      [type, limit],
    );
  });

  return { generations: rows.map(toDTO) };
}

export async function getGeneration(
  scope: CompanyScope,
  id: string,
): Promise<{ generation: MediaGenerationDTO; assets: MediaAssetDTO[] }> {
  if (!isUuid(id)) throw new MediaNotFound();

  return withCompanyScope(scope, async (tx) => {
    const rows = await tx.unsafe<GenerationRow[]>(
      `select ${SELECT_COLUMNS} from media_generations g where g.id = $1`,
      [id],
    );
    const row = rows[0];
    // 404 rather than 403: telling a caller that an id exists but is not
    // theirs is telling them it exists.
    if (!row) throw new MediaNotFound();

    const assets = await tx<
      {
        id: string;
        mime_type: string;
        file_size: number;
        width: number | null;
        height: number | null;
        duration_seconds: string | null;
        ordinal: number;
      }[]
    >`
      select id, mime_type, file_size, width, height, duration_seconds, ordinal
        from media_generation_assets
       where generation_id = ${id}
       order by ordinal
    `;

    return {
      generation: toDTO(row),
      assets: assets.map((a) => ({
        id: a.id,
        mimeType: a.mime_type,
        fileSize: a.file_size,
        width: a.width,
        height: a.height,
        durationSeconds: a.duration_seconds === null ? null : Number(a.duration_seconds),
        ordinal: a.ordinal,
      })),
    };
  });
}

/**
 * The bytes of one generated asset.
 *
 * The storage path is read inside the company's scope and never leaves this
 * function — the caller passes ids and receives bytes, so there is no way for
 * a path to reach a response.
 */
export async function readAsset(
  scope: CompanyScope,
  generationId: string,
  assetId?: string | null,
): Promise<{ bytes: Buffer; mimeType: string; fileSize: number }> {
  if (!isUuid(generationId)) throw new MediaNotFound();
  if (assetId && !isUuid(assetId)) throw new MediaNotFound();

  const row = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ storage_path: string; mime_type: string; file_size: number }[]>`
      select a.storage_path, a.mime_type, a.file_size
        from media_generation_assets a
        join media_generations g
          on g.id = a.generation_id and g.company_id = a.company_id
       where a.generation_id = ${generationId}
         and (${assetId ?? null}::uuid is null or a.id = ${assetId ?? null}::uuid)
       order by a.ordinal
       limit 1
    `;
    return rows[0] ?? null;
  });

  if (!row) throw new MediaNotFound('That file');

  try {
    const bytes = await driveStorage().get(row.storage_path);
    return { bytes, mimeType: row.mime_type, fileSize: row.file_size };
  } catch {
    // The row says the object exists and the store disagrees. Recoverable, and
    // worth saying so plainly rather than returning a broken download.
    throw new MediaRejected(
      'That file is recorded but its contents are missing. Try generating it again.',
      'STORAGE_ERROR',
    );
  }
}

/** Puts a failed generation back in the queue. */
export async function retryGeneration(scope: CompanyScope, id: string): Promise<MediaGenerationDTO> {
  if (!isUuid(id)) throw new MediaNotFound();

  await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ status: MediaStatus }[]>`
      select status from media_generations where id = ${id} for update
    `;
    const row = rows[0];
    if (!row) throw new MediaNotFound();
    if (row.status !== 'failed' && row.status !== 'cancelled') {
      throw new MediaConflict('Only a failed or cancelled generation can be retried.');
    }

    await tx`
      update media_generations
         set status = 'queued',
             attempts = 0,
             error_code = null,
             error_message = null,
             provider_job_id = null,
             next_attempt_at = null,
             started_at = null,
             completed_at = null
       where id = ${id}
    `;
  });

  const { generation } = await getGeneration(scope, id);
  return generation;
}

/** Stops a generation that has not finished. */
export async function cancelGeneration(scope: CompanyScope, id: string): Promise<MediaGenerationDTO> {
  if (!isUuid(id)) throw new MediaNotFound();

  const jobId = await withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ status: MediaStatus; provider_job_id: string | null; type: MediaType }[]>`
      select status, provider_job_id, type from media_generations where id = ${id} for update
    `;
    const row = rows[0];
    if (!row) throw new MediaNotFound();
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      throw new MediaConflict('That generation has already finished.');
    }

    await tx`
      update media_generations
         set status = 'cancelled',
             error_code = 'CANCELLED',
             error_message = 'Cancelled.',
             completed_at = now(),
             next_attempt_at = null
       where id = ${id}
    `;
    return row.type === 'video' ? row.provider_job_id : null;
  });

  // Telling the provider is best effort and happens after our own record is
  // settled: if this throws, the generation is still cancelled here.
  if (jobId) {
    const provider = videoGenerationProvider();
    if (provider.supportsCancel) {
      try {
        await provider.cancel(jobId);
      } catch {
        console.warn('[media] the provider would not cancel a job; the record is cancelled anyway');
      }
    }
  }

  const { generation } = await getGeneration(scope, id);
  return generation;
}

// --- internals --------------------------------------------------------------

async function findByIdempotencyKey(
  scope: CompanyScope,
  key: string | null,
): Promise<MediaGenerationDTO | null> {
  if (!key) return null;

  const rows = await withCompanyScope(scope, async (tx) =>
    tx.unsafe<GenerationRow[]>(
      `select ${SELECT_COLUMNS} from media_generations g where g.idempotency_key = $1`,
      [key],
    ),
  );

  const row = rows[0];
  return row ? toDTO(row) : null;
}

/**
 * Writes the row.
 *
 * inputMetadata is handed to the driver as an object, not as a string. Passing
 * JSON.stringify(...) instead encodes it twice: the driver JSON-encodes the
 * string it was given, and the column ends up holding a jsonb *string* rather
 * than an object. Everything then reads back as undefined — which is exactly
 * what happened to aspectRatio here until a test asked for a field back.
 */
async function insertGeneration(
  scope: CompanyScope,
  values: {
    type: MediaType;
    provider: string;
    model: string;
    prompt: string;
    status: MediaStatus;
    inputMetadata: Record<string, unknown>;
    idempotencyKey: string | null;
  },
): Promise<string> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into media_generations
        (company_id, created_by, type, provider, model, prompt, status,
         input_metadata, idempotency_key, started_at)
      values
        (${scope.companyId}, ${scope.userId}, ${values.type}, ${values.provider},
         ${values.model}, ${values.prompt}, ${values.status},
         ${tx.json(values.inputMetadata as never)}, ${values.idempotencyKey},
         ${values.status === 'processing' ? new Date() : null})
      returning id
    `;
    return rows[0]!.id;
  });
}

/**
 * Fetches reference images the company owns.
 *
 * Drive file ids are resolved through the company's own rows, so an id from
 * another company does not resolve and the request is refused. The provider
 * later receives bytes only — never the id, never the path.
 */
async function resolveReferences(
  scope: CompanyScope,
  fileIds: string[],
): Promise<{ references: ReferenceImage[]; skipped: number }> {
  if (fileIds.length === 0) return { references: [], skipped: 0 };
  if (fileIds.some((id) => !isUuid(id))) throw new MediaNotFound('That reference image');

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<{ id: string; storage_path: string | null; file_type: string }[]>`
      select id, storage_path, file_type
        from drive_files
       where id = any(${fileIds}::uuid[])
         and archived_at is null
    `,
  );

  if (rows.length !== fileIds.length) throw new MediaNotFound('That reference image');

  const store = driveStorage();
  const references: ReferenceImage[] = [];
  let skipped = 0;

  for (const row of rows) {
    // A type the generator cannot take is the caller's mistake, and stays
    // fatal. Everything below this line is a property of the stored file
    // rather than of the request, and a reference image is an aid and not a
    // requirement: the brief already carries what CIP knows about the brand.
    // Failing the whole generation because one of four aids is unreadable is
    // the wrong trade, and it is what happened — three of four references on
    // a real request were each independently fatal, so nothing was made at
    // all and no record existed to explain why.
    const mimeType = imageMimeFor(row.file_type);
    if (!mimeType) throw new MediaRejected('Reference images must be PNG, JPEG or WebP.');

    // A file read without being kept has no bytes here by design: it was too
    // large for the object store, and CIP looked at it instead of storing it.
    if (!row.storage_path) {
      skipped += 1;
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await store.get(row.storage_path);
    } catch {
      skipped += 1;
      continue;
    }

    if (bytes.byteLength > MEDIA_LIMITS.maxReferenceBytes) {
      // Scaled to fit rather than refused, for the same reason an oversized
      // image is scaled before the Brain looks at it: a 9 MB packshot is a
      // perfectly good reference, and print resolution is what a brand's own
      // library is full of.
      const fitted = await fitForVision(bytes, mimeType, {
        maxBytes: MEDIA_LIMITS.maxReferenceBytes,
        maxEdge: MEDIA_LIMITS.referenceEdgePixels,
      });
      if (fitted.bytes.byteLength > MEDIA_LIMITS.maxReferenceBytes) {
        skipped += 1;
        continue;
      }
      references.push({ bytes: fitted.bytes, mimeType: fitted.mimeType });
      continue;
    }

    references.push({ bytes, mimeType });
  }

  return { references, skipped };
}

/**
 * The picture from an earlier generation, as a reference for this one.
 *
 * Read through readAsset, which proves the generation belongs to this company
 * before it hands back a byte - the same path a download takes, so there is no
 * second way in. A generation that produced a video, or something no generator
 * accepts, is skipped rather than refused: building on an earlier picture is
 * an aid, and losing the aid must not lose the request.
 */
async function carriedForward(
  scope: CompanyScope,
  generationId: unknown,
  used: number,
): Promise<{ id: string | null; references: ReferenceImage[] }> {
  const none = { id: null, references: [] };
  if (typeof generationId !== 'string' || generationId.length === 0) return none;
  if (!isUuid(generationId)) throw new MediaNotFound('That generation');
  if (used >= MEDIA_LIMITS.maxReferenceImages) return none;

  const asset = await readAsset(scope, generationId, null);
  if (!isSupportedImageType(asset.mimeType)) return none;

  let bytes = asset.bytes;
  let mimeType = asset.mimeType;
  if (bytes.byteLength > MEDIA_LIMITS.maxReferenceBytes) {
    const fitted = await fitForVision(bytes, mimeType, {
      maxBytes: MEDIA_LIMITS.maxReferenceBytes,
      maxEdge: MEDIA_LIMITS.referenceEdgePixels,
    });
    if (fitted.bytes.byteLength > MEDIA_LIMITS.maxReferenceBytes) return none;
    bytes = fitted.bytes;
    mimeType = fitted.mimeType;
  }

  return { id: generationId, references: [{ bytes, mimeType }] };
}

function imageMimeFor(fileType: string): string | null {
  const mime =
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
    }[fileType.toLowerCase()] ?? null;
  return mime && isSupportedImageType(mime) ? mime : null;
}

/**
 * Stores the produced files and marks the generation done.
 *
 * Bytes are written before the row is updated, so the failure mode is an
 * object with no row — which `storage:gc` collects — rather than a row that
 * promises a file nobody can fetch. The insert is idempotent on
 * (generation_id, ordinal), so re-running after a partial failure converges
 * instead of stacking duplicates.
 */
export async function completeGeneration(
  scope: CompanyScope,
  generationId: string,
  assets: GeneratedAsset[],
  usage: ProviderUsage,
  model: string,
): Promise<void> {
  if (assets.length === 0) {
    throw new ProviderFailed('GENERATION_FAILED', 'permanent', 'The provider returned no files.');
  }

  const stored: {
    assetId: string;
    key: string;
    asset: GeneratedAsset;
    ordinal: number;
  }[] = [];

  for (const [ordinal, asset] of assets.entries()) {
    if (asset.bytes.byteLength > MEDIA_LIMITS.maxAssetBytes) {
      throw new ProviderFailed('STORAGE_ERROR', 'permanent', 'The generated file is too large to store.');
    }
    const assetId = crypto.randomUUID();
    const key = mediaStorageKey(scope.companyId, generationId, assetId, extensionFor(asset.mimeType));
    await putMediaAsset(key, asset.bytes, asset.mimeType);
    stored.push({ assetId, key, asset, ordinal });
  }

  const primary = stored[0]!;

  await withCompanyScope(scope, async (tx) => {
    for (const item of stored) {
      await tx`
        insert into media_generation_assets
          (id, company_id, generation_id, storage_bucket, storage_path, mime_type,
           file_size, width, height, duration_seconds, ordinal)
        values
          (${item.assetId}, ${scope.companyId}, ${generationId},
           ${process.env.SUPABASE_STORAGE_BUCKET ?? 'local'}, ${item.key}, ${item.asset.mimeType},
           ${item.asset.bytes.byteLength}, ${item.asset.width ?? null}, ${item.asset.height ?? null},
           ${item.asset.durationSeconds ?? null}, ${item.ordinal})
        on conflict (generation_id, ordinal) do nothing
      `;
    }

    await tx`
      update media_generations
         set status = 'completed',
             model = ${model},
             storage_bucket = ${process.env.SUPABASE_STORAGE_BUCKET ?? 'local'},
             storage_path = ${primary.key},
             width = ${primary.asset.width ?? null},
             height = ${primary.asset.height ?? null},
             duration_seconds = ${primary.asset.durationSeconds ?? null},
             provider_request_id = ${usage.providerRequestId ?? null},
             input_units = ${usage.inputUnits ?? null},
             output_units = ${usage.outputUnits ?? null},
             estimated_cost = ${usage.estimatedCost ?? null},
             cost_currency = ${usage.costCurrency ?? null},
             error_code = null,
             error_message = null,
             next_attempt_at = null,
             completed_at = now()
       where id = ${generationId}
    `;
  });
}

/**
 * Records a failure against a generation.
 *
 * Rate limiting does not spend an attempt — the request was fine, and counting
 * it would burn all three tries in one busy minute. This mirrors what the
 * embedding queue does, for the same reason.
 */
export async function failGeneration(
  scope: CompanyScope,
  generationId: string,
  error: unknown,
): Promise<void> {
  const failure =
    error instanceof ProviderFailed
      ? error
      : new ProviderFailed('GENERATION_FAILED', 'transient', 'The generation did not finish.');

  if (!(error instanceof ProviderFailed)) {
    // Never log the error itself: it can carry the prompt or the provider's
    // echo of it, and both are the customer's.
    console.error('[media] a generation failed unexpectedly');
  }

  const message = failure.message.slice(0, 500);

  await withCompanyScope(scope, async (tx) => {
    if (failure.kind === 'rate_limited') {
      const seconds = failure.retryAfterSeconds ?? 30;
      await tx`
        update media_generations
           set status = 'queued',
               error_code = ${failure.code},
               error_message = ${message},
               next_attempt_at = now() + (${seconds} * interval '1 second')
         where id = ${generationId}
      `;
      return;
    }

    if (failure.kind === 'permanent') {
      await tx`
        update media_generations
           set status = 'failed',
               attempts = ${MEDIA_LIMITS.maxAttempts},
               error_code = ${failure.code},
               error_message = ${message},
               next_attempt_at = null,
               completed_at = now()
         where id = ${generationId}
      `;
      return;
    }

    // Transient: spend an attempt, back off 2, 4 then 8 minutes, and only call
    // it failed once there are no attempts left.
    await tx`
      update media_generations
         set attempts = attempts + 1,
             error_code = ${failure.code},
             error_message = ${message},
             status = case when attempts + 1 >= ${MEDIA_LIMITS.maxAttempts} then 'failed' else 'queued' end,
             completed_at = case when attempts + 1 >= ${MEDIA_LIMITS.maxAttempts} then now() else null end,
             next_attempt_at = case
               when attempts + 1 >= ${MEDIA_LIMITS.maxAttempts} then null
               else now() + (power(2, least(attempts + 1, 3)) * interval '1 minute')
             end
       where id = ${generationId}
    `;
  });
}

/** What a caller is told. Never the provider's own wording. */
function asPublicError(error: unknown): Error {
  if (error instanceof ProviderFailed) {
    if (error.code === 'PROVIDER_NOT_CONFIGURED') return new MediaProviderUnavailable(error.message);
    return new MediaRejected(error.message, error.code);
  }
  if (error instanceof MediaRejected || error instanceof MediaNotFound) return error;
  return new MediaRejected('The generation did not finish.', 'GENERATION_FAILED');
}

/**
 * Validates a provider name from a request.
 *
 * Only a generator this deployment allows is accepted. An unknown one — or one
 * that has been turned off — is refused rather than quietly falling back to
 * the default, because a caller that asked for a particular provider and
 * silently got another has been misled.
 */
export function validateProviderChoice(value: unknown): ImageProviderChoice | null {
  if (value === undefined || value === null || value === '') return null;
  const allowed = allowedImageChoices();
  if (typeof value !== 'string' || !allowed.includes(value as ImageProviderChoice)) {
    throw new MediaRejected(`Provider must be one of: ${allowed.join(', ')}.`);
  }
  return value as ImageProviderChoice;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { EMBEDDING_LIMITS, EmbeddingFailed, embedder, toVectorLiteral } from './embedding';

/**
 * The embedding queue.
 *
 * A chunk needs a vector when no row exists for it under the active model.
 * That is derived, not stored: a status column would be a second copy of the
 * same fact, free to drift from it, and the first thing to go wrong after a
 * partial failure.
 *
 * Finding work is the only statement that looks across companies, exactly as
 * in Phase 3, and it returns one company's chunk ids and nothing else. Every
 * read and write after it runs inside withCompanyScope for that company, so
 * row-level security applies throughout.
 */

export type ClaimedChunks = {
  companyId: string;
  chunks: { id: string; fileId: string; content: string }[];
};

/** A scope for the worker, which has no session to derive one from. */
function workerScope(companyId: string): CompanyScope {
  return { companyId, userId: '00000000-0000-0000-0000-000000000000', role: 'owner' };
}

/**
 * Takes the next batch, all from one company.
 *
 * One company per batch, because everything downstream runs under that
 * company's scope. FOR UPDATE ... SKIP LOCKED keeps two workers off the same
 * chunks — without it they would both pay for the same vectors.
 */
export async function claimChunksNeedingEmbedding(): Promise<ClaimedChunks | null> {
  const sql = adminSql();
  const model = embedder().model;

  try {
    const rows = await sql<{ id: string; company_id: string; file_id: string; content: string }[]>`
      with candidate as (
        select c.id, c.company_id, c.created_at
          from drive_file_chunks c
          left join drive_file_embeddings e
            on e.chunk_id = c.id and e.model = ${model}
         where e.id is null
           and c.embedding_attempts < ${EMBEDDING_LIMITS.maxAttempts}
           and (c.next_embedding_attempt_at is null or c.next_embedding_attempt_at <= now())
      ),
      next_company as (
        select company_id from candidate order by created_at limit 1
      )
      select c.id, c.company_id, c.file_id, c.content
        from drive_file_chunks c
        join candidate cand on cand.id = c.id
        join next_company nc on nc.company_id = cand.company_id
       order by cand.created_at
         for update of c skip locked
       limit ${EMBEDDING_LIMITS.batchSize}
    `;

    const first = rows[0];
    if (!first) return null;

    return {
      companyId: first.company_id,
      chunks: rows.map((r) => ({ id: r.id, fileId: r.file_id, content: r.content })),
    };
  } finally {
    await sql.end();
  }
}

export type EmbedOutcome =
  | { status: 'embedded'; companyId: string; count: number }
  | { status: 'failed'; companyId: string; count: number; message: string; willRetry: boolean };

/**
 * Embeds one claimed batch and stores the vectors.
 *
 * The provider sees the chunk text and nothing else — no ids, no company, no
 * paths. Nothing from the request or the response is logged.
 */
export async function embedClaimedChunks(claim: ClaimedChunks): Promise<EmbedOutcome> {
  const active = embedder();
  const scope = workerScope(claim.companyId);

  let vectors: number[][];
  try {
    vectors = await active.embed(claim.chunks.map((c) => c.content));
  } catch (error) {
    const failure =
      error instanceof EmbeddingFailed
        ? error
        : new EmbeddingFailed('transient', 'Something went wrong while embedding these chunks.');

    if (!(error instanceof EmbeddingFailed)) {
      // Never log the error itself: it can carry the text that was sent.
      console.error('[embeddings] unexpected failure for a batch of', claim.chunks.length, 'chunks');
    }

    await recordFailure(scope, claim.chunks.map((c) => c.id), failure);
    return {
      status: 'failed',
      companyId: claim.companyId,
      count: claim.chunks.length,
      message: failure.message,
      willRetry: failure.kind !== 'permanent',
    };
  }

  await withCompanyScope(scope, async (tx) => {
    for (const [i, chunk] of claim.chunks.entries()) {
      const vector = vectors[i];
      if (!vector) continue;
      await tx`
        insert into drive_file_embeddings
          (company_id, chunk_id, file_id, model, dimensions, embedding, input_chars)
        values
          (${scope.companyId}, ${chunk.id}, ${chunk.fileId}, ${active.model},
           ${active.dimensions}, ${toVectorLiteral(vector)}::vector, ${chunk.content.length})
        on conflict (chunk_id, model) do nothing
      `;
    }

    await tx`
      update drive_file_chunks
         set embedding_attempts = 0, embedding_error = null, next_embedding_attempt_at = null
       where company_id = ${scope.companyId}
         and id = any(${claim.chunks.map((c) => c.id)}::uuid[])
    `;
  });

  return { status: 'embedded', companyId: claim.companyId, count: claim.chunks.length };
}

/**
 * Records a failure against every chunk in the batch.
 *
 * Rate limiting does not spend an attempt — the chunk did nothing wrong, and
 * counting it would exhaust all three tries during one busy minute.
 */
async function recordFailure(
  scope: CompanyScope,
  chunkIds: string[],
  failure: EmbeddingFailed,
): Promise<void> {
  const message = failure.message.slice(0, 500);

  await withCompanyScope(scope, async (tx) => {
    if (failure.kind === 'rate_limited') {
      const seconds = failure.retryAfterSeconds ?? 30;
      await tx`
        update drive_file_chunks
           set embedding_error = ${message},
               next_embedding_attempt_at = now() + (${seconds} * interval '1 second')
         where company_id = ${scope.companyId} and id = any(${chunkIds}::uuid[])
      `;
      return;
    }

    if (failure.kind === 'permanent') {
      // Retrying will be refused identically, so stop now rather than in ten minutes.
      await tx`
        update drive_file_chunks
           set embedding_attempts = ${EMBEDDING_LIMITS.maxAttempts},
               embedding_error = ${message},
               next_embedding_attempt_at = null
         where company_id = ${scope.companyId} and id = any(${chunkIds}::uuid[])
      `;
      return;
    }

    // Transient: spend an attempt and back off 2, 4, then 8 minutes.
    await tx`
      update drive_file_chunks
         set embedding_attempts = embedding_attempts + 1,
             embedding_error = ${message},
             next_embedding_attempt_at =
               now() + (power(2, least(embedding_attempts + 1, 3)) * interval '1 minute')
       where company_id = ${scope.companyId} and id = any(${chunkIds}::uuid[])
    `;
  });
}

/** How much is waiting. Used by the worker summary and /api/health. */
export async function embeddingQueueDepth(): Promise<{ pending: number; failed: number; embedded: number }> {
  const sql = adminSql();
  const model = embedder().model;
  try {
    const rows = await sql<{ pending: number; failed: number; embedded: number }[]>`
      select
        count(*) filter (where e.id is null and c.embedding_attempts < ${EMBEDDING_LIMITS.maxAttempts})::int as pending,
        count(*) filter (where e.id is null and c.embedding_attempts >= ${EMBEDDING_LIMITS.maxAttempts})::int as failed,
        count(*) filter (where e.id is not null)::int as embedded
        from drive_file_chunks c
        left join drive_file_embeddings e on e.chunk_id = c.id and e.model = ${model}
    `;
    return rows[0] ?? { pending: 0, failed: 0, embedded: 0 };
  } finally {
    await sql.end();
  }
}

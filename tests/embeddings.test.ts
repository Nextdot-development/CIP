import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * Phase 4 — embeddings and semantic search.
 *
 * Everything runs against the deterministic fake embedder, so the suite needs
 * no key, no network and no money. The fake is a bag of words, which matters:
 * cosine similarity between two of its vectors rises with shared vocabulary,
 * so "A searches B's exact wording" produces a query vector that would match
 * B's chunk almost perfectly if the company boundary ever failed.
 */

let db: TestDb;
let appSql: postgres.Sql;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

let drive: typeof import('../src/server/drive/service');
let processing: typeof import('../src/server/drive/processing');
let queue: typeof import('../src/server/drive/embeddingQueue');
let search: typeof import('../src/server/drive/semanticSearch');
let embedding: typeof import('../src/server/drive/embedding');

const PASSWORD = 'cip-demo-password';
const NL = String.fromCharCode(10);

/** Wording that exists only in Narayana Health's Drive. */
const NH_SECRET_TEXT =
  'Patient consent must be signed before any real patient appears in a film.' + NL + NL +
  'Cardiac rehabilitation programmes run for twelve weeks at the Bangalore unit.';

const MM_TEXT =
  'Magic Moments talks about the occasion, never the alcohol.' + NL + NL +
  'Carousels outperform single images on Instagram for festival campaigns.';

async function drainExtraction(): Promise<void> {
  for (;;) {
    const file = await processing.claimNextFile();
    if (!file) break;
    await processing.processClaimedFile(file);
  }
}

async function drainEmbeddings(): Promise<number> {
  let done = 0;
  for (;;) {
    const claim = await queue.claimChunksNeedingEmbedding();
    if (!claim) break;
    const outcome = await queue.embedClaimedChunks(claim);
    if (outcome.status === 'failed') break;
    done += outcome.count;
  }
  return done;
}

const upload = (scope: Scope, filename: string, body: string) =>
  drive.uploadFile(scope, { folderId: null, filename, mimeType: 'text/plain', body: Buffer.from(body) });

/**
 * pgvector is a hard requirement from migration 0007 onward, and the embedded
 * PostgreSQL used for the offline suite does not ship it.
 *
 * Node decides `skip` when a describe is registered, which is before any hook
 * runs, so the decision has to come from the environment rather than from
 * probing the database. `npm run test:embeddings` sets TEST_DATABASE_ADMIN_URL
 * to a database that has pgvector, and then every test below runs for real.
 */
const SKIP: string | false = process.env.TEST_DATABASE_ADMIN_URL
  ? false
  : 'needs pgvector — run `npm run test:embeddings` with TEST_DATABASE_ADMIN_URL set';

before(async () => {
  if (SKIP) return;
  db = await startTestDatabase();
  if (!db.hasVector) {
    throw new Error('TEST_DATABASE_ADMIN_URL points at a database without pgvector.');
  }
  storageDir = mkdtempSync(join(tmpdir(), 'cip-embed-'));

  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = PASSWORD;
  process.env.CIP_STORAGE_DIR = storageDir;
  process.env.CIP_FORCE_LOCAL_STORAGE = 'true';
  // No key, no network, no bill — and deterministic rankings.
  process.env.CIP_FORCE_FAKE_EMBEDDER = 'true';

  const { migrate } = await import('../src/server/migrate');
  await migrate(() => {});
  const { seed } = await import('../src/server/seed');
  await seed(() => {});

  process.env.DATABASE_URL = db.appUrl;
  drive = await import('../src/server/drive/service');
  processing = await import('../src/server/drive/processing');
  queue = await import('../src/server/drive/embeddingQueue');
  search = await import('../src/server/drive/semanticSearch');
  embedding = await import('../src/server/drive/embedding');

  adminSql = postgres(db.adminUrl, { onnotice: () => {} });
  appSql = postgres(db.appUrl, { onnotice: () => {} });

  const rows = await adminSql<{ slug: string; company_id: string; user_id: string }[]>`
    select c.slug, c.id as company_id, u.id as user_id
      from companies c
      join memberships m on m.company_id = c.id
      join users u on u.id = m.user_id
     where u.email in ('sneha@magicmoments.test', 'rahul@narayanahealth.test')
  `;
  const a = rows.find((r) => r.slug === 'magic-moments')!;
  const b = rows.find((r) => r.slug === 'narayana-health')!;
  mm = { companyId: a.company_id, userId: a.user_id, role: 'owner' };
  nh = { companyId: b.company_id, userId: b.user_id, role: 'owner' };

  await upload(mm, 'voice.txt', MM_TEXT);
  await upload(nh, 'consent-policy.txt', NH_SECRET_TEXT);
  await drainExtraction();
  await drainEmbeddings();
}, { timeout: 180_000 });

after(async () => {
  if (SKIP) return;
  await appSql?.end({ timeout: 5 });
  await adminSql?.end({ timeout: 5 });
  await db?.stop();
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});

describe('the pipeline embeds chunks', { skip: SKIP }, () => {
  it('gives every chunk a vector of the right shape', async () => {
    const rows = await adminSql<{ n: number; dims: number; model: string }[]>`
      select count(*)::int n, min(dimensions) dims, min(model) model from drive_file_embeddings
    `;
    assert.ok(rows[0]!.n > 0, 'nothing was embedded');
    assert.equal(rows[0]!.dims, 1536);
    assert.equal(rows[0]!.model, embedding.embedder().model);

    const gap = await adminSql<{ n: number }[]>`
      select count(*)::int n
        from drive_file_chunks c
        left join drive_file_embeddings e on e.chunk_id = c.id
       where e.id is null
    `;
    assert.equal(gap[0]!.n, 0, 'some chunks were left without a vector');
  });

  it('claims nothing once everything is embedded', async () => {
    assert.equal(await queue.claimChunksNeedingEmbedding(), null);
  });

  it('re-running embeds nothing new', async () => {
    const before = await adminSql<{ n: number }[]>`select count(*)::int n from drive_file_embeddings`;
    assert.equal(await drainEmbeddings(), 0);
    const after = await adminSql<{ n: number }[]>`select count(*)::int n from drive_file_embeddings`;
    assert.equal(after[0]!.n, before[0]!.n);
  });

  it('claims a new chunk as soon as one appears', async () => {
    const file = await upload(mm, 'new-brief.txt', 'A brand new brief about summer cocktails.');
    await drainExtraction();

    const claim = await queue.claimChunksNeedingEmbedding();
    assert.ok(claim, 'a freshly extracted chunk should be claimable');
    assert.equal(claim.companyId, mm.companyId, 'a batch must belong to one company');
    await queue.embedClaimedChunks(claim);

    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from drive_file_embeddings where file_id = ${file.id}
    `;
    assert.ok(rows[0]!.n > 0);
  });

  it('a second model coexists with the first rather than colliding', async () => {
    const [chunk] = await adminSql<{ id: string; company_id: string; file_id: string }[]>`
      select id, company_id, file_id from drive_file_chunks limit 1
    `;
    await adminSql`
      insert into drive_file_embeddings (company_id, chunk_id, file_id, model, dimensions, embedding, input_chars)
      values (${chunk!.company_id}, ${chunk!.id}, ${chunk!.file_id}, 'some-future-model', 1536,
              ${'[' + Array(1536).fill('0.001').join(',') + ']'}::vector, 10)
    `;
    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n from drive_file_embeddings where chunk_id = ${chunk!.id}
    `;
    assert.equal(rows[0]!.n, 2, 'two models should be able to hold vectors for one chunk');
    await adminSql`delete from drive_file_embeddings where model = 'some-future-model'`;
  });
});

describe('failures are classified, not counted uniformly', { skip: SKIP }, () => {
  const failing = (kind: 'rate_limited' | 'transient' | 'permanent') => ({
    name: 'fake' as const,
    model: embedding.embedder().model,
    dimensions: 1536,
      minRelevanceScore: 0.25,
    embed: async () => {
      throw new embedding.EmbeddingFailed(kind, `simulated ${kind}`, kind === 'rate_limited' ? 5 : null);
    },
  });

  const freshChunk = async (label: string) => {
    const file = await upload(mm, `${label}.txt`, `A document about ${label} written for the retry tests.`);
    await drainExtraction();
    const rows = await adminSql<{ id: string }[]>`
      select id from drive_file_chunks where file_id = ${file.id} order by ordinal limit 1
    `;
    return rows[0]!.id;
  };

  const stateOf = async (id: string) =>
    (
      await adminSql<{ embedding_attempts: number; embedding_error: string | null; next_embedding_attempt_at: Date | null }[]>`
        select embedding_attempts, embedding_error, next_embedding_attempt_at
          from drive_file_chunks where id = ${id}
      `
    )[0]!;

  after(() => embedding.__setEmbedder(null));

  it('rate limiting backs off without spending an attempt', async () => {
    const id = await freshChunk('ratelimit');
    embedding.__setEmbedder(failing('rate_limited'));

    const claim = await queue.claimChunksNeedingEmbedding();
    assert.ok(claim);
    const outcome = await queue.embedClaimedChunks(claim);
    assert.equal(outcome.status, 'failed');

    const state = await stateOf(id);
    assert.equal(state.embedding_attempts, 0, 'rate limiting must not consume a try');
    assert.ok(state.next_embedding_attempt_at, 'it should still back off');
    assert.ok(state.embedding_error);

    embedding.__setEmbedder(null);
    await adminSql`update drive_file_chunks set next_embedding_attempt_at = null`;
    await drainEmbeddings();
  });

  it('a transient failure spends an attempt and backs off', async () => {
    const id = await freshChunk('transient');
    embedding.__setEmbedder(failing('transient'));

    const claim = await queue.claimChunksNeedingEmbedding();
    await queue.embedClaimedChunks(claim!);

    const state = await stateOf(id);
    assert.equal(state.embedding_attempts, 1);
    assert.ok(state.next_embedding_attempt_at);

    embedding.__setEmbedder(null);
    await adminSql`update drive_file_chunks set embedding_attempts = 0, next_embedding_attempt_at = null`;
    await drainEmbeddings();
  });

  it('a permanent failure stops retrying immediately', async () => {
    const id = await freshChunk('permanent');
    embedding.__setEmbedder(failing('permanent'));

    const claim = await queue.claimChunksNeedingEmbedding();
    const outcome = await queue.embedClaimedChunks(claim!);
    assert.equal(outcome.status === 'failed' && outcome.willRetry, false);

    const state = await stateOf(id);
    assert.equal(state.embedding_attempts, 3, 'a refused input should not be tried again');

    embedding.__setEmbedder(null);
    assert.equal(await queue.claimChunksNeedingEmbedding(), null, 'an exhausted chunk must not be claimed');

    await adminSql`update drive_file_chunks set embedding_attempts = 0, embedding_error = null`;
    await drainEmbeddings();
  });
});

describe('idempotency', { skip: SKIP }, () => {
  it('reprocessing a file leaves exactly one vector per chunk', async () => {
    const file = await upload(mm, 'reprocess-me.txt', 'Guidance about tone that will be read twice.');
    await drainExtraction();
    await drainEmbeddings();

    const before = await adminSql<{ chunks: number; vectors: number }[]>`
      select (select count(*)::int from drive_file_chunks where file_id = ${file.id})     as chunks,
             (select count(*)::int from drive_file_embeddings where file_id = ${file.id}) as vectors
    `;
    assert.equal(before[0]!.vectors, before[0]!.chunks);

    await processing.requestReprocess(mm, file.id);
    await drainExtraction();
    await drainEmbeddings();

    const after = await adminSql<{ chunks: number; vectors: number }[]>`
      select (select count(*)::int from drive_file_chunks where file_id = ${file.id})     as chunks,
             (select count(*)::int from drive_file_embeddings where file_id = ${file.id}) as vectors
    `;
    assert.equal(after[0]!.vectors, after[0]!.chunks, 'stale or duplicate vectors survived');
  });

  it('deleting a file removes its vectors', async () => {
    const file = await upload(mm, 'temporary.txt', 'This document will be deleted shortly.');
    await drainExtraction();
    await drainEmbeddings();
    assert.ok(
      (await adminSql<{ n: number }[]>`select count(*)::int n from drive_file_embeddings where file_id = ${file.id}`)[0]!.n > 0,
    );

    await drive.deleteFileForever(mm, file.id);

    const left = await adminSql<{ n: number }[]>`
      select count(*)::int n from drive_file_embeddings where file_id = ${file.id}
    `;
    assert.equal(left[0]!.n, 0, 'vectors outlived the file they described');
  });
});

describe('search finds by meaning', { skip: SKIP }, () => {
  it('ranks the passage that shares the most language first', async () => {
    const results = await search.semanticSearch(mm, { query: 'occasion never the alcohol', limit: 5 });
    assert.ok(results.hits.length > 0, 'expected a match');
    assert.match(results.hits[0]!.snippet, /occasion/i);
    assert.ok(results.hits[0]!.score >= results.hits[results.hits.length - 1]!.score, 'scores must descend');
  });

  it('carries provenance and nothing internal', async () => {
    const results = await search.semanticSearch(mm, { query: 'carousels instagram festival', limit: 3 });
    const hit = results.hits[0]!;
    for (const field of ['chunkId', 'fileId', 'fileName', 'fileType', 'ordinal', 'charStart', 'charEnd', 'snippet', 'score']) {
      assert.ok(Object.prototype.hasOwnProperty.call(hit, field), `missing ${field}`);
    }
    const payload = JSON.stringify(results);
    for (const forbidden of ['storage_path', 'storagePath', 'company_id', 'companyId', 'embedding', 'checksum']) {
      assert.ok(!payload.includes(forbidden), `search results leaked ${forbidden}`);
    }
  });

  it('honours the limit and the file-type filter', async () => {
    const one = await search.semanticSearch(mm, { query: 'brand', limit: 1 });
    assert.ok(one.hits.length <= 1);

    const pdfs = await search.semanticSearch(mm, { query: 'brand', fileTypes: ['pdf'] });
    assert.equal(pdfs.hits.length, 0, 'there are no PDFs in this company');

    const texts = await search.semanticSearch(mm, { query: 'occasion', fileTypes: ['txt'] });
    assert.ok(texts.hits.length > 0);
  });

  it('restricts to a folder and its descendants', async () => {
    const folder = await drive.createFolder(mm, null, 'Scoped Search');
    await drive.uploadFile(mm, {
      folderId: folder.id, filename: 'inside.txt', mimeType: 'text/plain',
      body: Buffer.from('A distinctive phrase about kangaroos living inside this folder.'),
    });
    await drainExtraction();
    await drainEmbeddings();

    const inside = await search.semanticSearch(mm, { query: 'kangaroos', folderId: folder.id });
    assert.ok(inside.hits.length > 0, 'the folder filter excluded its own file');
    assert.ok(inside.hits.every((h) => h.folderId === folder.id));

    const everywhere = await search.semanticSearch(mm, { query: 'kangaroos' });
    assert.ok(everywhere.hits.length >= inside.hits.length);
  });

  it('refuses a query that is too short or too long', async () => {
    await assert.rejects(() => search.semanticSearch(mm, { query: 'a' }), /at least two characters/i);
    await assert.rejects(() => search.semanticSearch(mm, { query: 'x'.repeat(1001) }), /too long/i);
  });
});

describe('one company cannot reach another by meaning', { skip: SKIP }, () => {
  it('THE TEST: company A searching wording that exists only in company B returns nothing', async () => {
    // Verbatim from Narayana Health's document. With a bag-of-words embedder
    // this query vector sits almost exactly on top of their chunk, so if the
    // boundary leaked at all, this is the search that would prove it.
    const stolen = 'Patient consent must be signed before any real patient appears in a film.';

    const asMagicMoments = await search.semanticSearch(mm, { query: stolen, limit: 20 });

    assert.equal(asMagicMoments.hits.length, 0, 'Magic Moments reached Narayana Health content');

    // and the same query does find it for the company that owns it, so the
    // test is proving isolation rather than a broken search.
    const asNarayana = await search.semanticSearch(nh, { query: stolen, limit: 20 });
    assert.ok(asNarayana.hits.length > 0, 'the owning company should find its own document');
    assert.match(asNarayana.hits[0]!.snippet, /consent/i);

    // Zero results would also happen if search were broken outright, and the
    // floor that produces the zero is a product decision that could be tuned.
    // So assert the boundary itself, independently of any threshold: none of
    // the rows Narayana can reach may be reachable by Magic Moments at any
    // score. Raising the limit and dropping the floor entirely still must not
    // surface another company's chunk.
    const nhChunkIds = new Set(asNarayana.hits.map((h) => h.chunkId));
    const unfiltered = await search.semanticSearch(mm, { query: stolen, limit: 50 }, { minScore: 0 });
    assert.ok(unfiltered.hits.length > 0, 'the unfiltered control found nothing, so it proves nothing');
    for (const hit of unfiltered.hits) {
      assert.ok(!nhChunkIds.has(hit.chunkId), `chunk ${hit.chunkId} crossed the company boundary`);
    }
  });

  it('a second phrase unique to company B is also unreachable', async () => {
    const stolen = 'Cardiac rehabilitation programmes run for twelve weeks at the Bangalore unit.';
    assert.equal((await search.semanticSearch(mm, { query: stolen, limit: 20 })).hits.length, 0);
    assert.ok((await search.semanticSearch(nh, { query: stolen, limit: 20 })).hits.length > 0);
  });

  it('with no company scope, nothing is visible at all', async () => {
    const rows = await appSql`select id from drive_file_embeddings limit 10`;
    assert.equal(rows.length, 0, 'policies must fail closed with no company set');
  });

  it('an unfiltered similarity query under one scope returns only that company', async () => {
    const probe = '[' + Array(1536).fill('0.02').join(',') + ']';
    const rows = (await appSql.begin(async (tx) => {
      await tx`select set_config('cip.company_id', ${mm.companyId}, true)`;
      await tx`set local hnsw.iterative_scan = 'relaxed_order'`;
      // deliberately no WHERE clause — this is what a future bug looks like
      return tx<{ company_id: string }[]>`
        select company_id from drive_file_embeddings order by embedding <=> ${probe}::vector limit 50
      `;
    })) as { company_id: string }[];

    assert.ok(rows.length > 0, 'expected Magic Moments to have vectors');
    assert.ok(rows.every((r) => r.company_id === mm.companyId), 'an unfiltered query leaked another company');
  });

  it('a cross-company folderId is not found rather than empty', async () => {
    const folder = await drive.createFolder(nh, null, 'Narayana Only');
    await assert.rejects(
      () => search.semanticSearch(mm, { query: 'anything at all', folderId: folder.id }),
      /could not be found/i,
    );
  });

  it('a cross-company fileId cannot be reached through the extraction API', async () => {
    const rows = await adminSql<{ id: string }[]>`
      select f.id from drive_files f where f.company_id = ${nh.companyId} limit 1
    `;
    await assert.rejects(() => processing.getExtraction(mm, rows[0]!.id), /could not be found/i);
  });

  it('row-level security refuses a vector written for another company', async () => {
    const [chunk] = await adminSql<{ id: string; file_id: string }[]>`
      select id, file_id from drive_file_chunks where company_id = ${nh.companyId} limit 1
    `;
    await assert.rejects(
      () => appSql.begin(async (tx) => {
        await tx`select set_config('cip.company_id', ${mm.companyId}, true)`;
        return tx`
          insert into drive_file_embeddings (company_id, chunk_id, file_id, model, dimensions, embedding, input_chars)
          values (${nh.companyId}, ${chunk!.id}, ${chunk!.file_id}, 'planted', 1536,
                  ${'[' + Array(1536).fill('0.5').join(',') + ']'}::vector, 5)
        `;
      }),
      /row-level security/i,
    );
  });

  it('the composite key refuses a vector whose chunk belongs elsewhere', async () => {
    const [nhChunk] = await adminSql<{ id: string }[]>`
      select id from drive_file_chunks where company_id = ${nh.companyId} limit 1
    `;
    const [mmFile] = await adminSql<{ id: string }[]>`
      select id from drive_files where company_id = ${mm.companyId} limit 1
    `;
    // Even with row-level security bypassed entirely, referential integrity holds.
    await assert.rejects(
      () => adminSql`
        insert into drive_file_embeddings (company_id, chunk_id, file_id, model, dimensions, embedding, input_chars)
        values (${mm.companyId}, ${nhChunk!.id}, ${mmFile!.id}, 'crossed', 1536,
                ${'[' + Array(1536).fill('0.5').join(',') + ']'}::vector, 5)
      `,
      /foreign key|violates/i,
    );
  });

  it('every stored vector sits in the same company as its chunk and its file', async () => {
    const rows = await adminSql<{ n: number }[]>`
      select count(*)::int n
        from drive_file_embeddings e
        join drive_file_chunks k on k.id = e.chunk_id
        join drive_files f       on f.id = e.file_id
       where e.company_id <> k.company_id or e.company_id <> f.company_id
    `;
    assert.equal(rows[0]!.n, 0, 'a vector is filed under the wrong company');
  });
});

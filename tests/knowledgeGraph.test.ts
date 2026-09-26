import { after, before, beforeEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * The knowledge graph — real nodes, real edges, and the company boundary.
 *
 * Everything the graph draws is derived from rows the company already has, so
 * these tests build actual documents, run the real extraction pipeline, and
 * assert on what comes back. There is no fixture graph and no sample data: if
 * the builder ever started inventing nodes, the counts here would move.
 */

let db: TestDb;
let appSql: postgres.Sql;
let adminSql: postgres.Sql;
let storageDir: string;

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

let graph: typeof import('../src/server/knowledge/graph');
let drive: typeof import('../src/server/drive/service');
let processing: typeof import('../src/server/drive/processing');

const PASSWORD = 'cip-demo-password';

/** Runs the Phase 3 worker, exactly as the real one does. */
async function extractAll(): Promise<void> {
  for (;;) {
    const file = await processing.claimNextFile();
    if (!file) break;
    await processing.processClaimedFile(file);
  }
}

const upload = (scope: Scope, folderId: string | null, filename: string, body: string) =>
  drive.uploadFile(scope, { folderId, filename, mimeType: 'text/plain', body: Buffer.from(body) });

before(async () => {
  db = await startTestDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'cip-graph-'));

  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = PASSWORD;
  process.env.CIP_STORAGE_DIR = storageDir;
  process.env.CIP_FORCE_LOCAL_STORAGE = 'true';

  const { migrate } = await import('../src/server/migrate');
  await migrate(() => {}, { skip: db.skipMigrations });
  const { seed } = await import('../src/server/seed');
  await seed(() => {});

  process.env.DATABASE_URL = db.appUrl;
  graph = await import('../src/server/knowledge/graph');
  drive = await import('../src/server/drive/service');
  processing = await import('../src/server/drive/processing');

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
}, { timeout: 180_000 });

beforeEach(async () => {
  // Each case builds the knowledge it needs, so nothing inherits another's.
  await adminSql`delete from drive_files`;
  await adminSql`delete from drive_folders`;
  // The portfolio too, or one case's roster becomes another's graph.
  await adminSql`delete from brand_relations`;
  await adminSql`delete from brand_traits`;
  await adminSql`delete from brand_dna_evidence`;
  await adminSql`delete from brand_dna_facts`;
  await adminSql`delete from company_brands`;
});

after(async () => {
  await appSql?.end({ timeout: 5 });
  await adminSql?.end({ timeout: 5 });
  await db?.stop();
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});

describe('the graph is built from real rows', () => {
  it('a company with nothing gets an empty graph, not a demo one', async () => {
    const result = await graph.knowledgeGraph(nh, { view: 'files' });
    assert.equal(result.empty, true);
    assert.equal(result.nodes.length, 0);
    assert.equal(result.edges.length, 0);
    assert.deepEqual(result.stats, {
      nodes: 0, edges: 0, files: 0, folders: 0, chunks: 0, sources: 0,
    });
  });

  it('folders and files become nodes, joined by contains edges', async () => {
    const folder = await drive.createFolder(mm, null, 'Campaigns');
    const file = await upload(mm, folder.id, 'diwali.txt', 'A brief about lanterns and warmth.');

    const result = await graph.knowledgeGraph(mm, { view: 'files' });
    assert.equal(result.empty, false);

    const folderNode = result.nodes.find((n) => n.id === folder.id);
    const fileNode = result.nodes.find((n) => n.id === file.id);
    assert.equal(folderNode?.type, 'folder');
    assert.equal(folderNode?.label, 'Campaigns');
    assert.equal(fileNode?.type, 'file');
    assert.equal(fileNode?.source, 'cip_drive');

    assert.ok(
      result.edges.some((e) => e.source === folder.id && e.target === file.id && e.kind === 'contains'),
      'the file is not attached to its folder',
    );
  });

  it('never returns an edge to a node it did not return', async () => {
    const folder = await drive.createFolder(mm, null, 'Plenty');
    for (let i = 0; i < 6; i += 1) {
      await upload(mm, folder.id, `file-${i}.txt`, `Something to read, number ${i}.`);
    }

    // Under a limit, which is the ordinary case on a company with plenty in
    // it: nodes come back under the limit and edges come back under their own.
    const result = await graph.knowledgeGraph(mm, { view: 'files', limit: 4 });

    const present = new Set(result.nodes.map((n) => n.id));
    const dangling = result.edges.filter((e) => !present.has(e.source) || !present.has(e.target));

    // The renderer invents a missing end as a bare `{ id }` — no label, no
    // type — and the first draw that reads its label throws, taking the page
    // down with "Cannot read properties of undefined".
    assert.deepEqual(
      dangling.map((e) => `${e.kind}: ${e.source} -> ${e.target}`),
      [],
      'an edge points at a node that was not returned',
    );
  });

  it('a CIP Drive source node appears, and Google Drive only once something is synced', async () => {
    await upload(mm, null, 'uploaded.txt', 'An ordinary upload.');

    let result = await graph.knowledgeGraph(mm, { view: 'files' });
    assert.ok(result.nodes.some((n) => n.id === 'source:cip_drive'));
    assert.ok(
      !result.nodes.some((n) => n.id === 'source:google_drive'),
      'a Google Drive node appeared before anything was synced',
    );

    // Mark a file as synced, exactly as the Google Drive sync would.
    const synced = await upload(mm, null, 'from-google.txt', 'A synced document.');
    await adminSql`update drive_files set source_type = 'google_drive' where id = ${synced.id}`;

    result = await graph.knowledgeGraph(mm, { view: 'files' });
    const googleNode = result.nodes.find((n) => n.id === 'source:google_drive');
    assert.ok(googleNode, 'a synced file produced no Google Drive source node');
    assert.equal(result.nodes.find((n) => n.id === synced.id)?.source, 'google_drive');
    assert.ok(
      result.edges.some((e) => e.source === 'source:google_drive' && e.target === synced.id),
      'the synced file is not attached to its source',
    );
  });

  it('statistics are counted, never stored', async () => {
    const folder = await drive.createFolder(mm, null, 'Counted');
    await upload(mm, folder.id, 'one.txt', 'First document about lanterns.');
    await upload(mm, folder.id, 'two.txt', 'Second document about lanterns.');
    await extractAll();

    const result = await graph.knowledgeGraph(mm, { view: 'files' });
    assert.equal(result.stats.files, 2);
    assert.equal(result.stats.folders, 1);
    assert.equal(result.stats.nodes, result.nodes.length);
    assert.equal(result.stats.edges, result.edges.length);
    assert.ok(result.stats.chunks > 0, 'chunks were extracted but not counted');
  });
});

describe('expansion is lazy', () => {
  it('the default view has no chunks in it', async () => {
    const file = await upload(mm, null, 'long.txt', 'A passage about lanterns and warmth.');
    await extractAll();

    const result = await graph.knowledgeGraph(mm, { view: 'files' });
    assert.ok(!result.nodes.some((n) => n.type === 'chunk'), 'chunks were sent before being asked for');
    // But the file knows there is more inside it.
    assert.equal(result.nodes.find((n) => n.id === file.id)?.expandable, true);
  });

  it('expanding a file returns its chunks, attached to it', async () => {
    const file = await upload(mm, null, 'expandable.txt', 'A passage about lanterns and warmth.');
    await extractAll();

    const expanded = await graph.knowledgeGraph(mm, { nodeId: file.id });
    const chunks = expanded.nodes.filter((n) => n.type === 'chunk');
    assert.ok(chunks.length > 0, 'expanding a file produced no passages');

    for (const chunk of chunks) {
      assert.ok(
        expanded.edges.some((e) => e.source === file.id && e.target === chunk.id && e.kind === 'contains'),
        'a passage is not attached to its file',
      );
      assert.equal(chunk.fileId, file.id);
      assert.ok(chunk.snippet && chunk.snippet.length > 0, 'a passage carries no text to show');
    }
  });

  it('expanding a folder returns what is directly inside it', async () => {
    const parent = await drive.createFolder(mm, null, 'Parent');
    const child = await drive.createFolder(mm, parent.id, 'Child');
    const file = await upload(mm, parent.id, 'inside.txt', 'Inside the parent.');
    await upload(mm, child.id, 'deeper.txt', 'Inside the child.');

    const expanded = await graph.knowledgeGraph(mm, { nodeId: parent.id });
    const ids = expanded.nodes.map((n) => n.id);
    assert.ok(ids.includes(child.id), 'the child folder is missing');
    assert.ok(ids.includes(file.id), 'the file is missing');
    // Only one level: the grandchild file belongs to the child's expansion.
    assert.equal(expanded.nodes.filter((n) => n.type === 'file').length, 1);
  });

  it('expanding a source returns the files that came from it', async () => {
    await upload(mm, null, 'a.txt', 'One.');
    await upload(mm, null, 'b.txt', 'Two.');

    const expanded = await graph.knowledgeGraph(mm, { nodeId: 'source:cip_drive' });
    assert.equal(expanded.nodes.filter((n) => n.type === 'file').length, 2);
    assert.ok(expanded.edges.every((e) => e.source === 'source:cip_drive'));
  });

  it('an id that is not a node yields nothing rather than an error', async () => {
    const result = await graph.knowledgeGraph(mm, { nodeId: 'not-a-uuid' });
    assert.equal(result.nodes.length, 0);
  });
});

describe('related edges come from vector similarity', () => {
  // The embedding tables only exist where migration 0007 could run.
  const NEEDS_VECTORS = 'needs pgvector — run against a database that has it';

  it('two passages about the same thing are linked, unrelated ones are not', async (t: TestContext) => {
    // Only meaningful where Phase 4's tables exist. Skipped loudly with a
    // reason rather than passing quietly on a database that cannot store a
    // vector.
    if (db.skipMigrations.includes('0007_embeddings.sql')) {
      t.skip(NEEDS_VECTORS);
      return;
    }

    const lanterns = await upload(mm, null, 'lanterns.txt', 'Paper lanterns drifting over still water at dusk.');
    const alsoLanterns = await upload(mm, null, 'more-lanterns.txt', 'Lanterns drifting above the water at dusk.');
    const unrelated = await upload(mm, null, 'invoices.txt', 'Quarterly invoice reconciliation and tax codes.');
    await extractAll();

    const { embedder } = await import('../src/server/drive/embedding');
    const { claimChunksNeedingEmbedding, embedClaimedChunks } = await import(
      '../src/server/drive/embeddingQueue'
    );
    for (;;) {
      const claim = await claimChunksNeedingEmbedding();
      if (!claim) break;
      await embedClaimedChunks(claim);
    }
    assert.ok(embedder().model.length > 0);

    const expanded = await graph.knowledgeGraph(mm, { nodeId: lanterns.id });
    const related = expanded.edges.filter((e) => e.kind === 'related');
    assert.ok(related.length > 0, 'no related edges were produced');

    // Every related edge clears the similarity floor and is not a self-link.
    for (const edge of related) {
      assert.notEqual(edge.source, edge.target, 'a passage was linked to itself');
      assert.ok((edge.score ?? 0) >= graph.GRAPH_LIMITS.minSimilarity, `weak edge: ${edge.score}`);
    }

    // No duplicate edges: A-B and B-A are one relationship.
    const pairs = related.map((e) => [e.source, e.target].sort().join('|'));
    assert.equal(new Set(pairs).size, pairs.length, 'the same relationship was drawn twice');

    // The near-identical document is reachable; the invoice one is not.
    const reached = new Set(expanded.nodes.map((n) => n.fileId).filter(Boolean));
    assert.ok(reached.has(alsoLanterns.id), 'the similar document was not related');
    assert.ok(!reached.has(unrelated.id), 'an unrelated document was linked');
  });
});

describe('search finds real knowledge', () => {
  it('matches a file by name and a passage by its text', async () => {
    const file = await upload(mm, null, 'brand-voice.txt', 'We talk about diabetes care with plain words.');
    await extractAll();

    const byName = await graph.knowledgeGraph(mm, { view: 'files', search: 'brand-voice' });
    assert.ok(byName.matches.includes(file.id), 'a file was not matched by its name');

    // The word appears only inside the document, never in its name.
    const byText = await graph.knowledgeGraph(mm, { view: 'files', search: 'diabetes' });
    assert.ok(byText.matches.length > 0, 'nothing matched text inside a document');
    assert.ok(byText.matches.includes(file.id), 'the matching passage did not point at its file');
  });

  it('a search that matches nothing returns no matches rather than everything', async () => {
    await upload(mm, null, 'something.txt', 'Ordinary content.');
    const result = await graph.knowledgeGraph(mm, { view: 'files', search: 'zzzznothingmatchesthis' });
    assert.deepEqual(result.matches, []);
  });

  it('search cannot reach another company', async () => {
    await upload(nh, null, 'consent-policy.txt', 'Patient consent must be signed before filming.');
    await extractAll();

    const asMagicMoments = await graph.knowledgeGraph(mm, { view: 'files', search: 'consent' });
    assert.deepEqual(asMagicMoments.matches, [], 'a search crossed the company boundary');

    // and the owning company does find it, so this proves isolation
    const asNarayana = await graph.knowledgeGraph(nh, { view: 'files', search: 'consent' });
    assert.ok(asNarayana.matches.length > 0);
  });
});

describe('two graphs, drawn one at a time', () => {
  /** A roster with something in common, so the portfolio has anything in it. */
  async function portfolio(): Promise<void> {
    // Four brands, three of them whisky. A word every brand has groups them
    // all, which is the same as grouping none, so a fixture where everything
    // is whisky produces no whisky hub - correctly.
    for (const [position, name] of ['Rampur', 'Sangam', '8PM', 'Jaisalmer'].entries()) {
      await adminSql`
        insert into company_brands (company_id, name, position)
        values (${mm.companyId}, ${name}, ${position})
        on conflict do nothing
      `;
    }
    for (const [brand, value] of [
      ['Rampur', 'single malt whisky'],
      ['Sangam', 'world malt whisky'],
      ['8PM', 'indian whisky'],
      ['Jaisalmer', 'indian craft gin'],
    ] as const) {
      await adminSql`
        insert into brand_dna_facts
          (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
        values (${mm.companyId}, 'visual', 'label text', ${value}, ${brand}, 'observed', 0.6, 1)
        on conflict do nothing
      `;
    }
    const { recomputeRelations } = await import('../src/server/brain/relations');
    await recomputeRelations(mm);
  }

  // A brand is drawn with its logo, or a clean photograph of its bottle -
  // never a poster, which at the size of a node is a smear of colour. Three
  // brands were drawn with posters when "product" alone was the test, because
  // a static ad with a bottle in it is read as a product shot too.
  it('draws each brand with its logo or its bottle, never a poster', async () => {
    await portfolio();

    async function picture(brand: string, filename: string, contentType: string, background: string) {
      const file = await drive.uploadFile(mm, {
        folderId: null, filename, mimeType: 'image/png', body: Buffer.from(filename),
      });
      await adminSql`update drive_files set brand = ${brand} where id = ${file.id}`;
      await adminSql`
        insert into asset_understanding
          (company_id, file_id, kind, provider, model, content_hash, status, summary, structured)
        values (${mm.companyId}, ${file.id}, 'image', 'fake', 'fake-brain-1', ${'hash-' + filename},
                'ready', ${filename}, ${adminSql.json({ contentType, background })})
      `;
      return file.id;
    }

    await picture('Rampur', 'Rampur beach poster.png', 'advertising poster', 'blurred beach at sunset');
    const rampurLogo = await picture('Rampur', 'Rampur mark.png', 'logo', 'transparent');
    await picture('8PM', '8PM static.png', 'static ad / product shot', 'plain white');
    const bottle = await picture('8PM', '8PM bottle.png', 'product shot', 'plain white / cut-out');
    // Read as a "graphic", but called a logo by whoever saved it.
    const named = await picture('Jaisalmer', 'Jaisalmer logo.png', 'graphic', 'white');
    await picture('Sangam', 'Sangam lounge.png', 'static lifestyle product photograph', 'warm bar interior');

    const built = await graph.knowledgeGraph(mm);
    const imageOf = (name: string) => built.nodes.find((n) => n.type === 'brand' && n.label === name)?.imageFileId;

    assert.equal(imageOf('Rampur'), rampurLogo, 'a logo beats a poster');
    assert.equal(imageOf('8PM'), bottle, 'a clean bottle, not an ad with a bottle in it');
    assert.equal(imageOf('Jaisalmer'), named, 'a file called a logo is a logo');
    assert.equal(imageOf('Sangam'), undefined, 'a brand with only posters is drawn with its initials');
  });

  // The inspector lists a brand's latest files from the graph itself, without
  // a second request - so the graph carries them, a handful and no more.
  it("carries each brand's file count and its latest few files", async () => {
    await portfolio();
    for (let i = 1; i <= 6; i += 1) {
      const file = await upload(mm, null, `Rampur note ${i}.txt`, `Rampur note number ${i}.`);
      await adminSql`
        update drive_files set brand = 'Rampur', created_at = now() + ${`${i} seconds`}::interval
         where id = ${file.id}
      `;
    }

    const built = await graph.knowledgeGraph(mm);
    const rampur = built.nodes.find((n) => n.type === 'brand' && n.label === 'Rampur');
    assert.equal(rampur?.fileCount, 6);
    assert.equal(rampur?.files?.length, 4, 'a handful, not every file');
    assert.equal(rampur?.files?.[0]?.name, 'Rampur note 6.txt', 'newest first');
    assert.ok(rampur?.files?.every((f) => f.bytes > 0 && f.fileType === 'txt'));

    const sangam = built.nodes.find((n) => n.type === 'brand' && n.label === 'Sangam');
    assert.equal(sangam?.fileCount, 0);
    assert.deepEqual(sangam?.files, []);
  });

  it('opens on the portfolio, not on every file at once', async () => {
    await portfolio();
    const result = await graph.knowledgeGraph(mm);

    // Drawing both graphs together came to nearly two hundred nodes and three
    // hundred and fifty edges on a real company. Correct, and unreadable.
    const types = new Set(result.nodes.map((n) => n.type));
    assert.ok(types.has('brand'), 'the portfolio view has no brands in it');
    assert.ok(!types.has('file'), 'the default view is drawing the file tree as well');
    assert.ok(!types.has('folder'), 'the default view is drawing folders as well');
  });

  it('draws the file tree when that is what was asked for', async () => {
    await upload(mm, null, 'brand-book.txt', 'How the house writes.');
    const result = await graph.knowledgeGraph(mm, { view: 'files' });
    const types = new Set(result.nodes.map((n) => n.type));

    assert.ok(types.has('file'));
    assert.ok(!types.has('brand'), 'the file tree is drawing the portfolio as well');
    assert.ok(!types.has('trait'));
  });

  it('draws both when somebody genuinely wants both', async () => {
    await portfolio();
    await upload(mm, null, 'brand-book.txt', 'How the house writes.');
    const result = await graph.knowledgeGraph(mm, { view: 'all' });
    const types = new Set(result.nodes.map((n) => n.type));

    assert.ok(types.has('file'));
    assert.ok(types.has('brand'));
  });

  it('leaves no edge pointing at something it did not draw', async () => {
    await portfolio();
    await upload(mm, null, 'rampur-bottle.txt', 'A bottle.');
    // A brand owns files, and in the portfolio those files are not on the
    // canvas. An edge to a node that does not exist is how a force layout
    // quietly throws everything into a corner.
    for (const view of ['brands', 'files', 'all'] as const) {
      const result = await graph.knowledgeGraph(mm, { view });
      const drawn = new Set(result.nodes.map((n) => n.id));
      for (const edge of result.edges) {
        assert.ok(drawn.has(edge.source), `${view}: an edge starts at a node that is not drawn`);
        assert.ok(drawn.has(edge.target), `${view}: an edge ends at a node that is not drawn`);
      }
    }
  });

  it('groups the brands under headings it can name', async () => {
    await portfolio();
    const result = await graph.knowledgeGraph(mm);

    const whisky = result.nodes.find((n) => n.type === 'trait' && n.label === 'whisky');
    assert.ok(whisky, 'three whiskies and no whisky to hang them from');
    assert.equal(whisky.dimension, 'category');
    assert.equal(whisky.brandCount, 3);
  });
});

describe('filters', () => {
  it('a source filter keeps only files from that source', async () => {
    const uploaded = await upload(mm, null, 'cip.txt', 'From CIP Drive.');
    const synced = await upload(mm, null, 'google.txt', 'From Google Drive.');
    await adminSql`update drive_files set source_type = 'google_drive' where id = ${synced.id}`;

    const onlyGoogle = await graph.knowledgeGraph(mm, { view: 'files', source: 'google_drive' });
    const fileIds = onlyGoogle.nodes.filter((n) => n.type === 'file').map((n) => n.id);
    assert.deepEqual(fileIds, [synced.id]);
    assert.ok(!fileIds.includes(uploaded.id));
  });

  it('a type filter keeps that type, and drops edges left dangling', async () => {
    const folder = await drive.createFolder(mm, null, 'Filtered');
    await upload(mm, folder.id, 'file.txt', 'Content.');

    const onlyFolders = await graph.knowledgeGraph(mm, { view: 'files', type: 'folder' });
    assert.ok(onlyFolders.nodes.every((n) => n.type === 'folder' || n.type === 'source'));

    const ids = new Set(onlyFolders.nodes.map((n) => n.id));
    for (const edge of onlyFolders.edges) {
      assert.ok(ids.has(edge.source) && ids.has(edge.target), 'an edge points at a filtered-out node');
    }
  });
});

describe('bounds', () => {
  it('never returns more nodes than the cap allows', async () => {
    for (let i = 0; i < 12; i += 1) await upload(mm, null, `bulk-${i}.txt`, `Document ${i}.`);

    const limited = await graph.knowledgeGraph(mm, { view: 'files', limit: 5 });
    assert.ok(limited.nodes.filter((n) => n.type === 'file').length <= 5);
    assert.equal(limited.truncated, true, 'a truncated graph did not say so');

    // An absurd limit is clamped rather than honoured.
    const huge = await graph.knowledgeGraph(mm, { view: 'files', limit: 100_000 });
    assert.ok(huge.nodes.length <= graph.GRAPH_LIMITS.maxNodes);
  });
});

describe('one company cannot reach another', () => {
  it('THE TEST: the graph contains only the caller own knowledge', async () => {
    const theirFolder = await drive.createFolder(nh, null, 'Clinical');
    const theirFile = await upload(nh, theirFolder.id, 'consent.txt', 'Patient consent policy.');
    const ourFolder = await drive.createFolder(mm, null, 'Campaigns');
    const ourFile = await upload(mm, ourFolder.id, 'diwali.txt', 'Diwali brief.');
    await extractAll();

    const ours = await graph.knowledgeGraph(mm, { view: 'files' });
    const ourIds = new Set(ours.nodes.map((n) => n.id));
    assert.ok(ourIds.has(ourFile.id) && ourIds.has(ourFolder.id));
    assert.ok(!ourIds.has(theirFile.id), 'another company file appeared in the graph');
    assert.ok(!ourIds.has(theirFolder.id), 'another company folder appeared in the graph');

    // No edge may touch anything of theirs either.
    for (const edge of ours.edges) {
      assert.notEqual(edge.source, theirFile.id);
      assert.notEqual(edge.target, theirFile.id);
      assert.notEqual(edge.source, theirFolder.id);
      assert.notEqual(edge.target, theirFolder.id);
    }

    // And the reverse holds, so this is isolation rather than an empty graph.
    const theirs = await graph.knowledgeGraph(nh, { view: 'files' });
    const theirIds = new Set(theirs.nodes.map((n) => n.id));
    assert.ok(theirIds.has(theirFile.id));
    assert.ok(!theirIds.has(ourFile.id));
  });

  it('expanding another company node returns nothing', async () => {
    const theirFolder = await drive.createFolder(nh, null, 'Theirs');
    const theirFile = await upload(nh, theirFolder.id, 'secret.txt', 'Their content.');
    await extractAll();

    // Magic Moments knows the ids. Under its own scope they resolve to nothing.
    for (const id of [theirFolder.id, theirFile.id]) {
      const expanded = await graph.knowledgeGraph(mm, { nodeId: id });
      assert.equal(expanded.nodes.length, 0, 'expanding a foreign node returned something');
      assert.equal(expanded.edges.length, 0);
    }
  });

  it('statistics do not count another company knowledge', async () => {
    await upload(nh, null, 'theirs-1.txt', 'One.');
    await upload(nh, null, 'theirs-2.txt', 'Two.');
    await upload(mm, null, 'ours.txt', 'Ours.');

    const ours = await graph.knowledgeGraph(mm, { view: 'files' });
    assert.equal(ours.stats.files, 1, 'the count included another company files');
  });

  it('with no company set, the underlying tables are empty', async () => {
    await upload(mm, null, 'scoped.txt', 'Content.');
    const rows = await appSql`select id from drive_files limit 10`;
    assert.equal(rows.length, 0, 'policies must fail closed with no company set');
  });
});

describe('nothing sensitive reaches the browser', () => {
  it('no node or edge carries a company id, storage path or credential', async () => {
    const folder = await drive.createFolder(mm, null, 'Sensitive');
    const file = await upload(mm, folder.id, 'doc.txt', 'Some content about lanterns.');
    await extractAll();

    const overview = await graph.knowledgeGraph(mm, { view: 'files' });
    const expanded = await graph.knowledgeGraph(mm, { nodeId: file.id });

    for (const payload of [JSON.stringify(overview), JSON.stringify(expanded)]) {
      for (const forbidden of [
        mm.companyId,
        'company_id',
        'companyId',
        'storage_path',
        'storagePath',
        'companies/',
        'checksum',
        'access_token',
        'embedding',
      ]) {
        assert.ok(!payload.includes(forbidden), `the graph leaked ${forbidden}`);
      }
    }
  });

  it('a file node exposes its type and status but nothing about where it lives', async () => {
    const file = await upload(mm, null, 'shown.txt', 'Content.');
    const result = await graph.knowledgeGraph(mm, { view: 'files' });
    const node = result.nodes.find((n) => n.id === file.id)!;

    assert.equal(node.fileType, 'txt');
    assert.ok(node.processingStatus);
    // Everything a node may carry, listed on purpose: a new field that leaks
    // something has to be added here deliberately rather than by accident.
    for (const key of Object.keys(node)) {
      assert.ok(
        ['id', 'type', 'label', 'source', 'weight', 'fileType', 'processingStatus',
         'chunkCount', 'heading', 'ordinal', 'snippet', 'fileId', 'expandable'].includes(key),
        `an unexpected field reached the browser: ${key}`,
      );
    }
  });
});

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * How a company's brands relate to each other.
 *
 * A house of fifteen brands is not fifteen unrelated things, and CIP treated
 * it as though it were. What is being tested is that the relations are drawn
 * from evidence rather than from a list somebody maintains — and, just as
 * importantly, that a relation never becomes a fact, because a brand
 * borrowing its neighbour's look is the exact failure the roster prevents.
 */

let db: TestDb;
let adminSql: postgres.Sql;
let relations: typeof import('../src/server/brain/relations');

type Scope = { companyId: string; userId: string; role: 'owner' };
let mm: Scope;
let nh: Scope;

before(async () => {
  db = await startTestDatabase();
  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = 'cip-demo-password';
  process.env.CIP_FORCE_FAKE_BRAIN = 'true';

  const { migrate } = await import('../src/server/migrate');
  await migrate(() => {}, { skip: db.skipMigrations });
  const { seed } = await import('../src/server/seed');
  await seed(() => {});

  process.env.DATABASE_URL = db.appUrl;
  relations = await import('../src/server/brain/relations');

  adminSql = postgres(db.adminUrl, { onnotice: () => {} });
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
  await adminSql`delete from brand_relations`;
  await adminSql`delete from brand_traits`;
  await adminSql`delete from brand_dna_evidence`;
  await adminSql`delete from brand_dna_facts`;
  await adminSql`delete from drive_files`;
  await adminSql`delete from company_brands`;
});

after(async () => {
  await adminSql?.end({ timeout: 5 });
  await db?.stop();
});

/** Puts a brand on the roster, the way the setup scripts do. */
async function roster(scope: Scope, ...names: string[]): Promise<void> {
  for (const [position, name] of names.entries()) {
    await adminSql`
      insert into company_brands (company_id, name, position)
      values (${scope.companyId}, ${name}, ${position})
      on conflict do nothing
    `;
  }
}

/** Gives a brand a fact, the way understanding does. */
async function fact(
  scope: Scope,
  brand: string,
  attribute: string,
  value: string,
): Promise<void> {
  await adminSql`
    insert into brand_dna_facts
      (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
    values (${scope.companyId}, 'visual', ${attribute}, ${value}, ${brand}, 'observed', 0.6, 1)
    on conflict do nothing
  `;
}

describe('brands that share something are related', () => {
  it('relates two brands through what they are both described as', async () => {
    await roster(mm, 'Whytehall Honey', 'Magic Moments Remix', 'Rampur', '8PM');

    // Two flavoured brands, two that are not. Nothing anywhere says what a
    // flavour is — only that these two were described with the same one.
    await fact(mm, 'Whytehall Honey', 'flavour', 'honey');
    await fact(mm, 'Magic Moments Remix', 'flavour', 'honey');
    await fact(mm, 'Whytehall Honey', 'liquid colour', 'warm amber');
    await fact(mm, 'Magic Moments Remix', 'liquid colour', 'warm amber');
    await fact(mm, 'Rampur', 'typographic style', 'serif uppercase wordmark');
    await fact(mm, '8PM', 'typographic style', 'serif uppercase wordmark');
    await fact(mm, 'Rampur', 'emblem', 'crossed swords above the wordmark');

    const outcome = await relations.recomputeRelations(mm);
    assert.ok(outcome.relations > 0, 'nothing was related to anything');

    const honey = await relations.relationsOf(mm, 'Whytehall Honey');
    const closest = honey[0];
    assert.ok(closest, 'a brand with an obvious sibling was related to nothing');
    assert.equal(closest.other, 'Magic Moments Remix');

    // The number has to be explainable, or it is just a number.
    const shared = closest.shared.map((s) => `${s.kind}: ${s.value}`);
    assert.ok(shared.includes('flavour: honey'), `expected the flavour, got ${shared.join(', ')}`);
  });

  it('relates brands sold into the same market', async () => {
    await roster(mm, 'Afri Bull', 'Jaisalmer', 'Rampur');

    // Where the files came from, which is not in any fact and is one of the
    // dimensions that matters most.
    for (const [brand, market] of [
      ['Afri Bull', 'Nigeria'],
      ['Jaisalmer', 'Nigeria'],
      ['Rampur', 'India'],
    ] as const) {
      await adminSql`
        insert into drive_files
          (company_id, folder_id, name, original_filename, file_type, mime_type,
           file_size, checksum_sha256, storage_path, uploaded_by, source_type,
           processing_status, market, brand, metadata)
        values
          (${mm.companyId}, null, ${`${brand}.pdf`}, ${`${brand}.pdf`}, 'pdf', 'application/pdf',
           100, ${`sum-${brand}`}, ${`companies/${mm.companyId}/${brand}.pdf`},
           ${mm.userId}, 'cip_drive', 'processed', ${market}, ${brand}, '{}'::jsonb)
      `;
      // A fact each, so every brand has something to be measured against.
      await fact(mm, brand, 'bottle finish', `${brand} glass`);
    }

    await relations.recomputeRelations(mm);
    const nigerian = await relations.relationsOf(mm, 'Afri Bull');

    assert.ok(
      nigerian.some((r) => r.other === 'Jaisalmer' &&
        r.shared.some((s) => s.kind === 'market' && s.value === 'nigeria')),
      'two brands sold into the same country were not related by it',
    );
  });

  it('does not relate two brands by something every brand has', async () => {
    await roster(mm, 'A', 'B', 'C', 'D');
    for (const brand of ['A', 'B', 'C', 'D']) {
      await fact(mm, brand, 'label text', 'product of india');
    }
    // Only A and B share anything else at all.
    await fact(mm, 'A', 'flavour', 'jamun');
    await fact(mm, 'B', 'flavour', 'jamun');
    await fact(mm, 'C', 'flavour', 'plain');
    await fact(mm, 'D', 'flavour', 'chocolate');

    await relations.recomputeRelations(mm);

    const forC = await relations.relationsOf(mm, 'C');
    assert.equal(
      forC.length,
      0,
      'a trait every brand holds related brands that have nothing else in common',
    );

    const forA = await relations.relationsOf(mm, 'A');
    assert.ok(forA.some((r) => r.other === 'B'), 'a genuinely shared trait was ignored');
  });

  it('ignores a fact that belongs to no brand', async () => {
    await roster(mm, 'A', 'B');
    await adminSql`
      insert into brand_dna_facts
        (company_id, section, attribute, value, brand, kind, confidence, evidence_count)
      values (${mm.companyId}, 'content', 'legal', 'statutory warning must be legible',
              null, 'observed', 0.9, 4)
    `;
    await fact(mm, 'A', 'flavour', 'jamun');
    await fact(mm, 'B', 'flavour', 'chocolate');

    await relations.recomputeRelations(mm);

    // A house-wide fact belongs to every brand, so relating brands by it
    // would relate every brand to every other and say nothing.
    const all = await relations.relationsOf(mm);
    assert.equal(all.length, 0);
  });

  it('rebuilds rather than accumulating', async () => {
    await roster(mm, 'A', 'B');
    await fact(mm, 'A', 'flavour', 'jamun');
    await fact(mm, 'B', 'flavour', 'jamun');
    await relations.recomputeRelations(mm);
    assert.equal((await relations.relationsOf(mm)).length, 1);

    // The shared fact is retired. Its relation must go with it, or the map
    // keeps yesterday's conclusions with no way to tell them apart.
    await adminSql`delete from brand_dna_facts where company_id = ${mm.companyId} and brand = 'B'`;
    await relations.recomputeRelations(mm);

    assert.equal((await relations.relationsOf(mm)).length, 0, 'a stale relation survived');
  });

  it('says nothing about a company with one brand or none', async () => {
    await roster(mm, 'Only One');
    await fact(mm, 'Only One', 'flavour', 'jamun');

    const outcome = await relations.recomputeRelations(mm);
    assert.equal(outcome.relations, 0);
    assert.equal(outcome.traits, 0, 'a lone brand has nothing to be related to');
  });
});

describe('one company cannot see another company relations', () => {
  it('keeps each roster and its map to itself', async () => {
    await roster(mm, 'Whytehall Honey', 'Magic Moments Remix');
    await fact(mm, 'Whytehall Honey', 'flavour', 'honey');
    await fact(mm, 'Magic Moments Remix', 'flavour', 'honey');
    await relations.recomputeRelations(mm);

    const theirs = await relations.relationsOf(nh);
    assert.equal(theirs.length, 0, 'one company saw another company map');

    const mine = await relations.relationsOf(mm);
    assert.equal(mine.length, 1);
  });
});

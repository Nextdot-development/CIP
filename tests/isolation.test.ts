import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { startTestDatabase } from './harness';
import type { TestDb } from './harness';

/**
 * Proves one company cannot reach another's data.
 *
 * Two layers are checked independently:
 *   - the service layer, which only accepts a scope built from a membership
 *   - row-level security, which is exercised with deliberately unscoped SQL
 *
 * The second half matters most: those queries are what a future bug looks
 * like, and the database still has to refuse them.
 */

let db: TestDb;
let appSql: postgres.Sql;
let adminSqlConn: postgres.Sql;

let magicMoments: { companyId: string; userId: string };
let narayana: { companyId: string; userId: string };

let resolveScope: typeof import('../src/server/auth/membership')['resolveScope'];
let verifyCredentials: typeof import('../src/server/auth/credentials')['verifyCredentials'];
let getWorkspace: typeof import('../src/server/workspace/service')['getWorkspace'];

const PASSWORD = 'cip-demo-password';

before(async () => {
  db = await startTestDatabase();

  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  process.env.CIP_APP_DB_PASSWORD = db.appPassword;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.CIP_SEED_PASSWORD = PASSWORD;

  const { migrate } = await import('../src/server/migrate');
  await migrate(() => {}, { skip: db.skipMigrations });

  const { seed } = await import('../src/server/seed');
  await seed(() => {});

  // The application connects as cip_app — the role that cannot bypass RLS.
  process.env.DATABASE_URL = db.appUrl;
  ({ resolveScope } = await import('../src/server/auth/membership'));
  ({ verifyCredentials } = await import('../src/server/auth/credentials'));
  ({ getWorkspace } = await import('../src/server/workspace/service'));

  adminSqlConn = postgres(db.adminUrl, { onnotice: () => {} });
  appSql = postgres(db.appUrl, { onnotice: () => {} });

  const rows = await adminSqlConn<{ slug: string; company_id: string; user_id: string }[]>`
    select c.slug, c.id as company_id, u.id as user_id
      from companies c
      join memberships m on m.company_id = c.id
      join users u on u.id = m.user_id
     where u.email in ('sneha@magicmoments.test', 'rahul@narayanahealth.test')
  `;
  const mm = rows.find((r) => r.slug === 'magic-moments')!;
  const nh = rows.find((r) => r.slug === 'narayana-health')!;
  magicMoments = { companyId: mm.company_id, userId: mm.user_id };
  narayana = { companyId: nh.company_id, userId: nh.user_id };
}, { timeout: 180_000 });

after(async () => {
  await appSql?.end();
  await adminSqlConn?.end();
  await db?.stop();
});

describe('sign-in resolves a company from membership', () => {
  it('gives the Magic Moments user the Magic Moments company', async () => {
    const v = await verifyCredentials('sneha@magicmoments.test', PASSWORD);
    assert.ok(v, 'expected sign-in to succeed');
    assert.equal(v.companyId, magicMoments.companyId);
  });

  it('rejects a wrong password', async () => {
    assert.equal(await verifyCredentials('sneha@magicmoments.test', 'wrong-password'), null);
  });

  it('rejects an unknown email', async () => {
    assert.equal(await verifyCredentials('nobody@example.test', PASSWORD), null);
  });
});

describe('a company id from outside is never enough', () => {
  it('refuses a scope for a company the user has no membership in', async () => {
    // This is the whole attack: a valid user, a real company id, no membership.
    const scope = await resolveScope(magicMoments.userId, narayana.companyId);
    assert.equal(scope, null, 'Magic Moments user must not get a Narayana Health scope');
  });

  it('grants a scope for the company the user does belong to', async () => {
    const scope = await resolveScope(magicMoments.userId, magicMoments.companyId);
    assert.ok(scope);
    assert.equal(scope.role, 'owner');
  });

  it('refuses a scope for a company id that does not exist', async () => {
    assert.equal(
      await resolveScope(magicMoments.userId, '00000000-0000-0000-0000-000000000000'),
      null,
    );
  });
});

describe('the workspace endpoint returns one company only', () => {
  it('serves Magic Moments data to the Magic Moments user, and nothing else', async () => {
    const scope = (await resolveScope(magicMoments.userId, magicMoments.companyId))!;
    const ws = await getWorkspace({
      sessionId: 'test',
      user: { id: magicMoments.userId, email: 'sneha@magicmoments.test', fullName: 'Sneha Kapoor' },
      scope,
    });

    assert.equal(ws.company.slug, 'magic-moments');

    // Nothing that belongs to the other company may appear anywhere in the
    // payload, at any depth.
    const payload = JSON.stringify(ws);
    for (const leak of [
      'Narayana',
      'narayana',
      'Dr. Kavya Rao',
      'Patient Story Film',
      'rahul@narayanahealth.test',
      narayana.companyId,
    ]) {
      assert.ok(!payload.includes(leak), `workspace payload leaked "${leak}"`);
    }

    assert.ok(ws.pod.some((p) => p.fullName === 'Ritika Sharma'));
    assert.ok(ws.requests.every((r) => r.title !== 'Doctor Explainer Video'));
  });

  it('serves Narayana Health data to the Narayana user, and nothing else', async () => {
    const scope = (await resolveScope(narayana.userId, narayana.companyId))!;
    const ws = await getWorkspace({
      sessionId: 'test',
      user: { id: narayana.userId, email: 'rahul@narayanahealth.test', fullName: 'Rahul Verma' },
      scope,
    });

    assert.equal(ws.company.slug, 'narayana-health');
    const payload = JSON.stringify(ws);
    for (const leak of ['Magic Moments', 'Ritika Sharma', 'Diwali', magicMoments.companyId]) {
      assert.ok(!payload.includes(leak), `workspace payload leaked "${leak}"`);
    }
    assert.ok(ws.trust.work.some((w) => w.status === 'blocked'));
  });
});

describe('row-level security holds even when a query forgets its filter', () => {
  const scopedAs = async (companyId: string, run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    appSql.begin(async (tx) => {
      await tx`select set_config('cip.company_id', ${companyId}, true)`;
      return run(tx);
    });

  it('an unfiltered SELECT returns only the scoped company rows', async () => {
    const rows = (await scopedAs(magicMoments.companyId, (tx) =>
      // deliberately no WHERE clause — this is what a future bug looks like
      tx<{ title: string }[]>`select title from requests`,
    )) as { title: string }[];

    assert.ok(rows.length > 0, 'expected the scoped company to have requests');
    assert.ok(
      rows.every((r) => r.title !== 'Doctor Explainer Video'),
      'unfiltered query leaked the other company',
    );
  });

  it('a guessed company id returns nothing', async () => {
    const rows = (await scopedAs(magicMoments.companyId, (tx) =>
      tx`select title from requests where company_id = ${narayana.companyId}`,
    )) as unknown[];
    assert.equal(rows.length, 0);
  });

  it('a guessed row id returns nothing', async () => {
    const [target] = await adminSqlConn<{ id: string }[]>`
      select id from work_items where company_id = ${narayana.companyId} and status = 'blocked' limit 1
    `;
    assert.ok(target, 'expected a blocked Narayana work item to exist');

    const rows = (await scopedAs(magicMoments.companyId, (tx) =>
      tx`select title from work_items where id = ${target.id}`,
    )) as unknown[];
    assert.equal(rows.length, 0, 'a known row id from another company must return nothing');
  });

  it('no scope at all returns nothing, rather than everything', async () => {
    const rows = await appSql`select title from requests`;
    assert.equal(rows.length, 0, 'policies must fail closed when no company is set');
  });

  it('the application role cannot bypass row-level security', async () => {
    const { isRowLevelSecurityBinding } = await import('../src/server/db');
    assert.equal(
      await isRowLevelSecurityBinding(),
      true,
      'DATABASE_URL must use a role that is neither superuser nor BYPASSRLS',
    );
  });

  it('an INSERT for another company is rejected', async () => {
    await assert.rejects(
      () =>
        scopedAs(magicMoments.companyId, (tx) =>
          tx`insert into requests (company_id, title, summary, status, kind)
             values (${narayana.companyId}, 'planted', 'x', 'completed', 'doc')`,
        ),
      /row-level security/i,
    );
  });
});

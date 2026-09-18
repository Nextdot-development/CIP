import { createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';

/**
 * End-to-end proof against the running server.
 *
 * Signs in as each seeded user through the real credential path, mints a real
 * session, then calls GET /api/workspace over HTTP and checks what comes back.
 * Run with the dev server up:  npm run prove
 */
const BASE = process.env.CIP_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CIP_SEED_PASSWORD ?? '';
if (!PASSWORD) {
  // The seed no longer has a default password, so neither does the proof of it.
  throw new Error('Set CIP_SEED_PASSWORD to whatever the database was seeded with.');
}

function tokenHash(token: string): string {
  return createHmac('sha256', Buffer.from(process.env.SESSION_SECRET!, 'utf8')).update(token).digest('base64');
}

async function sessionFor(sql: postgres.Sql, email: string): Promise<string> {
  const { verifyCredentials } = await import('../src/server/auth/credentials');
  const verified = await verifyCredentials(email, PASSWORD);
  if (!verified) throw new Error(`sign-in failed for ${email}`);

  const token = randomBytes(32).toString('base64url');
  await sql`
    insert into sessions (token_hash, user_id, company_id, expires_at)
    values (${tokenHash(token)}, ${verified.userId}, ${verified.companyId}, now() + interval '1 hour')
  `;
  return token;
}

async function fetchWorkspace(token: string) {
  const res = await fetch(`${BASE}/api/workspace`, { headers: { cookie: `cip_session=${token}` } });
  return { status: res.status, body: await res.text() };
}

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

  console.log(`\nGET ${BASE}/api/workspace\n`);

  const anon = await fetch(`${BASE}/api/workspace`);
  check('no session is refused', anon.status === 401, `HTTP ${anon.status}`);

  const forged = await fetchWorkspace('forged-token-that-was-never-issued');
  check('a forged cookie is refused', forged.status === 401, `HTTP ${forged.status}`);

  const mmToken = await sessionFor(sql, 'sneha@magicmoments.test');
  const mm = await fetchWorkspace(mmToken);
  const mmData = JSON.parse(mm.body);
  check('Magic Moments session gets Magic Moments', mmData.company?.slug === 'magic-moments', mmData.company?.name);
  check('  no Narayana Health anywhere in the payload', !mm.body.includes('Narayana'));
  check('  no Dr. Kavya Rao in the payload', !mm.body.includes('Kavya'));
  check('  no Patient Story Film in the payload', !mm.body.includes('Patient Story Film'));

  const nhToken = await sessionFor(sql, 'rahul@narayanahealth.test');
  const nh = await fetchWorkspace(nhToken);
  const nhData = JSON.parse(nh.body);
  check('Narayana session gets Narayana Health', nhData.company?.slug === 'narayana-health', nhData.company?.name);
  check('  no Magic Moments anywhere in the payload', !nh.body.includes('Magic Moments'));
  check('  no Ritika Sharma in the payload', !nh.body.includes('Ritika'));

  // The endpoint takes no company argument at all. These are the shapes an
  // attacker would reach for; every one of them is ignored.
  for (const attempt of [
    `?companyId=${nhData.company.id}`,
    `?company=narayana-health`,
    `?tenant=narayana-health&companyId=${nhData.company.id}`,
  ]) {
    const res = await fetch(`${BASE}/api/workspace${attempt}`, {
      headers: { cookie: `cip_session=${mmToken}`, 'x-company-id': nhData.company.id },
    });
    const body = await res.text();
    check(`URL/header tampering ignored: ${attempt}`, !body.includes('Narayana'), 'still Magic Moments');
  }

  await sql.end();
  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 1 - 1 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';

/**
 * Company Drive isolation, proven over HTTP against the running server.
 *
 * Everything here goes through the real API with a real session cookie — no
 * service function is called directly, so this exercises the route handlers,
 * the guards and the database policies together.
 *
 *   npm run prove:drive        (needs the dev server up)
 */
const BASE = process.env.CIP_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CIP_SEED_PASSWORD ?? 'cip-demo-password';

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
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

const as = (token: string) => ({ cookie: `cip_session=${token}` });

async function api(token: string | null, path: string, init: RequestInit = {}) {
  const headers = { ...(init.headers ?? {}), ...(token ? as(token) : {}) };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* a download or an empty body */
  }
  return { status: res.status, text, json };
}

async function upload(token: string, name: string, body: string, folderId?: string) {
  const form = new FormData();
  form.append('file', new File([body], name, { type: 'text/plain' }));
  if (folderId) form.append('folderId', folderId);
  const res = await fetch(`${BASE}/api/drive/files`, { method: 'POST', headers: as(token), body: form });
  const json = (await res.json()) as Record<string, string>;
  return { status: res.status, json };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  // Verifying which company a row landed in needs a connection that can see
  // across companies. The app role deliberately cannot, which is the point.
  const admin = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!, { onnotice: () => {} });
  console.log(`\nCompany Drive over HTTP — ${BASE}\n`);

  const mm = await sessionFor(sql, 'sneha@magicmoments.test');
  const nh = await sessionFor(sql, 'rahul@narayanahealth.test');
  const stamp = Date.now();

  // --- 6. nothing without a session -------------------------------------
  for (const path of ['/api/drive', '/api/drive/archive', '/api/drive/search?q=test']) {
    const r = await api(null, path);
    check(`6. ${path} refuses an anonymous caller`, r.status === 401, `HTTP ${r.status}`);
  }
  const anonUpload = await fetch(`${BASE}/api/drive/files`, { method: 'POST', body: new FormData() });
  check('6. upload refuses an anonymous caller', anonUpload.status === 401, `HTTP ${anonUpload.status}`);

  // --- a folder and a file in each company ------------------------------
  const nhFolder = await api(nh, '/api/drive/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentId: null, name: `NH Confidential ${stamp}` }),
  });
  check('Narayana can create a folder', nhFolder.status === 201, `HTTP ${nhFolder.status}`);
  const nhFolderId = String(nhFolder.json?.id);

  const nhFile = await upload(nh, `nh-secret-${stamp}.txt`, 'patient consent scan', nhFolderId);
  check('Narayana can upload into it', nhFile.status === 201, `HTTP ${nhFile.status}`);
  const nhFileId = nhFile.json.id!;

  const mmFile = await upload(mm, `mm-brief-${stamp}.txt`, 'diwali brief');
  check('Magic Moments can upload', mmFile.status === 201, `HTTP ${mmFile.status}`);
  const mmFileId = mmFile.json.id!;

  // --- 1. listing --------------------------------------------------------
  const mmRoot = await api(mm, '/api/drive');
  check(
    '1. Magic Moments listing excludes Narayana content',
    !mmRoot.text.includes('NH Confidential') && !mmRoot.text.includes('nh-secret'),
  );
  check('1. and does include its own file', mmRoot.text.includes(`mm-brief-${stamp}`));

  // --- 2. guessed ids ----------------------------------------------------
  const openFolder = await api(mm, `/api/drive?folderId=${nhFolderId}`);
  check('2. opening the other company folder id returns 404', openFolder.status === 404, `HTTP ${openFolder.status}`);

  // --- 3. download -------------------------------------------------------
  const steal = await api(mm, `/api/drive/files/${nhFileId}/content`);
  check('3. downloading the other company file returns 404', steal.status === 404, `HTTP ${steal.status}`);
  check('3. and no bytes came back', !steal.text.includes('patient consent'));

  // --- 4. rename and delete ---------------------------------------------
  const rename = await api(mm, `/api/drive/files/${nhFileId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'stolen.txt' }),
  });
  check('4. renaming the other company file returns 404', rename.status === 404, `HTTP ${rename.status}`);

  const del = await api(mm, `/api/drive/files/${nhFileId}`, { method: 'DELETE' });
  check('4. archiving the other company file returns 404', del.status === 404, `HTTP ${del.status}`);

  const purge = await api(mm, `/api/drive/files/${nhFileId}?permanent=1`, { method: 'DELETE' });
  check('4. purging the other company file returns 404', purge.status === 404, `HTTP ${purge.status}`);

  const delFolder = await api(mm, `/api/drive/folders/${nhFolderId}`, { method: 'DELETE' });
  check('4. archiving the other company folder returns 404', delFolder.status === 404, `HTTP ${delFolder.status}`);

  // --- 5. writing into another company ----------------------------------
  const planted = await upload(mm, `planted-${stamp}.txt`, 'x', nhFolderId);
  check('5. uploading into the other company folder returns 404', planted.status === 404, `HTTP ${planted.status}`);

  const plantedFolder = await api(mm, '/api/drive/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentId: nhFolderId, name: 'planted' }),
  });
  check('5. nesting under the other company returns 404', plantedFolder.status === 404, `HTTP ${plantedFolder.status}`);

  // A company id is simply not a parameter any route accepts.
  const forged = await api(mm, '/api/drive/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': 'narayana' },
    body: JSON.stringify({ parentId: null, name: `forged ${stamp}`, company_id: 'x', companyId: 'x' }),
  });
  const owner = await admin<{ slug: string }[]>`
    select c.slug from drive_folders d join companies c on c.id = d.company_id
     where d.id = ${String(forged.json?.id)}
  `;
  check('5. a company id in the body or headers is ignored',
    forged.status === 201 && owner[0]?.slug === 'magic-moments',
    `HTTP ${forged.status}, landed in ${owner[0]?.slug ?? 'nowhere'}: ${forged.text.slice(0, 120)}`);

  // --- 7. search ---------------------------------------------------------
  const search = await api(mm, `/api/drive/search?q=nh-secret-${stamp}`);
  const hits = (search.json?.files as unknown[] | undefined) ?? [];
  const folderHits = (search.json?.folders as unknown[] | undefined) ?? [];
  check('7. search cannot reach the other company',
    search.status === 200 && hits.length === 0 && folderHits.length === 0,
    `HTTP ${search.status}, ${hits.length} file(s), ${folderHits.length} folder(s)`);

  // and it still finds this company own files
  const ownSearch = await api(mm, `/api/drive/search?q=mm-brief-${stamp}`);
  const ownHits = (ownSearch.json?.files as { name: string }[] | undefined) ?? [];
  check('7. search does find this company own files', ownHits.length === 1, `${ownHits.length} hit(s)`);

  // --- the other company is untouched throughout ------------------------
  const nhStill = await api(nh, `/api/drive/files/${nhFileId}/content`);
  check('Narayana still has its file, unchanged',
    nhStill.status === 200 && nhStill.text === 'patient consent scan', `HTTP ${nhStill.status}`);

  const mine = await api(mm, `/api/drive/files/${mmFileId}/content`);
  check('Magic Moments can download its own file', mine.text === 'diwali brief');

  // Leave the Drive as we found it. Everything this script made carries the
  // run stamp, so nothing a person created is touched.
  await admin`delete from drive_files  where name like ${'%' + String(stamp) + '%'}`;
  await admin`delete from drive_folders where name like ${'%' + String(stamp) + '%'}`;
  console.log('
  (cleaned up the folders and files this run created)');

  await sql.end();
  await admin.end();
  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Reads one page CIP could not fetch for itself.
 *
 *   npm run page -- <company-slug> <saved-file> --url <address> [--brand <name>]
 *
 * Some sites refuse anything that is not a browser. Jaisalmer's sits behind
 * Cloudflare, which answers 403 to every request including the one for
 * robots.txt - a blanket rule, not a header CIP could satisfy. Dressing a
 * request up as Chrome would defeat a control the site owner deliberately
 * switched on, which is not a thing to do for a marketing page.
 *
 * So somebody who is allowed to opens it, saves it, and hands it over. In
 * Chrome or Edge that is Ctrl+S, "Webpage, HTML Only". Everything after that
 * is identical to a page CIP fetched, including the address it is recorded
 * under - the only difference is who did the fetching, and it is written down
 * rather than hidden.
 *
 * The same command is the answer for anything behind a login, which no fetch
 * was ever going to reach.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pageDocument, readSavedPage, PageUnavailable } from '../src/server/brain/website';
import { uploadFile } from '../src/server/drive/service';
import { setFileBrand } from '../src/server/brain/brands';
import type { CompanyScope } from '../src/server/db';

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {} });

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? (process.argv[at + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const [slug, path] = process.argv.slice(2);
  const url = flag('url');
  const brand = flag('brand');

  if (!slug || !path || slug.startsWith('--') || path.startsWith('--') || !url) {
    console.error(
      '\n  npm run page -- <company-slug> <saved-file> --url <address> [--brand <name>]\n\n' +
        '  Save the page from a browser first: Ctrl+S, "Webpage, HTML Only".\n',
    );
    process.exit(1);
  }

  const rows = await admin<{ company_id: string; user_id: string; name: string }[]>`
    select c.id as company_id, u.id as user_id, c.name
      from companies c
      join memberships m on m.company_id = c.id
      join users u on u.id = m.user_id
     where c.slug = ${slug}
     order by m.role
     limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`no company with slug "${slug}"`);
  const scope: CompanyScope = { companyId: row.company_id, userId: row.user_id, role: 'owner' };

  const html = readFileSync(path, 'utf8');

  let page;
  try {
    page = readSavedPage(html, url);
  } catch (error) {
    const reason = error instanceof PageUnavailable ? error.reason : 'failed';
    // A saved page with no text is almost always one saved before it finished
    // loading, or saved as "complete" with the text in a separate folder.
    console.error(`\n  Could not read that file: ${reason}.`);
    console.error('  If the page draws itself with script, save it after it has finished loading.\n');
    process.exit(1);
  }

  const host = new URL(url).hostname.replace(/^www\./, '');
  const clean = page.title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const filename = `${clean || host} (${host}).txt`.slice(0, 200);

  const file = await uploadFile(scope, {
    folderId: null,
    filename,
    mimeType: 'text/plain',
    body: Buffer.from(pageDocument(page), 'utf8'),
    sourceType: 'website',
  });
  if (brand) await setFileBrand(scope, file.id, brand);

  console.log(`\n  ${filename}`);
  console.log(`  ${page.text.split(/\s+/).length} words${brand ? `, filed under ${brand}` : ''}.`);
  console.log('  Now run the worker: npm run cip:worker\n');
}

main()
  .then(async () => { await admin.end(); })
  .catch(async (error) => {
    console.error('\npage failed:', error instanceof Error ? error.message : error);
    await admin.end().catch(() => {});
    process.exit(1);
  });

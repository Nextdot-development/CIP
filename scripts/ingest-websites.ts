/**
 * Reads a company's own brand pages into CIP.
 *
 *   npm run websites -- <company-slug>            # show what would be read
 *   npm run websites -- <company-slug> --apply
 *
 * One page per brand, given by name. This follows no links and crawls nothing:
 * a brand reading its own pages is a different act from harvesting somebody
 * else's, and the difference is that every address here was supplied by the
 * company that owns it.
 *
 * A page becomes an ordinary file, so everything after this is the pipeline
 * that already exists - extraction, understanding, brand attribution, the
 * brand boundary, evidence counting. Running the worker afterwards is what
 * turns it into knowledge.
 */
import postgres from 'postgres';
import { fetchPage, pageDocument, PageUnavailable } from '../src/server/brain/website';
import { uploadFile } from '../src/server/drive/service';
import { setFileBrand } from '../src/server/brain/brands';
import type { CompanyScope } from '../src/server/db';

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {} });
const APPLY = process.argv.includes('--apply');

/**
 * The pages, as supplied.
 *
 * The brand beside each one is what the file gets attributed to, rather than
 * being guessed from the address later: radicokhaitan.com/products/8pm-honey
 * is plainly 8PM, and the roster is the authority on how that name is spelled.
 * A brand left null is attributed the ordinary way, from the filename.
 */
const PAGES: { brand: string | null; url: string }[] = [
  { brand: '8PM', url: 'https://radicokhaitan.com/products/8pm-honey/' },
  { brand: '8PM', url: 'https://radicokhaitan.com/products/8pm-fire/' },
  { brand: '8PM', url: 'https://radicokhaitan.com/products/8pm-premium-black-whisky/' },
  { brand: 'Afri Bull', url: 'https://radicokhaitan.com/products/afri-bull/' },
  { brand: 'Magic Moments', url: 'https://radicokhaitan.com/products/magic-moments/' },
  { brand: 'Whytehall', url: 'https://radicokhaitan.com/products/whytehall-whisky/' },
  { brand: 'Kohinoor Reserve', url: 'https://kohinoorindianrum.com/' },
  { brand: 'Jaisalmer', url: 'https://jaisalmergin.com/' },
  { brand: 'Sangam', url: 'https://rampursinglemalt.com/sangam/' },
  { brand: 'Rampur', url: 'https://rampursinglemalt.com/' },
  { brand: 'Rampur', url: 'https://rampursinglemalt.com/asava/' },
  { brand: 'Rampur', url: 'https://rampursinglemalt.com/barrel-blush/' },
  { brand: 'Rampur', url: 'https://rampursinglemalt.com/double-cask/' },
  { brand: 'Royal Ranthambore', url: 'https://www.royalranthambore.com/home' },
];

/** A filename that says what it is and where it came from. */
function filenameFor(url: string, title: string): string {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const clean = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${clean || host} (${host}).txt`.slice(0, 200);
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug || slug.startsWith('--')) {
    console.error('\n  npm run websites -- <company-slug> [--apply]\n');
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

  const existing = await admin<{ name: string }[]>`
    select name from drive_files
     where company_id = ${scope.companyId} and archived_at is null and source_type = 'website'
  `;
  const already = new Set(existing.map((f) => f.name));

  console.log(`\n${row.name} — ${PAGES.length} page(s)${APPLY ? '' : ', nothing will be written'}\n`);

  let read = 0;
  let stored = 0;
  let failed = 0;

  for (const page of PAGES) {
    let fetched;
    try {
      fetched = await fetchPage(page.url);
    } catch (error) {
      failed += 1;
      const reason = error instanceof PageUnavailable ? error.reason : 'failed';
      console.log(`  ! ${page.url.slice(0, 58).padEnd(60)} ${reason}`);
      // A site that refuses every request, robots.txt included, is not going
      // to be talked round by a different header. Save it from a browser and
      // hand it over instead.
      if (reason === 'http_403' || reason === 'http_401') {
        console.log(`      save it from a browser, then: npm run page -- <company> <file> --url ${page.url}`);
      }
      continue;
    }

    read += 1;
    const filename = filenameFor(fetched.url, fetched.title);
    const words = fetched.text.split(/\s+/).length;

    if (already.has(filename)) {
      console.log(`  = ${filename.slice(0, 60).padEnd(60)} already read`);
      continue;
    }

    console.log(`  ${APPLY ? '+' : ' '} ${filename.slice(0, 60).padEnd(60)} ${words} words  ${page.brand ?? ''}`);
    if (!APPLY) continue;

    const file = await uploadFile(scope, {
      folderId: null,
      filename,
      mimeType: 'text/plain',
      body: Buffer.from(pageDocument(fetched), 'utf8'),
      sourceType: 'website',
    });
    if (page.brand) await setFileBrand(scope, file.id, page.brand);
    stored += 1;
  }

  console.log(`\n  ${read} read, ${failed} could not be read.`);
  if (APPLY) console.log(`  ${stored} stored. Now run the worker: npm run cip:worker\n`);
  else console.log('  Re-run with --apply to store them.\n');
}

main()
  .then(async () => { await admin.end(); })
  .catch(async (error) => {
    console.error('\nwebsites failed:', error instanceof Error ? error.message : error);
    await admin.end().catch(() => {});
    process.exit(1);
  });

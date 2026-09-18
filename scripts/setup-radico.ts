import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { hashPassword } from '../src/server/auth/password';
import { addBrand } from '../src/server/brain/brands';
import { uploadFile } from '../src/server/drive/service';
import type { CompanyScope } from '../src/server/db';

/**
 * Sets Radico Khaitan up as a company, with its brands and its brief.
 *
 *   npm run setup:radico -- path/to/Radico_Khaitan_Project_Context_SLM.md
 *
 * Radico is a house with nine brands, and its own document says the thing that
 * matters most about it: "do not allow all brands to collapse into the same
 * vocabulary". So the roster goes in before the document does — the Brain
 * attributes each fact to a brand as it reads, and it can only do that against
 * a list it already has.
 *
 * Safe to run twice. The company, the people and the brands are all upserted,
 * and re-uploading the document produces a second file rather than a duplicate
 * fact, because facts are keyed by what they say.
 */

const SLUG = 'radico-khaitan';

/**
 * The roster, from the brand voice matrix in the document itself.
 *
 * Each note is what tells one from another when a fact could belong to
 * either. A brand's lines - Whytehall Honey, Magic Moments Remix - are the
 * brand, not brands of their own: the house thinks of Whytehall as one brand,
 * and listing its lines beside it read as the same brand three times. They are
 * named in the note, and their names are the brand's aliases.
 */
const BRANDS: { name: string; note: string; aliases?: string[] }[] = [
  {
    name: 'Magic Moments',
    note: 'Vodka. Fun, playful, social, magical. Bright premium visuals, movement, cocktails, flavour. Platform: MAKE IT MAGIC. Lines: Dazzle, Remix.',
    aliases: ['magic moments dazzle', 'magic moments remix'],
  },
  {
    name: '8PM',
    note: 'Whisky. Social, lifestyle, occasion-led. Nightlife, football, community. Conversational and culturally aware.',
  },
  {
    name: 'Whytehall',
    note: 'Premium whisky. Regal, sophisticated, restrained. Gold, black, ivory, crest and crown. Refined and confident. Lines: Honey (warm, smooth, golden honey tones), Fire (bold, intense, fire and heat), Peanut Butter (experimental, sensory, indulgent).',
    aliases: ['whytehall honey', 'whytehall fire', 'whytehall peanut butter'],
  },
  {
    name: 'Morpheus',
    note: 'Premium whisky. Human, polished, restrained. Positioning is deliberately thin — do not invent a manifesto for it.',
  },
  {
    name: 'Royal Ranthambore',
    note: 'Majestic, heritage-led, powerful. Tiger, fort, royal India, gold and maroon. Cinematic and evocative. Platform: THE ROYALTY.',
  },
  {
    name: 'Blue Finest',
    note: 'Traditional, premium, classic. Blue, cream, gold, castle heritage. Straightforward and premium.',
  },
];

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { ssl: 'require', max: 1, onnotice: () => {} });

async function main() {
  const documentPath = process.argv[2];
  if (!documentPath) {
    console.error('Give me the context document:\n  npm run setup:radico -- path/to/context.md\n');
    process.exit(1);
  }

  console.log('\nSetting up Radico Khaitan\n');

  // --- the company ---------------------------------------------------------
  const [company] = await admin<{ id: string }[]>`
    insert into companies (slug, name, industry)
    values (${SLUG}, 'Radico Khaitan', 'Spirits')
    on conflict (slug) do update set name = excluded.name, industry = excluded.industry
    returning id
  `;
  const companyId = company!.id;
  console.log(`  company    ${SLUG}`);

  // --- somebody to sign in as ----------------------------------------------
  // A real client workspace never gets the demo password: it is written in this
  // repository, so it is everybody's password. Changing an existing sign-in is
  // `npm run set-login`; this only sets the password of a user it creates.
  const password = process.env.CIP_SEED_PASSWORD ?? '';
  if (password.length < 12 || password === 'cip-demo-password') {
    throw new Error(
      'Set CIP_SEED_PASSWORD to a real password of at least 12 characters. The demo password is public.',
    );
  }
  const [user] = await admin<{ id: string }[]>`
    insert into users (email, full_name, password_hash)
    values ('brand@radico.test', 'Radico Brand Team', ${await hashPassword(password)})
    on conflict (email) do update set full_name = excluded.full_name
    returning id
  `;
  await admin`
    insert into memberships (company_id, user_id, role)
    values (${companyId}, ${user!.id}, 'owner')
    on conflict (company_id, user_id) do update set role = excluded.role
  `;
  console.log('  sign-in    brand@radico.test');

  // --- what the workspace shell needs to render at all --------------------
  // The layout refuses to load a company with no branding, so a company
  // created without it signs in and then 500s on every page.
  await admin`
    insert into company_branding
      (company_id, primary_color, deep_color, nav_theme,
       hero_title, hero_subtitle, hero_from, hero_to, hero_glow, hero_ink)
    values
      (${companyId}, '#8E2035', '#5C1322', 'dark',
       'Nine brands. One memory.',
       'Each brand keeps its own voice. CIP keeps track of which is which.',
       '#8E2035', '#3B0C17', '#C9414F', '#FFFFFF')
    on conflict (company_id) do update
       set primary_color = excluded.primary_color,
           deep_color    = excluded.deep_color,
           nav_theme     = excluded.nav_theme,
           hero_title    = excluded.hero_title,
           hero_subtitle = excluded.hero_subtitle,
           hero_from     = excluded.hero_from,
           hero_to       = excluded.hero_to,
           hero_glow     = excluded.hero_glow,
           hero_ink      = excluded.hero_ink
  `;

  // The composer's placeholder and its suggestions live here. The percentage
  // columns are Phase-1 scaffolding that nothing reads any more; they are set
  // to zero rather than to a number that would look like a measurement.
  await admin`
    insert into brand_profiles
      (company_id, understanding_pct, paid_unlock_pct, headline, note,
       composer_placeholder, prompt_suggestions, voice_sounds, voice_never)
    values
      (${companyId}, 0, 0,
       'Radico Khaitan',
       'Nine brands, each with its own voice.',
       ${'e.g. "A Diwali post for Magic Moments" or "a matchday poster for 8PM in Ghana"'},
       ${[
         'A Diwali post for Magic Moments',
         'A matchday poster for 8PM',
         'A tasting-notes visual for Whytehall Peanut Butter',
         'A heritage film still for Royal Ranthambore',
       ]},
       ${['Specific', 'Visual', 'Human', 'Brand-owned', 'Concise']},
       ${['Generic', 'Forced', 'Over-written', 'Like any other whisky brand']})
    on conflict (company_id) do update
       set headline             = excluded.headline,
           note                 = excluded.note,
           composer_placeholder = excluded.composer_placeholder,
           prompt_suggestions   = excluded.prompt_suggestions,
           voice_sounds         = excluded.voice_sounds,
           voice_never          = excluded.voice_never
  `;
  console.log('  branding   set');

  const scope: CompanyScope = { companyId, userId: user!.id, role: 'owner' };

  // --- the brands, before the document -------------------------------------
  // The Brain attributes each fact to a brand as it reads, and it can only do
  // that against a roster it already has.
  for (const [index, brand] of BRANDS.entries()) {
    await addBrand(scope, { name: brand.name, note: brand.note, position: index, aliases: brand.aliases });
  }
  console.log(`  brands     ${BRANDS.length} on the roster`);

  // --- the brief -----------------------------------------------------------
  const body = readFileSync(documentPath);
  const filename = 'Radico brand context.md';

  // Replace an earlier copy rather than stacking them up.
  const previous = await admin<{ id: string }[]>`
    select id from drive_files
     where company_id = ${companyId} and name = ${filename} and archived_at is null
  `;
  for (const old of previous) {
    await admin`update drive_files set archived_at = now() where id = ${old.id}`;
  }

  const file = await uploadFile(scope, {
    folderId: null,
    filename,
    mimeType: 'text/markdown',
    body,
  });
  console.log(`  document   ${filename} (${(body.length / 1024).toFixed(0)} KB)`);

  console.log(`\n  Now read it:  npm run cip:worker`);
  console.log(`  Then sign in: brand@radico.test\n`);

  void file;
  await admin.end();
}

main().catch(async (error) => {
  console.error('\nsetup failed:', error instanceof Error ? error.message : error);
  await admin.end().catch(() => {});
  process.exit(1);
});

import { pathToFileURL } from 'node:url';
import { adminSql } from './db-admin';
import { hashPassword } from './auth/password';
import { seedCompanies } from './seed-data';
import type { SeedCompany } from './seed-data';

/**
 * Loads the two development companies.
 *
 * Runs on the admin connection so it can write across companies; the running
 * application never uses that connection. Re-running replaces everything, so
 * the seed is safe to repeat while developing.
 */

const DEFAULT_PASSWORD = 'cip-demo-password';

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function firstOfThisMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export async function seed(log: (m: string) => void = console.log): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.CIP_ALLOW_PROD_SEED !== 'true') {
    throw new Error(
      'Refusing to seed with NODE_ENV=production. This creates users with a known ' +
        'password. Set CIP_ALLOW_PROD_SEED=true only if you are certain.',
    );
  }

  const password = process.env.CIP_SEED_PASSWORD ?? DEFAULT_PASSWORD;
  const sql = adminSql();

  try {
    // Companies cascade to everything they own, so this clears the workspace
    // tables too. Users are cleared separately: they are not company-owned.
    await sql`truncate table companies cascade`;
    await sql`truncate table users cascade`;
    log('  cleared existing companies and users');

    const passwordHash = await hashPassword(password);

    for (const company of seedCompanies) {
      await seedCompany(sql, company, passwordHash, log);
    }

    log('');
    log(`  Test password for every seeded user: ${password}`);
  } finally {
    await sql.end();
  }
}

async function seedCompany(
  sql: ReturnType<typeof adminSql>,
  c: SeedCompany,
  passwordHash: string,
  log: (m: string) => void,
): Promise<void> {
  const [company] = await sql<{ id: string }[]>`
    insert into companies (slug, name, legal_name, industry)
    values (${c.slug}, ${c.name}, ${c.legalName}, ${c.industry})
    returning id
  `;
  const companyId = company!.id;

  const b = c.branding;
  await sql`
    insert into company_branding (company_id, primary_color, deep_color, nav_theme,
                                  hero_title, hero_subtitle, hero_from, hero_to, hero_glow, hero_ink)
    values (${companyId}, ${b.primaryColor}, ${b.deepColor}, ${b.navTheme},
            ${b.heroTitle}, ${b.heroSubtitle}, ${b.heroFrom}, ${b.heroTo}, ${b.heroGlow}, ${b.heroInk})
  `;

  const br = c.brand;
  await sql`
    insert into brand_profiles (company_id, understanding_pct, paid_unlock_pct, headline, note,
                                composer_placeholder, prompt_suggestions, voice_sounds, voice_never)
    values (${companyId}, ${br.understandingPct}, ${br.paidUnlockPct}, ${br.headline}, ${br.note},
            ${br.composerPlaceholder}, ${br.promptSuggestions}, ${br.voiceSounds}, ${br.voiceNever})
  `;

  for (const [i, u] of br.unlocks.entries()) {
    await sql`insert into brand_unlocks (company_id, label, at_pct, sort_order)
              values (${companyId}, ${u.label}, ${u.atPct}, ${i})`;
  }
  for (const [i, t] of br.topics.entries()) {
    await sql`insert into brand_topics (company_id, key, title, blurb, cta, items, sort_order)
              values (${companyId}, ${t.key}, ${t.title}, ${t.blurb}, ${t.cta},
                      ${sql.json(t.items)}, ${i})`;
  }
  for (const [i, f] of br.confirmations.entries()) {
    await sql`insert into brand_confirmations (company_id, question, context, suggestion, sort_order)
              values (${companyId}, ${f.question}, ${f.context}, ${f.suggestion}, ${i})`;
  }
  for (const [i, p] of br.palette.entries()) {
    await sql`insert into brand_palette (company_id, name, hex, sort_order)
              values (${companyId}, ${p.name}, ${p.hex}, ${i})`;
  }

  const podIds = new Map<string, string>();
  for (const [i, m] of c.pod.entries()) {
    const [row] = await sql<{ id: string }[]>`
      insert into pod_members (company_id, full_name, craft, bio, sort_order)
      values (${companyId}, ${m.fullName}, ${m.craft}, ${m.bio}, ${i})
      returning id
    `;
    podIds.set(m.craft, row!.id);
  }

  for (const r of c.requests) {
    await sql`
      insert into requests (company_id, title, summary, status, kind, submitted_at, due_at, completed_at)
      values (${companyId}, ${r.title}, ${r.summary}, ${r.status}, ${r.kind},
              ${daysFromNow(-r.submittedDaysAgo)},
              ${r.dueInDays === undefined ? null : daysFromNow(r.dueInDays)},
              ${r.completedDaysAgo === undefined ? null : daysFromNow(-r.completedDaysAgo)})
    `;
  }

  const period = firstOfThisMonth();
  for (const [i, m] of c.metrics.entries()) {
    await sql`
      insert into monthly_metrics (company_id, period, key, label, value, unit, note,
                                   delta, delta_unit, delta_note, tone, sort_order)
      values (${companyId}, ${period}, ${m.key}, ${m.label}, ${m.value}, ${m.unit}, ${m.note ?? null},
              ${m.delta ?? null}, ${m.deltaUnit ?? null}, ${m.deltaNote ?? null}, ${m.tone}, ${i})
    `;
  }

  for (const [i, w] of c.work.entries()) {
    await sql`
      insert into work_items (company_id, title, meta, status, reason_tone, reason_text,
                              fixes, owner_pod_member_id, sort_order)
      values (${companyId}, ${w.title}, ${w.meta}, ${w.status}, ${w.reasonTone ?? null},
              ${w.reasonText ?? null}, ${w.fixes ?? []},
              ${w.ownerCraft ? (podIds.get(w.ownerCraft) ?? null) : null}, ${i})
    `;
  }
  for (const [i, r] of c.rights.entries()) {
    await sql`insert into rights_items (company_id, title, note, expires_at, sort_order)
              values (${companyId}, ${r.title}, ${r.note}, ${daysFromNow(r.expiresInDays)}, ${i})`;
  }
  for (const [i, k] of c.checks.entries()) {
    await sql`insert into compliance_checks (company_id, name, note, state, sort_order)
              values (${companyId}, ${k.name}, ${k.note}, ${k.state}, ${i})`;
  }
  for (const [i, l] of c.learnings.entries()) {
    await sql`insert into learnings (company_id, period, text, effect, sort_order)
              values (${companyId}, ${period}, ${l.text}, ${l.effect}, ${i})`;
  }
  for (const [i, l] of c.costLines.entries()) {
    await sql`insert into cost_lines (company_id, period, label, amount_minor, sort_order)
              values (${companyId}, ${period}, ${l.label}, ${l.amountMinor}, ${i})`;
  }

  for (const u of c.users) {
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, full_name, password_hash)
      values (${u.email.toLowerCase()}, ${u.fullName}, ${passwordHash})
      returning id
    `;
    await sql`insert into memberships (user_id, company_id, role)
              values (${user!.id}, ${companyId}, ${u.role})`;
  }

  log(`  seeded ${c.name} — ${c.pod.length} pod, ${c.requests.length} requests, ${c.users.length} users`);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  console.log('Seeding development data...');
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

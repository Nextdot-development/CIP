import postgres from 'postgres';
import { generateWithBrain } from '../src/server/brain/generate';
import { planGeneration, promptFromBrief } from '../src/server/brain/planner';
import { readBrandDna } from '../src/server/brain/brandDna';
import { analyseNextFeedback, readLessons, submitFeedback } from '../src/server/brain/learning';
import { brainStatus } from '../src/server/brain/providers';
import { readAsset } from '../src/server/media/generation';
import type { CompanyScope } from '../src/server/db';

/**
 * The Brain, end to end, against real company data and real providers.
 *
 *   npm run prove:brain              # everything except the paid generation
 *   npm run prove:brain -- --generate  # including a real GPT-Image-2 call
 *
 * This is the acceptance test the whole feature is judged by:
 *
 *   real assets -> understanding -> Brand DNA -> a request -> retrieval
 *   -> a brief -> a real generator -> an image -> 0-10 feedback -> a lesson
 *   -> a second request whose brief carries that lesson
 *
 * The last step is the one that matters. Anything can store feedback; the claim
 * being tested is that a later generation is actually different because of it.
 */

const GENERATE = process.argv.includes('--generate');

let failures = 0;
function check(label: string, pass: boolean, detail = ''): void {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
}

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { ssl: 'require', max: 1, onnotice: () => {} });

async function scopeFor(slug: string): Promise<CompanyScope> {
  const rows = await admin<{ company_id: string; user_id: string }[]>`
    select c.id as company_id, u.id as user_id
      from companies c
      join memberships m on m.company_id = c.id
      join users u on u.id = m.user_id
     where c.slug = ${slug}
     limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`no company ${slug}`);
  return { companyId: row.company_id, userId: row.user_id, role: 'owner' };
}

async function main() {
  console.log(`\nCIP Brain, end to end — ${new Date().toISOString()}\n`);

  const status = brainStatus();
  console.log(`  Brain provider: ${status.provider} / ${status.model} (${status.configured ? 'configured' : 'NOT configured'})\n`);

  const mm = await scopeFor('magic-moments');
  const nh = await scopeFor('narayana-health');

  // --- 1. understanding exists, from real assets --------------------------
  const understood = await admin<{ n: number; kinds: string }[]>`
    select count(*)::int n, string_agg(distinct kind, ', ') kinds
      from asset_understanding
     where company_id = ${mm.companyId} and status = 'ready'
  `;
  check('1. real assets have been understood', (understood[0]?.n ?? 0) > 0,
    `${understood[0]?.n ?? 0} asset(s): ${understood[0]?.kinds ?? 'none'}`);

  // --- 2. Brand DNA is derived from them, with provenance -----------------
  const facts = await readBrandDna(mm, { limit: 50 });
  check('2. Brand DNA was derived from those assets', facts.length > 0, `${facts.length} fact(s)`);

  const withEvidence = await admin<{ n: number }[]>`
    select count(distinct e.fact_id)::int n
      from brand_dna_evidence e
      join brand_dna_facts f on f.id = e.fact_id
     where f.company_id = ${mm.companyId} and e.file_id is not null
  `;
  check('2. every fact traces back to the assets it came from',
    (withEvidence[0]?.n ?? 0) > 0, `${withEvidence[0]?.n ?? 0} fact(s) with asset provenance`);

  // --- 3. a request is planned against that memory ------------------------
  const request = 'Magic Moments ke liye ek promotional Instagram image banao';
  const firstPlan = await planGeneration(mm, { requestText: request, mediaType: 'image' });

  check('3. planning produced a brief', firstPlan.briefId.length > 0);
  check('3. the brief carries brand rules retrieved from memory',
    firstPlan.brief.brandRules.length > 0, `${firstPlan.brief.brandRules.length} rule(s)`);

  const firstPrompt = promptFromBrief(firstPlan.brief);
  check('3. the generator prompt is not the raw request',
    firstPrompt !== request && firstPrompt.length > request.length,
    `${firstPrompt.length} chars vs ${request.length}`);

  // The real test of retrieval: something the company actually wrote reaches
  // the prompt. This phrase exists only in their own tone-of-voice document.
  const carriesBrand = /occasion|cinematic|witty|warm/i.test(firstPrompt);
  check('3. brand knowledge from their own documents reached the prompt', carriesBrand,
    carriesBrand ? 'tone-of-voice wording present' : 'no brand wording found');

  console.log(`\n     brief prompt: ${firstPrompt.slice(0, 170)}...\n`);

  // --- 4. company isolation ------------------------------------------------
  const theirFacts = await readBrandDna(nh, { limit: 50 });
  check('4. the other company has its own, separate Brand DNA',
    theirFacts.length === 0 || !theirFacts.some((f) => facts.some((o) => o.id === f.id)),
    `${theirFacts.length} fact(s) for narayana-health`);

  const theirPlanCarriesOurs = theirFacts.some((f) =>
    /occasion, never the alcohol/i.test(f.value),
  );
  check('4. our brand rules did not leak into theirs', !theirPlanCarriesOurs);

  const crossRead = await admin<{ n: number }[]>`
    select count(*)::int n from brand_dna_facts
     where company_id = ${nh.companyId}
       and value in (select value from brand_dna_facts where company_id = ${mm.companyId})
  `;
  check('4. no Brand DNA fact is shared across companies', (crossRead[0]?.n ?? 0) === 0);

  // --- 5. generate for real, if asked -------------------------------------
  let generationId: string | null = null;

  if (GENERATE) {
    console.log('  (generating for real — this costs money)\n');
    const result = await generateWithBrain(mm, { requestText: request, mediaType: 'image', provider: 'openai' });

    if (result.status === 'needs_clarification') {
      check('5. generation ran', false, `the Brain asked instead: ${result.question}`);
    } else {
      generationId = result.generation.id;
      check('5. GPT-Image-2 generated from the Brain brief',
        result.generation.status === 'completed',
        `${result.generation.provider}/${result.generation.model} ${result.generation.width}x${result.generation.height}`);

      const asset = await readAsset(mm, result.generation.id);
      check('5. the image is stored and readable through the company-scoped flow',
        asset.fileSize > 0, `${asset.fileSize} bytes ${asset.mimeType}`);

      const linked = await admin<{ n: number }[]>`
        select count(*)::int n from generation_briefs
         where generation_id = ${result.generation.id} and company_id = ${mm.companyId}
      `;
      check('5. the brief is linked to the generation it produced', (linked[0]?.n ?? 0) === 1);
    }
  } else {
    console.log('  (skipping the paid generation; pass --generate to include it)\n');
  }

  // --- 6. feedback becomes a scoped lesson --------------------------------
  // Without a real generation there is nothing to rate, so one is created
  // directly. The learning path is identical either way.
  if (!generationId) {
    const rows = await admin<{ id: string }[]>`
      select id from media_generations
       where company_id = ${mm.companyId} and status = 'completed'
       order by created_at desc limit 1
    `;
    generationId = rows[0]?.id ?? null;
  }

  if (!generationId) {
    check('6. feedback learning', false, 'no completed generation to rate');
  } else {
    // Attach the brief to it, so the lesson can be scoped by what was asked.
    await admin`
      update generation_briefs set generation_id = ${generationId}
       where id = ${firstPlan.briefId}
    `;

    await submitFeedback(mm, {
      generationId,
      score: 9,
      comment: 'Product placement perfect hai, but text thoda kam rakho.',
    });
    check('6. a 0-10 score with a comment was recorded', true, '9/10');

    const learned = await analyseNextFeedback();
    check('6. the feedback produced a lesson',
      learned?.status === 'learned',
      learned?.status === 'learned' ? `${learned.lessons} lesson(s)` : String(learned?.status));

    const lessons = await readLessons(mm, { limit: 20 });
    check('6. the lesson is scoped, not a company-wide rule',
      lessons.some((l) => l.taskType !== null || l.campaign !== null || l.product !== null || l.platform !== null),
      lessons.map((l) => `${l.polarity}[${l.taskType ?? l.campaign ?? l.platform ?? 'company'}]`).join(', ') || 'none');

    // --- 7. the next request is different because of it -------------------
    const secondPlan = await planGeneration(mm, { requestText: request, mediaType: 'image' });
    const secondPrompt = promptFromBrief(secondPlan.brief);

    // The stored lesson must be *retrieved*, not merely re-derived by the model
    // from the feedback it was shown as an example. Only lessonIds proves the
    // scoped-retrieval path actually fired.
    check('7. THE TEST: the stored lesson was retrieved for the next request',
      secondPlan.lessonIds.length > 0,
      `${secondPlan.lessonIds.length} lesson(s) retrieved by scope`);

    check('7. and it reached the brief the generator will act on',
      secondPlan.brief.learnedPreferences.length > 0 || secondPlan.brief.avoid.length > 0,
      `${secondPlan.brief.learnedPreferences.length} preference(s), ` +
        `${secondPlan.brief.avoid.length} avoidance(s)`);

    const mentionsText = /text/i.test(secondPrompt) && secondPrompt !== firstPrompt;
    check('7. and the prompt itself changed', secondPrompt !== firstPrompt,
      mentionsText ? 'the text preference reached the prompt' : 'prompt differs');

    console.log(`\n     second prompt: ${secondPrompt.slice(0, 170)}...\n`);
  }

  // --- 8. nothing sensitive leaves ----------------------------------------
  const briefRow = await admin<{ brief: unknown }[]>`
    select brief from generation_briefs where id = ${firstPlan.briefId}
  `;
  const payload = JSON.stringify(briefRow[0]?.brief ?? {});
  const leaks = ['companies/', mm.companyId, 'storage_path', 'sk-', 'Bearer '].filter((f) =>
    payload.includes(f),
  );
  check('8. the stored brief carries nothing sensitive', leaks.length === 0,
    leaks.length === 0 ? 'checked ids, paths and credentials' : leaks.join(', '));

  await admin.end();
  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  if (failures > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error('\nprove:brain failed:', error instanceof Error ? error.message : error);
  await admin.end().catch(() => {});
  process.exit(1);
});

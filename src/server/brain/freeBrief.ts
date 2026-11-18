import type { BriefInput, CreativeFormat, GenerationBrief } from './providers/types';

/**
 * Whether a text model plans a picture - writes its brief and lays out its post - before it is made.
 * Off: only the picture itself is paid for. The brief is put together from what CIP holds - the
 * brand's own facts, its rules and lessons, and the person's request - and the post laid out from
 * the brand's own layouts and headlines. CIP_AI_PLANNING=on brings the model back for both.
 */
export function aiPlanning(): boolean {
  return process.env.CIP_AI_PLANNING === 'on';
}

function formatFromWords(text: string): CreativeFormat {
  const t = text.toLowerCase();
  if (t.includes('billboard') || t.includes('hoarding')) return 'billboard';
  if (t.includes('banner')) return 'banner';
  if (t.includes('story') || t.includes('reel')) return 'story';
  if (t.includes('carousel')) return 'carousel_card';
  if (t.includes('poster')) return 'poster';
  if (t.includes('thumbnail')) return 'thumbnail';
  if (t.includes('post')) return 'feed_post';
  return 'other';
}

/** The look of a brand, as its own facts say it: lighting, palette, mood, setting - the strongest first. */
const LOOK = /(lighting|light|palette|colou?r|mood|tone|setting|background|scene|style|surface|composition|props?)/i;

/**
 * A brief with no model asked: the request as the person wrote it, the brand's look and rules beside
 * it, what it learned to prefer and to avoid. Nothing is invented - every line is the person's or the
 * brand's own - and nothing is asked: the brand and the market were chosen before it started.
 */
export function freeBrief(input: BriefInput): GenerationBrief {
  const words = input.requestText.toLowerCase();
  const look = input.brandFacts
    .filter((f) => f.section === 'visual' && LOOK.test(f.attribute) && !/^#[0-9a-f]{6}$/i.test(f.value.trim()))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8)
    .map((f) => `${f.attribute}: ${f.value}`);
  const brandRules = input.brandFacts.slice(0, 12).map((f) => `${f.attribute}: ${f.value}`);
  const prefer = input.lessons.filter((l) => l.polarity === 'prefer').map((l) => l.statement).slice(0, 5);
  const avoidLessons = input.lessons.filter((l) => l.polarity === 'avoid').map((l) => l.statement).slice(0, 5);
  const must = (input.complianceRules ?? []).filter((r) => r.requirement === 'required').map((r) => r.rule).slice(0, 6);
  const mustNot = (input.complianceRules ?? []).filter((r) => r.requirement === 'forbidden').map((r) => r.rule).slice(0, 8);
  // What the team set never to go in the brand's scenes.
  const never = input.brandFacts.filter((f) => /^never in (the )?scenes?$/i.test(f.attribute)).map((f) => f.value).slice(0, 8);
  const avoid = [...never, ...avoidLessons, ...mustNot];
  const prompt = [
    input.requestText.trim(),
    look.length ? `In the brand's own look - ${look.join('; ')}.` : '',
    prefer.length ? `It has worked before: ${prefer.join('; ')}.` : '',
    avoid.length ? `Never: ${avoid.join('; ')}.` : '',
    'A real photograph for a premium advertisement: true colour, real materials, believable light. No text, letters, logos or watermarks.',
  ].filter(Boolean).join(' ');
  return {
    brand: null,
    market: null,
    taskType: input.mediaType === 'video' ? 'promotional_video' : 'promotional_image',
    format: formatFromWords(input.requestText),
    platform: /instagram/.test(words) ? 'instagram' : /facebook/.test(words) ? 'facebook' : null,
    campaign: input.knownCampaigns.find((c) => words.includes(c.toLowerCase())) ?? null,
    product: input.knownProducts.find((p) => words.includes(p.toLowerCase())) ?? null,
    visualDirection: input.mediaType === 'image' ? look.join('; ') || null : null,
    videoDirection: input.mediaType === 'video' ? look.join('; ') || null : null,
    contentDirection: null,
    brandRules,
    successfulPatterns: input.successfulExamples.map((e) => e.requestText).slice(0, 5),
    negativePatterns: input.negativeExamples.map((e) => e.requestText).slice(0, 5),
    learnedPreferences: prefer,
    constraints: must,
    avoid,
    generationPrompt: prompt.slice(0, 3800),
    // As sure as what the brand holds: with nothing learned, the request alone.
    confidence: input.brandFacts.length > 0 ? 0.7 : 0.4,
    clarificationQuestion: null,
  };
}

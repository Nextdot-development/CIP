import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { rebuildPost, type PostRecipe } from './composePost';
import { completeGeneration, failGeneration, getGeneration, insertGeneration, keepScene, sceneOf } from './generation';
import type { HeadlineLine } from './typography';
import { MediaRejected, type MediaGenerationDTO } from './types';

/**
 * A composed post with other words on it.
 *
 * The post's scene was kept beside it, and so was everything it was put
 * together from - the brand's bottle and logo, the layout, where the Bench's
 * review left the bottle. So "Happy Diwali" can become "Happy Holi" by setting
 * the words again on the same scene: a second or two, no model asked, nothing
 * spent. The result is a new version; the one it came from stays as it was.
 */

const ROLES = new Set<HeadlineLine['role']>(['lead', 'key', 'tail']);
const MAX_LINES = 4;
const MAX_LINE = 80;
const MAX_WORDS = 20;

/** The new headline as somebody typed it, checked: one to four lines, each a part of the layout. */
export function headlineFrom(raw: unknown): HeadlineLine[] {
  if (!Array.isArray(raw)) throw new MediaRejected('Send the headline as its lines.');
  const lines = raw
    .map((l) => ({
      text: typeof l?.text === 'string' ? l.text.replace(/\s+/g, ' ').trim() : '',
      role: ROLES.has(l?.role) ? (l.role as HeadlineLine['role']) : 'lead',
    }))
    .filter((l) => l.text);
  if (lines.length === 0) throw new MediaRejected('The headline needs at least one line.');
  if (lines.length > MAX_LINES) throw new MediaRejected(`A headline is at most ${MAX_LINES} lines.`);
  if (lines.some((l) => l.text.length > MAX_LINE)) throw new MediaRejected(`Each line is at most ${MAX_LINE} characters.`);
  if (lines.reduce((n, l) => n + l.text.split(' ').length, 0) > MAX_WORDS) {
    throw new MediaRejected(`A headline is at most ${MAX_WORDS} words; a post is read in a glance.`);
  }
  return lines;
}

/** Sets a composed post again with new words, on the scene it was made on. Returns the new version. */
export async function changeText(scope: CompanyScope, generationId: string, raw: unknown): Promise<MediaGenerationDTO> {
  const headline = headlineFrom(raw);
  // This company's, or not found.
  const { generation } = await getGeneration(scope, generationId);
  const [row] = await withCompanyScope(scope, (tx) => tx<{
    composed: { recipe?: PostRecipe; scene?: boolean } & Record<string, unknown> | null;
    provider: string;
    model: string;
    prompt: string;
  }[]>`
    select output_metadata->'composed' as composed, provider, model, prompt
      from media_generations where id = ${generationId} and company_id = ${scope.companyId}
  `);
  const composed = row?.composed;
  if (!composed?.recipe || !composed.scene) {
    throw new MediaRejected(
      'The words on this picture are part of the picture, so they can only be changed by making it again.',
    );
  }

  const scene = await sceneOf(scope, generationId);
  const post = await rebuildPost(scope, composed.recipe, scene, headline);

  const id = await insertGeneration(scope, {
    type: 'image',
    provider: row!.provider,
    model: row!.model,
    prompt: row!.prompt,
    status: 'processing',
    inputMetadata: { aspectRatio: generation.aspectRatio, textChangedFrom: generationId },
    idempotencyKey: null,
  });
  try {
    await completeGeneration(
      scope,
      id,
      [{ bytes: post.bytes, mimeType: 'image/png', width: post.width, height: post.height }],
      // Nothing was asked of a provider, and nothing was spent.
      { providerRequestId: null, inputUnits: 0, outputUnits: 0, estimatedCost: null, costCurrency: null },
      row!.model,
    );
    // The same scene, kept for the new version too, so it can be changed again.
    const kept = await keepScene(scope, id, scene);
    await withCompanyScope(scope, (tx) => tx`
      update media_generations
         set output_metadata = coalesce(output_metadata, '{}'::jsonb)
             || ${tx.json({ composed: { ...composed, headline, scene: kept, textChangedFrom: generationId } } as never)}
       where id = ${id} and company_id = ${scope.companyId}
    `);
  } catch (error) {
    await failGeneration(scope, id, error);
    throw error;
  }
  return (await getGeneration(scope, id)).generation;
}

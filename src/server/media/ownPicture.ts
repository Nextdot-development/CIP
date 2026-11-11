import 'server-only';
import { withCompanyScope, type CompanyScope } from '../db';
import { canCompose, preparePost } from './composePost';
import { pictureForPost } from './arrange';
import { completeGeneration, getGeneration, insertGeneration, keepScene } from './generation';
import { MediaRejected, type MediaGenerationDTO } from './types';
import { brandInRequest, companyBrands } from '../brain/brands';
import { activeBrand } from '../brain/activeBrand';

/**
 * A new post on a picture the person brought: the brand's bottle, logo and
 * headline set on it, layer by layer, for the person to arrange.
 *
 * Nothing is painted and no model is asked anything - not to plan it, not to
 * check it. The headline is the person's own words when they gave them (in
 * quotes, or after "headline:"), else one of the brand's own; the layout is
 * the brand's; the pack is the one the request names. Free.
 */
export async function postOnOwnPicture(
  scope: CompanyScope,
  input: { brand: unknown; request: unknown; ratio: unknown; picture: { bytes: Buffer; mimeType: string } },
): Promise<MediaGenerationDTO> {
  const request = typeof input.request === 'string' ? input.request.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
  // The brand sent, else the one the request names, else the one chosen at the top of the page.
  const given = typeof input.brand === 'string' ? input.brand.trim() : '';
  const brand = given
    || brandInRequest(request, (await companyBrands(scope)).map((b) => b.name))
    || (await activeBrand(scope)).active
    || '';
  if (!brand) throw new MediaRejected('Say which brand it is for - "Whytehall Honey", say - or choose the brand at the top.');
  const ratio = SHAPES[typeof input.ratio === 'string' ? input.ratio : ''] ?? 1;
  if (!(await canCompose(scope, brand))) {
    throw new MediaRejected(`CIP has no cut-out bottle for ${brand} yet, so it cannot set a post on your picture. Add the brand's bottle first.`);
  }

  const scene = await pictureForPost(input.picture, ratio);
  const prepared = await preparePost(scope, { request: request || `A post for ${brand}`, brand, ratio, generatorShape: '1:1', layered: true, noModel: true });
  const built = await prepared.finish(scene, { review: false });

  const id = await insertGeneration(scope, {
    type: 'image',
    provider: 'cip',
    model: 'your-picture',
    prompt: request || `${brand} on your own picture`,
    status: 'processing',
    inputMetadata: { aspectRatio: shapeOf(ratio), ownPicture: true },
    idempotencyKey: null,
  });
  await completeGeneration(scope, id, [{ bytes: built.bytes, mimeType: 'image/png', width: built.width, height: built.height }], {}, 'your-picture');
  const kept = await keepScene(scope, id, built.scene);
  const plan = prepared.plan;
  await withCompanyScope(scope, (tx) => tx`
    update media_generations
       set output_metadata = coalesce(output_metadata, '{}'::jsonb) || ${tx.json({ composed: {
         idea: plan.idea, layout: plan.layout.name, headline: plan.headline, variant: plan.variant, bottle: prepared.bottle,
         notes: plan.notes, risks: plan.risks, settled: plan.settled, sceneBrief: plan.scene,
         // Checked when the person asks, never on its own: nothing is spent unasked.
         autoCheck: false, ownBackground: true,
         review: built.rounds, unresolved: built.unresolved, tweaks: built.tweaks, recipe: built.recipe, scene: kept,
       } } as never)}
     where id = ${id} and company_id = ${scope.companyId}
  `);
  return (await getGeneration(scope, id)).generation;
}

/** The shapes a post on one's own picture can take, as the composer offers them. */
const SHAPES: Record<string, number> = { '1:1': 1, '4:5': 0.8, '9:16': 9 / 16, '16:9': 16 / 9, '3:2': 1.5, '2:3': 2 / 3 };
const shapeOf = (ratio: number) => Object.entries(SHAPES).find(([, r]) => Math.abs(r - ratio) < 1e-6)?.[0] ?? '1:1';

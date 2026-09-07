import { noStore, withMediaScope } from '@/server/media/http';
import { listGenerations } from '@/server/media/generation';
import { providerStatus } from '@/server/media/providers';
import type { MediaType } from '@/server/media/types';

/**
 * GET /api/media/generations
 *
 * This company's generation history, newest first. The provider status rides
 * along so the UI can say "video generation is not configured" without a
 * second request — and it reports credentials, never a credential.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withMediaScope(async (scope) => {
    const url = new URL(request.url);
    const typeParam = url.searchParams.get('type');
    const type: MediaType | null = typeParam === 'image' || typeParam === 'video' ? typeParam : null;
    const limitParam = Number(url.searchParams.get('limit'));

    const { generations } = await listGenerations(scope, {
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
      type,
    });

    return Response.json({ generations, providers: providerStatus() }, { headers: noStore });
  });
}

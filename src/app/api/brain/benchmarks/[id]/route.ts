import { noStore, withBrainScope } from '@/server/brain/http';
import { removeBenchmark } from '@/server/brain/benchmark';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** DELETE - take a creative out of the test set. */
export async function DELETE(_request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { id } = await params;
    return Response.json(await removeBenchmark(scope, id), { headers: noStore });
  });
}

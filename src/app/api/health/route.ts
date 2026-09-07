import { isRowLevelSecurityBinding, sql } from '@/server/db';
import { driveStorage } from '@/server/drive/storage';
import { embedder } from '@/server/drive/embedding';

/**
 * GET /api/health
 *
 * Reports whether the second isolation layer is actually switched on.
 *
 * PostgreSQL lets superusers and BYPASSRLS roles read through row-level
 * security, so pointing DATABASE_URL at a privileged role (Supabase's
 * `postgres`, for instance) would leave the app running on the service layer
 * alone. That is a configuration mistake nobody would notice from the UI, so
 * it is surfaced here.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await sql<{ now: Date }[]>`select now() as now`;
    const now = rows[0]?.now ?? new Date();
    const rlsBinding = await isRowLevelSecurityBinding();
    const vector = await sql<{ n: number }[]>`
      select count(*)::int n from pg_extension where extname = 'vector'
    `;
    const vectorInstalled = (vector[0]?.n ?? 0) > 0;

    return Response.json(
      {
        status: rlsBinding ? 'ok' : 'degraded',
        database: { connected: true, time: now.toISOString() },
        storage: { driver: driveStorage().name },
        embeddings: {
          // Names the driver so a deployment accidentally running the
          // deterministic fake is visible rather than silently useless.
          driver: embedder().name,
          model: embedder().model,
          dimensions: embedder().dimensions,
          pgvector: vectorInstalled ? 'installed' : 'missing',
        },
        isolation: {
          serviceLayer: 'active',
          rowLevelSecurity: rlsBinding ? 'binding' : 'bypassed',
          ...(rlsBinding
            ? {}
            : {
                warning:
                  'DATABASE_URL is using a superuser or BYPASSRLS role, so row-level ' +
                  'security is not applying. Point it at the cip_app role instead.',
              }),
        },
      },
      { status: rlsBinding ? 200 : 503, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('Health check failed:', error);
    return Response.json(
      { status: 'error', database: { connected: false } },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}

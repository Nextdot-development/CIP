import { NextResponse } from 'next/server';
import { pumpQueues } from '@/server/jobs/pump';
import { noStore } from '@/server/brain/http';

/**
 * One pass of the whole pipeline, on a schedule.
 *
 * CIP reads what it is given: extraction, chunks, vectors, understanding,
 * Brand DNA, market reports. All of that runs in `pumpQueues`, and something has
 * to call it. A file uploaded through the site nudges it once; nothing nudges a
 * file that arrives through a Google Drive sync, and nothing retries the six
 * things that were still waiting when the nudge ran out of time.
 *
 * So it is also on a clock. This is the safety net, not the plan: the worker
 * (`npm run cip:worker -- --watch`) goes round every thirty seconds and keeps
 * up with real use, while a Vercel Hobby cron fires **once a day** — their
 * limit, not a choice — and one pass does a bounded amount of work. A daily
 * pass is the difference between a backlog that drains slowly and one that
 * never drains at all.
 *
 * WHY IT IS GUARDED
 *
 * This endpoint spends money: vision calls to read assets, embedding calls to
 * make them findable. Anybody who can reach it can run up a bill, so a caller
 * has to prove it is Vercel's scheduler. CRON_SECRET is set in the project's
 * environment, Vercel sends it as a bearer token on scheduled invocations, and
 * without one configured this refuses rather than running openly.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error: 'NOT_CONFIGURED',
        message: 'Set CRON_SECRET before scheduling this. It spends money when it runs.',
      },
      { status: 503, headers: noStore },
    );
  }

  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    // No detail: an attacker learns nothing from the difference between a
    // wrong secret and a missing one.
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404, headers: noStore });
  }

  const tally = await pumpQueues();
  return NextResponse.json({ tally }, { headers: noStore });
}

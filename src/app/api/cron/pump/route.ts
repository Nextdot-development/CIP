import { NextResponse } from 'next/server';
import { pumpQueues } from '@/server/jobs/pump';
import { isSchedulerToken, recordPumpEnd, recordPumpStart, rememberPumpUrl } from '@/server/jobs/runtime';
import type { PumpTrigger } from '@/server/jobs/runtime';
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
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');

  // Two callers are let in: GitHub and Vercel with CRON_SECRET, and the
  // database's own scheduler with the token it made for itself (0051).
  let trigger: PumpTrigger | null = null;
  if (secret && bearer === secret) {
    trigger = /vercel-cron/i.test(request.headers.get('user-agent') ?? '') ? 'vercel' : 'github';
    // Where the deployment lives, as they reached it: the scheduler calls here.
    await rememberPumpUrl(new URL(request.url).origin);
  } else if (await isSchedulerToken(bearer)) {
    trigger = 'scheduler';
  }

  if (!trigger) {
    if (!secret) {
      return NextResponse.json(
        {
          error: 'NOT_CONFIGURED',
          message: 'Set CRON_SECRET before scheduling this. It spends money when it runs.',
        },
        { status: 503, headers: noStore },
      );
    }
    // No detail: an attacker learns nothing from the difference between a
    // wrong secret and a missing one.
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404, headers: noStore });
  }

  const run = await recordPumpStart(trigger);
  try {
    const tally = await pumpQueues();
    await recordPumpEnd(run, { tally });
    return NextResponse.json({ tally }, { headers: noStore });
  } catch (error) {
    await recordPumpEnd(run, { error: error instanceof Error ? error.message : 'The pass failed.' });
    throw error;
  }
}

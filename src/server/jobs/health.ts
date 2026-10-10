import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { EXTRACTABLE_TYPES } from '../drive/extraction';
import { pumpHealth } from './runtime';
import type { PumpHealth } from './runtime';

/**
 * Whether CIP is keeping up, said in a few lines.
 *
 * The pump stopped once for days and nobody knew until a person went looking.
 * This is what they would have looked for: when the background work last ran,
 * what it could not read, and which outside source has stopped answering. A
 * problem is a sentence a person can act on, not a status code.
 */

/** Past this, the background work is late, not just between passes. */
const LATE_AFTER_HOURS = 2;

export type HealthProblem = { severity: 'stop' | 'warn'; text: string; href?: string };

export type HealthReport = {
  pump: PumpHealth;
  problems: HealthProblem[];
};

export async function healthReport(scope: CompanyScope): Promise<HealthReport> {
  const [pump, counts] = await Promise.all([
    pumpHealth(),
    withCompanyScope(scope, async (tx) => {
      const [row] = await tx<{
        files_failed: number; files_stuck: number; market_unread: number; understanding_stuck: number;
      }[]>`
        select
          (select count(*)::int from drive_files
            where company_id = ${scope.companyId} and archived_at is null
              and processing_status = 'failed' and updated_at > now() - interval '7 days') as files_failed,
          (select count(*)::int from drive_files
            where company_id = ${scope.companyId} and archived_at is null
              -- Only what the pump reads: a picture or a film is never
              -- "extracted", and sits at pending by design.
              and file_type = any(${EXTRACTABLE_TYPES}) and bytes_retained
              and processing_status in ('pending', 'processing') and created_at < now() - interval '6 hours') as files_stuck,
          (select count(*)::int from market_sources
            where company_id = ${scope.companyId}
              and status in ('failed', 'no_text') and updated_at > now() - interval '7 days') as market_unread,
          (select count(*)::int from asset_understanding
            where company_id = ${scope.companyId}
              and status not in ('ready', 'failed', 'unsupported') and created_at < now() - interval '6 hours') as understanding_stuck
      `;
      const feeds = await tx<{ display_name: string; last_error: string }[]>`
        select display_name, last_error from market_feeds
         where company_id = ${scope.companyId} and enabled and last_error is not null
      `;
      return { ...row!, feeds };
    }),
  ]);

  const problems: HealthProblem[] = [];
  const hoursSince = pump.lastFinishedAt ? (Date.now() - new Date(pump.lastFinishedAt).getTime()) / 3_600_000 : null;
  if (hoursSince === null) {
    problems.push({ severity: 'warn', text: 'The background work has no recorded pass yet. New files wait until it runs.' });
  } else if (hoursSince > LATE_AFTER_HOURS) {
    problems.push({
      severity: 'stop',
      text: `The background work last ran ${Math.round(hoursSince)} hours ago. New files, filings and reports are waiting.`,
    });
  }
  if (pump.lastError) problems.push({ severity: 'warn', text: `The last background pass stopped with an error: ${pump.lastError}` });
  if (counts.files_stuck > 0) {
    problems.push({ severity: 'warn', text: `${counts.files_stuck} file${counts.files_stuck === 1 ? ' has' : 's have'} been waiting to be read for over 6 hours.`, href: '/trust' });
  }
  if (counts.files_failed > 0) {
    problems.push({ severity: 'warn', text: `${counts.files_failed} file${counts.files_failed === 1 ? '' : 's'} could not be read this week.`, href: '/trust' });
  }
  if (counts.understanding_stuck > 0) {
    problems.push({ severity: 'warn', text: `${counts.understanding_stuck} picture${counts.understanding_stuck === 1 ? ' is' : 's are'} still waiting to be looked at after 6 hours.` });
  }
  if (counts.market_unread > 0) {
    problems.push({ severity: 'warn', text: `${counts.market_unread} market report${counts.market_unread === 1 ? '' : 's'} could not be read this week.`, href: '/market' });
  }
  for (const feed of counts.feeds) {
    problems.push({ severity: 'warn', text: `${feed.display_name}'s filings: ${feed.last_error}`, href: '/market' });
  }
  return { pump, problems };
}

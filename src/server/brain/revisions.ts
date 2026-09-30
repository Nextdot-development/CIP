import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { getCheck } from './checker';
import type { CheckFlag, CreativeCheck } from './checker';

/**
 * A creative checked again after it was changed, and what changed.
 *
 * An agency sends a creative, the report goes back, a new version comes in.
 * Read on its own, the second report says what is wrong now; it cannot say
 * that three of the five faults were fixed, one was not, and a new one crept
 * in - which is the whole of what a reviewer wants to know about a revision.
 *
 * Faults are matched by the rules they break, not by their wording: the same
 * missing warning is worded differently every time a model looks at it, and
 * it is the same fault as long as it breaks the same rule.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Words that name nothing: two files called only these are not versions of one creative. */
const GENERIC = new Set([
  'whatsapp', 'video', 'image', 'img', 'screenshot', 'chatgpt', 'photo', 'pic', 'vid', 'file',
  'untitled', 'design', 'creative', 'banner', 'post', 'at', 'am', 'pm', 'dsc', 'pxl', 'mov', 'clip',
]);

/**
 * A file name with its version marks taken off, or null when what is left
 * names nothing in particular.
 *
 * "Diwali_banner_v2.png", "Diwali banner FINAL (1).png" and "diwali-banner.jpg"
 * are one creative. "WhatsApp Video 2026-09-26 at 11.52.21 AM.mp4" and every
 * other WhatsApp video are not: once the date and time are gone nothing is
 * left to tell them apart, so they are never matched by name.
 */
export function normaliseName(name: string): string | null {
  const words = name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')
    .replace(/\d{4}[-_.]\d{2}[-_.]\d{2}/g, ' ')
    .replace(/\d{1,2}[.:_]\d{2}([.:_]\d{2})?\s*(am|pm)?/g, ' ')
    // "_v2" is not a word boundary until the underscore is a space.
    .replace(/[_-]+/g, ' ')
    .replace(/\(\d+\)/g, ' ')
    .replace(/\b(v|ver|version|rev|r)\s*\d+\b/g, ' ')
    .replace(/\b(final|draft|new|latest|revised|updated|copy|edited|edit|fixed|approved)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0 && !/^\d+$/.test(w));
  const meaningful = words.filter((w) => !GENERIC.has(w));
  return meaningful.length > 0 ? words.join(' ') : null;
}

export type RevisionFlag = { message: string; rule: string | null };

export type Revision = {
  /** The earlier check it is compared with. Null when there is none to compare with. */
  against: { id: string; subject: string; score: number | null; createdAt: string; chosen: boolean } | null;
  /** Earlier checks of this brand a person could compare with instead. */
  candidates: { id: string; subject: string; score: number | null; createdAt: string }[];
  scoreBefore: number | null;
  scoreNow: number | null;
  /** Broken before, not now. */
  fixed: RevisionFlag[];
  /** Broken before and still broken. */
  stillOpen: RevisionFlag[];
  /** Broken now and not before. */
  added: RevisionFlag[];
};

/** The rules a flag breaks, as the keys it is matched on. */
function keysOf(flag: CheckFlag): string[] {
  const rules = [flag.citedRule?.id, ...(flag.alsoRules ?? []).map((r) => r.id)].filter(Boolean) as string[];
  if (rules.length > 0) return rules.map((id) => `r:${id}`);
  return flag.citedFact ? [`f:${flag.citedFact.id}`] : [`m:${flag.message}`];
}

function asRevisionFlag(flag: CheckFlag): RevisionFlag {
  return { message: flag.message, rule: flag.citedRule?.rule ?? null };
}

/** What changed between two checks, fault by fault. Disputed flags are not faults. */
export function diffChecks(before: CreativeCheck, now: CreativeCheck): Pick<Revision, 'fixed' | 'stillOpen' | 'added'> {
  const open = (c: CreativeCheck) => c.flags.filter((f) => f.status !== 'disputed');
  const was = open(before);
  const is = open(now);
  const overlaps = (a: CheckFlag, b: CheckFlag) => {
    const keys = new Set(keysOf(a));
    return keysOf(b).some((k) => keys.has(k));
  };
  return {
    fixed: was.filter((w) => !is.some((i) => overlaps(w, i))).map(asRevisionFlag),
    stillOpen: is.filter((i) => was.some((w) => overlaps(w, i))).map(asRevisionFlag),
    added: is.filter((i) => !was.some((w) => overlaps(w, i))).map(asRevisionFlag),
  };
}

/**
 * This check next to the version before it.
 *
 * The earlier version is the one a person picked, or failing that one found
 * for them: the same file checked again, or a file whose name is the same
 * once "v2", "final" and "(1)" are taken off. Nothing is guessed beyond that -
 * comparing a creative with the wrong one reports faults "fixed" that were
 * never there.
 */
export async function compareWithEarlier(
  scope: CompanyScope,
  checkId: string,
  withId: string | null = null,
): Promise<Revision | null> {
  const now = await getCheck(scope, checkId);
  if (!now) return null;
  const isPdf = (subject: string) => /\.pdf$/i.test(subject);

  const rows = await withCompanyScope(scope, (tx) =>
    tx<{ id: string; file_id: string | null; subject: string | null; score: number | null; created_at: Date }[]>`
      select c.id, c.file_id, f.name as subject, c.score, c.created_at
        from creative_checks c
        left join drive_files f on f.id = c.file_id and f.company_id = c.company_id
       where c.company_id = ${scope.companyId}
         and c.status = 'ready'
         and c.id <> ${now.id}
         and c.created_at < ${new Date(now.createdAt)}
         and (${now.brand}::text is null or c.brand = ${now.brand}::text)
       order by c.created_at desc
       limit 40
    `,
  );
  const candidates = rows
    .filter((r) => !isPdf(r.subject ?? ''))
    .slice(0, 15)
    .map((r) => ({ id: r.id, subject: r.subject ?? 'Generated creative', score: r.score, createdAt: r.created_at.toISOString() }));

  const empty = { candidates, scoreBefore: null, scoreNow: now.score, fixed: [], stillOpen: [], added: [] };

  let chosenId: string | null = null;
  let chosen = false;
  if (withId && UUID.test(withId)) {
    chosenId = withId;
    chosen = true;
  } else if (!isPdf(now.subject)) {
    const name = normaliseName(now.subject);
    const match = rows.find(
      (r) =>
        !isPdf(r.subject ?? '') &&
        ((now.fileId !== null && r.file_id === now.fileId) || (name !== null && normaliseName(r.subject ?? '') === name)),
    );
    chosenId = match?.id ?? null;
  }
  if (!chosenId) return { against: null, ...empty };

  // Read through the same scope: another company's check is simply not found.
  const before = await getCheck(scope, chosenId);
  if (!before || before.id === now.id) return { against: null, ...empty };

  return {
    against: { id: before.id, subject: before.subject, score: before.score, createdAt: before.createdAt, chosen },
    candidates,
    scoreBefore: before.score,
    scoreNow: now.score,
    ...diffChecks(before, now),
  };
}

import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';

/**
 * What to make, and when, and for where.
 *
 * CIP could answer "make something for 8PM in Nigeria" and had no idea that
 * Nigeria's Independence Day is the first of October, or that the brief should
 * have been written three weeks before it. The calendar lived in a spreadsheet
 * somebody opened in January and nobody opened again.
 *
 * What makes this worth having inside CIP rather than in the sheet: an
 * occasion already knows its market, so a brief started from one draws on that
 * market's knowledge and no other. That is the whole point of markets, and
 * until now nothing connected the two.
 */

export type Occasion = {
  id: string;
  occasion: string;
  market: string | null;
  brand: string | null;
  startsOn: string;
  endsOn: string;
  kind: 'public_holiday' | 'observance' | 'season' | 'campaign';
  languages: string[];
  note: string | null;
  source: 'manual' | 'imported' | 'suggested';
  /** Days from today. Negative for something already past. */
  daysAway: number;
};

/** What a new occasion needs. */
export type NewOccasion = {
  occasion: string;
  startsOn: string;
  endsOn?: string;
  market?: string | null;
  brand?: string | null;
  kind?: Occasion['kind'];
  languages?: readonly string[];
  note?: string | null;
  source?: Occasion['source'];
};

const ROW_TO_OCCASION = (row: {
  id: string; occasion: string; market: string | null; brand: string | null;
  starts_on: Date; ends_on: Date; kind: Occasion['kind']; languages: string[] | null;
  note: string | null; source: Occasion['source']; days_away: number;
}): Occasion => ({
  id: row.id,
  occasion: row.occasion,
  market: row.market,
  brand: row.brand,
  startsOn: row.starts_on.toISOString().slice(0, 10),
  endsOn: row.ends_on.toISOString().slice(0, 10),
  kind: row.kind,
  languages: row.languages ?? [],
  note: row.note,
  source: row.source,
  daysAway: row.days_away,
});

/**
 * What is coming, soonest first.
 *
 * Includes anything still running today, because a season somebody is halfway
 * through is exactly the thing they are making work for.
 */
export async function upcoming(
  scope: CompanyScope,
  options: { withinDays?: number; market?: string | null; limit?: number } = {},
): Promise<Occasion[]> {
  const within = Math.min(Math.max(options.withinDays ?? 90, 1), 400);
  const market = options.market ?? null;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<Parameters<typeof ROW_TO_OCCASION>[0][]>`
      select id, occasion, market, brand, starts_on, ends_on, kind, languages, note, source,
             (starts_on - current_date)::int as days_away
        from content_calendar
       where company_id = ${scope.companyId}
         -- Still to come, or still running.
         and ends_on >= current_date
         -- Cast, because a bare parameter has no type and "date + unknown"
         -- is ambiguous to the planner rather than an error it can fix.
         and starts_on <= current_date + ${within}::int
         -- An occasion with no market belongs to every market, exactly as a
         -- fact with no brand belongs to every brand.
         and (${market}::text is null or market is null or market = ${market})
       order by starts_on, occasion
       limit ${limit}
    `;
    return rows.map(ROW_TO_OCCASION);
  });
}

/** Everything on the calendar, for the year view. */
export async function allOccasions(
  scope: CompanyScope,
  options: { from?: string; to?: string } = {},
): Promise<Occasion[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<Parameters<typeof ROW_TO_OCCASION>[0][]>`
      select id, occasion, market, brand, starts_on, ends_on, kind, languages, note, source,
             (starts_on - current_date)::int as days_away
        from content_calendar
       where company_id = ${scope.companyId}
         and (${options.from ?? null}::date is null or starts_on >= ${options.from ?? null}::date)
         and (${options.to ?? null}::date is null or starts_on <= ${options.to ?? null}::date)
       order by starts_on, market nulls first, occasion
       limit 500
    `;
    return rows.map(ROW_TO_OCCASION);
  });
}

/**
 * Puts one occasion on the calendar.
 *
 * Idempotent on the same occasion, date and market, so importing a year twice
 * leaves one of each rather than two. An import never overwrites a note
 * somebody typed: what was entered by hand is worth more than what was loaded
 * from a file.
 */
export async function addOccasion(
  scope: CompanyScope,
  input: NewOccasion,
): Promise<boolean> {
  const occasion = input.occasion.trim().slice(0, 200);
  if (occasion.length === 0) return false;

  const languages = [...new Set((input.languages ?? []).map((l) => l.trim()).filter(Boolean))];

  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into content_calendar
        (company_id, occasion, market, brand, starts_on, ends_on, kind, languages, note, source, created_by)
      values
        (${scope.companyId}, ${occasion}, ${input.market?.trim() || null},
         ${input.brand?.trim() || null}, ${input.startsOn}::date,
         ${(input.endsOn ?? input.startsOn)}::date, ${input.kind ?? 'observance'},
         ${languages}, ${input.note?.trim() || null}, ${input.source ?? 'manual'},
         ${scope.userId})
      on conflict (company_id, occasion, starts_on, coalesce(market, ''))
        do update set
          ends_on   = excluded.ends_on,
          kind      = excluded.kind,
          languages = case when cardinality(excluded.languages) > 0
                           then excluded.languages else content_calendar.languages end,
          -- A typed note survives an import; an import can only fill an empty one.
          note      = coalesce(content_calendar.note, excluded.note),
          updated_at = now()
      returning id
    `;
    return rows.length > 0;
  });
}

/** Takes an occasion off the calendar. */
export async function removeOccasion(scope: CompanyScope, id: string): Promise<boolean> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      delete from content_calendar
       where id = ${id} and company_id = ${scope.companyId}
      returning id
    `;
    return rows.length > 0;
  });
}

/**
 * The request text an occasion implies, for handing to the planner.
 *
 * Deliberately plain. The occasion, the market and the brand are what the
 * planner needs to pick the right knowledge; everything about how it should
 * look comes from that knowledge, not from a sentence written here.
 */
export function requestFor(occasion: Occasion): string {
  const parts = [`A ${occasion.kind === 'season' ? 'piece for' : 'post for'} ${occasion.occasion}`];
  if (occasion.brand) parts.push(`for ${occasion.brand}`);
  if (occasion.market) parts.push(`for ${occasion.market}`);
  if (occasion.languages.length > 0) parts.push(`in ${occasion.languages.join(' and ')}`);
  return parts.join(' ');
}

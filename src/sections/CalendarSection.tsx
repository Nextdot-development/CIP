'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '../components/ui/Bits';
import type { Occasion } from '@/server/brain/calendar';

/**
 * The Social Calendar, one row per occasion, as the prototype lays it out.
 *
 * A dry day is on the calendar as much as a festival is, and louder: on those
 * days the right amount of alcohol content is none, and a calendar that only
 * listed things to celebrate is how somebody schedules a post into one.
 */
const KIND_LABEL: Record<Occasion['kind'], string> = {
  public_holiday: 'Holiday',
  observance: 'Observance',
  season: 'Season',
  campaign: 'Campaign',
  restricted: 'Dry day — publish nothing',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y: y ?? 0, m: (m ?? 1) - 1, d: d ?? 1 };
}

/** "14 Mar 2026", "14–16 Mar 2026" or "28 Feb – 2 Mar 2026". */
function range(startsOn: string, endsOn: string): string {
  const a = parts(startsOn);
  const b = parts(endsOn);
  if (startsOn === endsOn) return `${a.d} ${MONTHS[a.m]} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m]} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS[a.m]} – ${b.d} ${MONTHS[b.m]} ${a.y}`;
  return `${a.d} ${MONTHS[a.m]} ${a.y} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
}

function when(occasion: Occasion): string {
  if (occasion.daysAway <= 0) return 'On now';
  if (occasion.daysAway === 1) return 'Tomorrow';
  if (occasion.daysAway < 14) return `In ${occasion.daysAway} days`;
  if (occasion.daysAway < 60) return `In ${Math.round(occasion.daysAway / 7)} weeks`;
  return `In ${Math.round(occasion.daysAway / 30)} months`;
}

export function CalendarSection({
  occasions,
  brand,
  today,
}: {
  occasions: Occasion[];
  brand: string | null;
  today: string;
}) {
  const markets = useMemo(
    () => [...new Set(occasions.map((o) => o.market).filter((m): m is string => Boolean(m)))].sort(),
    [occasions],
  );
  const [market, setMarket] = useState<string | null>(null);
  const [hideDry, setHideDry] = useState(false);

  const inMarket = (o: Occasion) => !market || !o.market || o.market === market;
  const visible = occasions.filter((o) => inMarket(o) && (!hideDry || o.kind !== 'restricted'));
  const dryDays = occasions.filter((o) => inMarket(o) && o.kind === 'restricted').length;

  // Something already running is filed under this month, not the one it began in.
  const months = new Map<string, Occasion[]>();
  for (const occasion of visible) {
    const { y, m } = parts(occasion.startsOn < today ? today : occasion.startsOn);
    const key = `${MONTHS[m]} ${y}`;
    months.set(key, [...(months.get(key) ?? []), occasion]);
  }

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Social Calendar</p>
        <h1>Social Media Calendar{brand ? ` — ${brand}` : ''}</h1>
        <p className="lede">
          What is coming in each market, from the company&apos;s own calendar: festivals, seasons,
          campaigns, and the dry days when nothing showing a drink should go out.
        </p>
      </header>

      {occasions.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="Nothing on the calendar yet"
          copy="Import a market's calendar or add occasions, and they appear here in date order, with the days to publish nothing marked."
        />
      ) : (
        <>
          <div className="calfilters" role="group" aria-label="Market">
            <button
              type="button"
              className={`chip ${market === null ? 'is-on' : ''}`}
              aria-pressed={market === null}
              onClick={() => setMarket(null)}
            >
              Every market
            </button>
            {markets.map((m) => (
              <button
                key={m}
                type="button"
                className={`chip ${market === m ? 'is-on' : ''}`}
                aria-pressed={market === m}
                onClick={() => setMarket(m)}
              >
                {m}
              </button>
            ))}
            {dryDays > 0 && (
              <label className="caltoggle" htmlFor="cal-hide-dry">
                <input
                  id="cal-hide-dry"
                  type="checkbox"
                  checked={hideDry}
                  onChange={(e) => setHideDry(e.target.checked)}
                />
                Hide {dryDays} dry day{dryDays === 1 ? '' : 's'}
              </label>
            )}
          </div>

          {[...months.entries()].map(([month, list]) => (
            <section key={month} className="calmonth" aria-label={month}>
              <h2 className="calmonth-title">{month}</h2>
              {list.map((occasion) => (
                <article key={occasion.id} className={`calrow ${occasion.kind === 'restricted' ? 'is-dry' : ''}`}>
                  <div className="caldate">
                    {range(occasion.startsOn, occasion.endsOn)}
                    <span className="calwhen">{when(occasion)}</span>
                  </div>
                  <div className="calidea">
                    <p className="t">{occasion.occasion}</p>
                    <p className="d">
                      {[
                        occasion.market ?? 'Every market',
                        occasion.brand,
                        occasion.languages.length ? occasion.languages.join(', ') : null,
                        occasion.note,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <div className="calfmt">{KIND_LABEL[occasion.kind]}</div>
                </article>
              ))}
            </section>
          ))}
          {visible.length === 0 && <p className="small muted">Nothing coming up for this market.</p>}
        </>
      )}
    </div>
  );
}

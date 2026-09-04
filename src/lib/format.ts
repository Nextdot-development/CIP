/**
 * Turning clean data into readable text.
 *
 * The server sends ISO timestamps and minor-unit money; the words a person
 * reads are made here. That is what lets one row serve a rupee total, a
 * relative date and a percentage without the database storing any of them.
 */

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const DAY = 24 * 60 * 60 * 1000;

/** Whole days from now — negative for the past. */
export function daysFrom(iso: string, now: Date = new Date()): number {
  return Math.round((new Date(iso).getTime() - now.getTime()) / DAY);
}

/** "2 days ago", "tomorrow", "in 3 days". */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const days = daysFrom(iso, now);
  if (Math.abs(days) < 31) return rtf.format(days, 'day');
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  );
}

/** "April 2025" from a period date. */
export function monthLabel(isoDate: string): string {
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );
}

/**
 * Indian money, at the scale people actually say it: lakhs above ₹1,00,000,
 * exact rupees below. Input is always minor units so nothing rounds twice.
 */
export function money(amountMinor: number, currency = 'INR'): string {
  const major = amountMinor / 100;
  if (currency === 'INR' && major >= 100000) {
    const lakhs = major / 100000;
    return `₹${lakhs.toFixed(lakhs >= 10 ? 0 : 1)}L`;
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(major);
}

/** "24" or "40%", from a numeric value and its unit. */
export function metricValue(value: number, unit: 'count' | 'percent'): string {
  return unit === 'percent' ? `${value}%` : new Intl.NumberFormat('en-IN').format(value);
}

/** "+20% vs March", "+3 vs March", or nothing when there is no comparison. */
export function metricDelta(
  delta: number | null,
  unit: 'count' | 'percent' | null,
  note: string | null,
): string | null {
  if (delta === null || delta === 0) return note;
  const sign = delta > 0 ? '+' : '';
  const value = unit === 'percent' ? `${sign}${delta}%` : `${sign}${delta}`;
  return note ? `${value} ${note}` : value;
}

/** Two letters for an avatar. Handles "Dr. Kavya Rao" without giving "DK". */
export function initials(fullName: string): string {
  const words = fullName
    .replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** First name, for the greeting. */
export function firstName(fullName: string): string {
  const stripped = fullName.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '');
  return stripped.split(/\s+/)[0] ?? stripped;
}

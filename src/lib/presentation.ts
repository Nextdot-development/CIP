import type * as W from '@/types/workspace';
import type { IconName } from '@/components/ui/Icon';
import { daysFrom, firstName, initials, metricDelta, metricValue, money, monthLabel, relativeDay } from './format';

/**
 * Everything the screens need to draw, derived from the workspace payload.
 *
 * Avatar gradients, request thumbnails and icon glyphs used to be stored on
 * each company. They are presentation, so they live here instead — the same
 * person always gets the same colours because the stops are picked from a
 * fixed palette by a hash of their id, not by a column in the database.
 */

export type Duo = [string, string];

const AVATAR_TINTS: Duo[] = [
  ['#8B5CF6', '#4C1D95'],
  ['#2563EB', '#1E3A8A'],
  ['#0E9F6E', '#065F46'],
  ['#F97316', '#9A3412'],
  ['#E11D48', '#881337'],
  ['#0891B2', '#164E63'],
];

const THUMB_TINTS: Duo[] = [
  ['#7C4DFF', '#3B1E8C'],
  ['#F59E0B', '#B45309'],
  ['#EC4899', '#9D174D'],
  ['#0EA5E9', '#0C4A6E'],
  ['#0E9F6E', '#065F46'],
  ['#64748B', '#1E293B'],
];

const COST_COLORS = ['#7C4DFF', '#EC4899', '#0EA5E9', '#94A3B8', '#0E9F6E'];

/** Stable, so a person or a request keeps its colour between page loads. */
function pick<T>(list: T[], key: string): T {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return list[h % list.length]!;
}

const KIND_ICON: Record<W.RequestKind, IconName> = {
  image: 'image',
  video: 'video',
  doc: 'doc',
  grid: 'grid',
};

const TOPIC_ICON: Record<string, IconName> = {
  assets: 'palette',
  guidelines: 'book',
  voice: 'voice',
  products: 'box',
  knowledge: 'sparkle',
  sources: 'link',
};

const METRIC_ICON: Record<string, IconName> = {
  assets_delivered: 'image',
  campaigns: 'megaphone',
  blocked: 'alert',
  turnaround_gain: 'bolt',
};

export type PodMemberView = { id: string; name: string; initials: string; craft: string; bio: string; tint: Duo };
export type RequestView = { id: string; title: string; summary: string; status: W.WorkStatus; when: string; tint: Duo; icon: IconName };
export type MetricView = { id: string; label: string; value: string; note: string | null; delta: string | null; tone: W.MetricTone; icon: IconName };

export type WorkspaceView = ReturnType<typeof toView>;

export function toView(w: W.WorkspaceDTO, now: Date = new Date()) {
  const crafts = w.pod.map((p) => p.craft.toLowerCase());
  const mentions = (word: string) => crafts.some((c) => c.includes(word));
  const podBlurb = [
    'Strategy, creative',
    mentions('medical') ? ', medical' : '',
    ' and compliance experts, working with you.',
  ].join('');

  const costTotal = w.trust.cost.lines.reduce((sum, l) => sum + l.amountMinor, 0);

  return {
    id: w.company.id,
    name: w.company.name,
    legalName: w.company.legalName,
    industry: w.company.industry,
    logoUrl: w.company.logoUrl,

    user: {
      name: w.viewer.fullName,
      firstName: firstName(w.viewer.fullName),
      initials: initials(w.viewer.fullName),
      email: w.viewer.email,
      role: w.viewer.role,
      roleLabel: roleLabel(w.viewer.role),
    },

    branding: {
      primary: w.branding.primaryColor,
      deep: w.branding.deepColor,
      nav: w.branding.navTheme,
      // The mark sits on the company's own colour in a light nav, and on a
      // translucent tile in a dark one.
      markBg: w.branding.navTheme === 'dark' ? '#141018' : withAlpha(w.branding.primaryColor, 0.12),
      markFg: w.branding.navTheme === 'dark' ? '#FFFFFF' : w.branding.primaryColor,
    },
    hero: w.branding.hero,

    composerPlaceholder: w.brand.composerPlaceholder,
    promptSuggestions: w.brand.promptSuggestions,

    pod: {
      blurb: podBlurb,
      members: w.pod.map<PodMemberView>((p) => ({
        id: p.id,
        name: p.fullName,
        initials: initials(p.fullName),
        craft: p.craft,
        bio: p.bio,
        tint: pick(AVATAR_TINTS, p.id),
      })),
    },

    brandBrain: {
      understanding: w.brand.understandingPct,
      unlockAt: w.brand.paidUnlockPct,
      headline: w.brand.headline,
      note: w.brand.note,
      unlocks: w.brand.unlocks.map((u) => ({ label: u.label, at: u.atPct })),
      topics: w.brand.topics.map((t) => ({
        id: t.id,
        title: t.title,
        blurb: t.blurb,
        cta: t.cta,
        icon: TOPIC_ICON[t.key] ?? 'sparkle',
        items: t.items,
      })),
      confirmations: w.brand.confirmations,
      voice: { sounds: w.brand.voice.sounds, neverSounds: w.brand.voice.never },
      palette: w.brand.palette,
    },

    requests: w.requests.map<RequestView>((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      status: r.status,
      when: relativeDay(r.completedAt ?? r.dueAt ?? r.submittedAt, now),
      tint: pick(THUMB_TINTS, r.id),
      icon: KIND_ICON[r.kind],
    })),

    month: {
      label: monthLabel(w.month.period),
      metrics: w.month.metrics.map<MetricView>((m) => ({
        id: m.id,
        label: m.label,
        value: metricValue(m.value, m.unit),
        note: m.note,
        delta: metricDelta(m.delta, m.deltaUnit, m.deltaNote),
        tone: m.tone,
        icon: METRIC_ICON[m.key] ?? 'sparkle',
      })),
    },

    trust: {
      work: w.trust.work,
      rights: w.trust.rights.map((r) => ({
        id: r.id,
        title: r.title,
        note: r.note,
        daysLeft: Math.max(0, daysFrom(r.expiresAt, now)),
      })),
      checks: w.trust.checks,
      learnings: w.trust.learnings,
      cost: {
        total: money(costTotal, w.trust.cost.currency),
        note: 'This month, across everything your pod delivered.',
        split: w.trust.cost.lines.map((l, i) => ({
          label: l.label,
          amount: money(l.amountMinor, w.trust.cost.currency),
          pct: costTotal === 0 ? 0 : Math.round((l.amountMinor / costTotal) * 100),
          color: COST_COLORS[i % COST_COLORS.length]!,
        })),
      },
    },
  };
}

function roleLabel(role: W.CompanyRole): string {
  return { owner: 'Owner', admin: 'Admin', member: 'Team member', viewer: 'Viewer' }[role];
}

/** Hex to rgba, for tinting a mark in the company's own colour. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const n = parseInt(clean.length === 3 ? clean.replace(/./g, (c) => c + c) : clean, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

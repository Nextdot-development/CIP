/**
 * What the server sends the browser.
 *
 * Deliberately free of presentation: no gradient stops, no icon names, no
 * formatted dates or money. Timestamps are ISO strings, money is minor units
 * with a currency, percentages are numbers. src/lib/presentation.ts turns this
 * into the view model the CIP screens render.
 */

export type WorkStatus = 'completed' | 'in_progress' | 'in_review' | 'blocked' | 'scheduled';
export type RequestKind = 'image' | 'video' | 'doc' | 'grid';
export type MetricTone = 'brand' | 'ok' | 'warn' | 'stop' | 'neutral';
export type CheckState = 'pass' | 'attention' | 'fail';
export type ReasonTone = 'stop' | 'warn' | 'info';
export type CompanyRole = 'owner' | 'admin' | 'member' | 'viewer';

export type CompanyDTO = {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  industry: string | null;
  logoUrl: string | null;
};

export type BrandingDTO = {
  primaryColor: string;
  deepColor: string;
  navTheme: 'light' | 'dark';
  hero: { title: string; subtitle: string; from: string; to: string; glow: string; ink: string };
};

export type ViewerDTO = { id: string; fullName: string; email: string; role: CompanyRole };

export type PodMemberDTO = {
  id: string;
  fullName: string;
  craft: string;
  bio: string;
  avatarUrl: string | null;
};

export type RequestDTO = {
  id: string;
  title: string;
  summary: string;
  status: WorkStatus;
  kind: RequestKind;
  submittedAt: string;
  dueAt: string | null;
  completedAt: string | null;
};

export type BrandDTO = {
  understandingPct: number;
  paidUnlockPct: number;
  headline: string;
  note: string;
  composerPlaceholder: string;
  promptSuggestions: string[];
  voice: { sounds: string[]; never: string[] };
  unlocks: { id: string; label: string; atPct: number }[];
  topics: { id: string; key: string; title: string; blurb: string; cta: string; items: { label: string; done: boolean }[] }[];
  confirmations: { id: string; question: string; context: string; suggestion: string }[];
  palette: { id: string; name: string; hex: string }[];
};

export type MetricDTO = {
  id: string;
  key: string;
  label: string;
  value: number;
  unit: 'count' | 'percent';
  note: string | null;
  delta: number | null;
  deltaUnit: 'count' | 'percent' | null;
  deltaNote: string | null;
  tone: MetricTone;
};

export type WorkItemDTO = {
  id: string;
  title: string;
  meta: string;
  status: WorkStatus;
  reason: { tone: ReasonTone; text: string } | null;
  fixes: string[];
  ownerName: string | null;
};

export type WorkspaceDTO = {
  company: CompanyDTO;
  branding: BrandingDTO;
  viewer: ViewerDTO;
  pod: PodMemberDTO[];
  brand: BrandDTO;
  requests: RequestDTO[];
  month: { period: string; metrics: MetricDTO[] };
  trust: {
    work: WorkItemDTO[];
    rights: { id: string; title: string; note: string; expiresAt: string }[];
    checks: { id: string; name: string; note: string; state: CheckState }[];
    learnings: { id: string; text: string; effect: string }[];
    cost: { currency: string; lines: { id: string; label: string; amountMinor: number }[] };
  };
};

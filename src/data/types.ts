/**
 * Tenant data contract.
 *
 * Everything the client app renders comes from one Tenant object. When the
 * backend arrives, `getTenant()` becomes an API call and nothing in the UI
 * layer has to change. No component reads another company's data — the whole
 * workspace is resolved once, from the logged-in user.
 */

export type Status = 'completed' | 'in_progress' | 'in_review' | 'blocked' | 'scheduled';

export type Person = {
  id: string;
  name: string;
  initials: string;
  /** Plain-language craft, never a job code. */
  craft: string;
  bio: string;
  /** Avatar gradient stops. */
  tint: [string, string];
};

export type RequestItem = {
  id: string;
  title: string;
  summary: string;
  status: Status;
  when: string;
  /** Thumbnail gradient stops — stands in for the real asset preview. */
  tint: [string, string];
  icon: 'image' | 'video' | 'doc' | 'grid';
};

export type Metric = {
  label: string;
  value: string;
  /** Always explains what the number means. */
  note?: string;
  delta?: string;
  tone: 'brand' | 'ok' | 'warn' | 'stop' | 'neutral';
  icon: 'image' | 'megaphone' | 'alert' | 'bolt';
};

export type TeachTopic = {
  id: string;
  title: string;
  blurb: string;
  icon: 'palette' | 'book' | 'voice' | 'box' | 'sparkle' | 'link';
  items: { label: string; done: boolean }[];
  cta: string;
};

export type Confirmation = {
  id: string;
  question: string;
  context: string;
  suggestion: string;
};

export type WorkItem = {
  id: string;
  title: string;
  meta: string;
  status: Status;
  /** Only ever set when the work genuinely cannot ship. */
  reason?: { tone: 'stop' | 'warn' | 'info'; text: string };
  fixes?: string[];
  owner?: string;
};

export type RightsItem = {
  id: string;
  title: string;
  note: string;
  daysLeft: number;
};

export type CheckItem = {
  id: string;
  name: string;
  note: string;
  state: 'pass' | 'attention' | 'fail';
};

export type Learning = { id: string; text: string; effect: string };

export type Tenant = {
  id: string;
  name: string;
  legalName: string;
  industry: string;
  /** The signed-in user for this workspace (demo stand-in for auth). */
  user: { name: string; firstName: string; initials: string; role: string; email: string };
  branding: {
    primary: string;
    deep: string;
    soft: string;
    tint: string;
    /** 'light' or 'dark' navigation, chosen to suit the brand. */
    nav: 'light' | 'dark';
    markBg: string;
    markFg: string;
    logo: 'moments' | 'health' | 'monogram';
  };
  hero: {
    from: string;
    to: string;
    glow: string;
    ink: string;
    title: string;
    subtitle: string;
  };
  composerPlaceholder: string;
  promptSuggestions: string[];
  pod: { blurb: string; members: Person[] };
  brandBrain: {
    understanding: number;
    unlockAt: number;
    headline: string;
    note: string;
    unlocks: { label: string; at: number }[];
    topics: TeachTopic[];
    confirmations: Confirmation[];
    voice: { sounds: string[]; neverSounds: string[] };
    palette: { name: string; hex: string }[];
  };
  requests: RequestItem[];
  month: { label: string; metrics: Metric[] };
  trust: {
    work: WorkItem[];
    rights: RightsItem[];
    checks: CheckItem[];
    learnings: Learning[];
    cost: { total: string; note: string; split: { label: string; pct: number; color: string; amount: string }[] };
  };
};

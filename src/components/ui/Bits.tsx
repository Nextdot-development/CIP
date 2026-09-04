import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import type { WorkStatus } from '@/types/workspace';

/* ---------- Avatar ---------- */
export function Avatar({
  initials,
  tint,
  size = 'md',
  title,
}: {
  initials: string;
  tint: [string, string];
  size?: 'sm' | 'md' | 'lg';
  title?: string;
}) {
  const style = { '--a1': tint[0], '--a2': tint[1] } as CSSProperties;
  return (
    <span className={`avatar ${size}`} style={style} title={title} aria-hidden={!title}>
      {initials}
    </span>
  );
}

/* ---------- Company logo mark ----------
   An uploaded logo when the company has one, and a drawn monogram until it
   does. The old version switched on a hardcoded union of company names, which
   meant a third company needed a code change. */
export function LogoMark({
  name,
  logoUrl,
  bg,
  fg,
  size = 'md',
}: {
  name: string;
  logoUrl?: string | null;
  bg: string;
  fg: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const style = { '--mark-bg': bg, '--mark-fg': fg } as CSSProperties;

  if (logoUrl) {
    return (
      <span className={`logo-mark ${size}`} style={style}>
        <img src={logoUrl} alt="" className="logo-img" />
      </span>
    );
  }

  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <span className={`logo-mark ${size}`} style={style} aria-hidden="true">
      <span className="logo-letters">{letters}</span>
    </span>
  );
}

/* ---------- Status ----------
   The colour rule lives here so it cannot drift:
   red only ever means "this cannot be shipped". */
const STATUS: Record<WorkStatus, { label: string; cls: string }> = {
  completed: { label: 'Completed', cls: 'pill-ok' },
  in_progress: { label: 'In Progress', cls: 'pill-info' },
  in_review: { label: 'In Review', cls: 'pill-warn' },
  blocked: { label: 'Blocked', cls: 'pill-stop' },
  scheduled: { label: 'Scheduled', cls: 'pill-neutral' },
};

export function StatusPill({ status }: { status: WorkStatus }) {
  const s = STATUS[status] ?? STATUS.scheduled;
  return <span className={`pill ${s.cls}`}>{s.label}</span>;
}

export function Pill({ tone = 'neutral', children }: { tone?: 'ok' | 'warn' | 'stop' | 'info' | 'brand' | 'neutral'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/* ---------- Progress ---------- */
export function Progress({ value, goal }: { value: number; goal?: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${value}%` }} />
      {goal !== undefined && <span className="goal" style={{ left: `${goal}%` }} />}
    </div>
  );
}

/* ---------- Empty state ----------
   Never says "nothing here". It says what to do next. */
export function EmptyState({
  icon = 'sparkle',
  title,
  copy,
  action,
}: {
  icon?: IconName;
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="glyph">
        <Icon name={icon} size={22} />
      </span>
      <h4>{title}</h4>
      <p>{copy}</p>
      {action}
    </div>
  );
}

/* ---------- Card ---------- */
export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="card-head">
          <h3>{title}</h3>
          {action}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function LinkCta({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" className="link-cta" onClick={onClick}>
      {children}
      <Icon name="arrow-right" size={15} />
    </button>
  );
}

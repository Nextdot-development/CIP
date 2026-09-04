import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import type { Status } from '../../data/types';

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
   Each tenant gets a drawn mark, not a stock image, so the workspace looks
   like the company the moment it loads. */
export function LogoMark({
  logo,
  bg,
  fg,
  size = 'md',
}: {
  logo: 'moments' | 'health' | 'monogram';
  bg: string;
  fg: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const px = size === 'sm' ? 18 : size === 'lg' ? 28 : 22;
  const style = { '--mark-bg': bg, '--mark-fg': fg } as CSSProperties;
  return (
    <span className={`logo-mark ${size}`} style={style}>
      {logo === 'health' ? (
        <svg width={px} height={px} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M10 3h4v3.6l3.1-1.8 2 3.5-3.1 1.8 3.1 1.8-2 3.5L14 13.6V21h-4v-7.4l-3.1 1.8-2-3.5L8 10.1 4.9 8.3l2-3.5L10 6.6z" />
        </svg>
      ) : logo === 'moments' ? (
        <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4v5" />
          <path d="M8.5 3.2 12 8.6l3.5-5.4" />
          <path d="M9 9h6l1.6 4.6a4.8 4.8 0 0 1-4.6 6.4 4.8 4.8 0 0 1-4.6-6.4z" />
        </svg>
      ) : (
        <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M16 8a5.5 5.5 0 1 0 0 8" />
        </svg>
      )}
    </span>
  );
}

/* ---------- Status ----------
   The colour rule lives here so it cannot drift:
   red only ever means "this cannot be shipped". */
const STATUS: Record<Status, { label: string; cls: string }> = {
  completed: { label: 'Completed', cls: 'pill-ok' },
  in_progress: { label: 'In Progress', cls: 'pill-info' },
  in_review: { label: 'In Review', cls: 'pill-warn' },
  blocked: { label: 'Blocked', cls: 'pill-stop' },
  scheduled: { label: 'Scheduled', cls: 'pill-neutral' },
};

export function StatusPill({ status }: { status: Status }) {
  const s = STATUS[status];
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

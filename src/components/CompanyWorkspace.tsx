import { useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTenant } from '../context/tenantStore';

/**
 * Paints the whole shell in the active company's colours.
 *
 * Every brand-dependent value is a CSS variable set in one place, so a new
 * tenant needs data — never a new stylesheet and never a component fork.
 */
export function CompanyWorkspace({ children }: { children: ReactNode }) {
  const { tenant } = useTenant();
  const b = tenant.branding;
  const h = tenant.hero;

  useEffect(() => {
    document.title = `CIP — ${tenant.name}`;
  }, [tenant.name]);

  const dark = b.nav === 'dark';

  const style = {
    '--brand': b.primary,
    '--brand-deep': b.deep,
    '--brand-soft': b.soft,
    '--brand-tint': b.tint,
    '--brand-ink': '#ffffff',

    '--hero-from': h.from,
    '--hero-to': h.to,
    '--hero-glow': h.glow,
    '--hero-ink': h.ink,

    '--nav-bg': dark ? '#12121A' : '#ffffff',
    '--nav-fg': dark ? '#A6ABBD' : '#48546f',
    '--nav-fg-strong': dark ? '#ffffff' : '#0b1220',
    '--nav-line': dark ? 'rgba(255,255,255,.08)' : '#e6eaf1',
    '--nav-hover': dark ? 'rgba(255,255,255,.06)' : '#f3f5f9',
    '--nav-card': dark ? 'rgba(255,255,255,.05)' : '#f7f9fc',
    '--nav-active-bg': dark ? 'rgba(255,255,255,.1)' : b.soft,
    '--nav-active-fg': dark ? '#ffffff' : b.deep,
  } as CSSProperties;

  // Remount the tree on tenant change so no stale company data can survive.
  return (
    <div className="shell" style={style} key={tenant.id}>
      {children}
    </div>
  );
}

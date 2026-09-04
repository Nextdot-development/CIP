'use client';

import { useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useWorkspace } from '@/context/workspace';

/**
 * Paints the shell in the signed-in company's colours.
 *
 * Only two brand colours are stored. Everything softer is mixed from them at
 * render time, so a new company needs one row rather than a palette someone
 * has to keep in sync.
 */
export function CompanyWorkspace({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const b = workspace.branding;
  const h = workspace.hero;

  useEffect(() => {
    document.title = `CIP — ${workspace.name}`;
  }, [workspace.name]);

  const dark = b.nav === 'dark';

  const style = {
    '--brand': b.primary,
    '--brand-deep': b.deep,
    '--brand-soft': `color-mix(in srgb, ${b.primary} 12%, #ffffff)`,
    '--brand-tint': `color-mix(in srgb, ${b.primary} 5%, #ffffff)`,
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
    '--nav-active-bg': dark ? 'rgba(255,255,255,.1)' : `color-mix(in srgb, ${b.primary} 12%, #ffffff)`,
    '--nav-active-fg': dark ? '#ffffff' : b.deep,
  } as CSSProperties;

  return (
    <div className="shell" style={style}>
      {children}
    </div>
  );
}

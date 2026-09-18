'use client';

import { useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useWorkspace } from '@/context/workspace';

/**
 * The workspace frame, and the company's own colours where they still apply.
 */
export function CompanyWorkspace({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const h = workspace.hero;

  useEffect(() => {
    document.title = `CIP — ${workspace.name}`;
  }, [workspace.name]);

  // The shell is one look now - the dark working surface from the CIS
  // prototype - so the company's colours no longer repaint the accent or the
  // sidebar. They still colour what is the company's own: the home banner.
  const style = {
    '--hero-from': h.from,
    '--hero-to': h.to,
    '--hero-glow': h.glow,
    '--hero-ink': h.ink,
  } as CSSProperties;

  return (
    <div className="shell" style={style}>
      {children}
    </div>
  );
}

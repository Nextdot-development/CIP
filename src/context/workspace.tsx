'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { WorkspaceView } from '@/lib/presentation';

/**
 * The workspace the signed-in user is allowed to see.
 *
 * It arrives as a prop from a server component that resolved it from the
 * session — the browser is never asked which company it is, and there is no
 * switcher, no localStorage and no company id in any URL.
 */
const Ctx = createContext<WorkspaceView | null>(null);

export function WorkspaceProvider({
  workspace,
  children,
}: {
  workspace: WorkspaceView;
  children: ReactNode;
}) {
  return <Ctx.Provider value={workspace}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceView {
  const w = useContext(Ctx);
  if (!w) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return w;
}

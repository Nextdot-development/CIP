'use client';

import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * How a request should be made.
 *  - instant: CIP drafts it now, on its own. Fast, not yet checked.
 *  - pod:     your people take it, check it and hand back finished work.
 */
export type AskMode = 'instant' | 'pod';
export type AskSeed = { text: string; mode: AskMode };

/**
 * Carries a request typed on Home across to Ask.
 *
 * It lives in the workspace layout, which survives navigation, so the text a
 * person typed does not need to travel through the URL.
 */
const Ctx = createContext<{
  seed: AskSeed | null;
  setSeed: (s: AskSeed | null) => void;
} | null>(null);

export function AskSeedProvider({ children }: { children: ReactNode }) {
  const [seed, setSeed] = useState<AskSeed | null>(null);
  return <Ctx.Provider value={{ seed, setSeed }}>{children}</Ctx.Provider>;
}

export function useAskSeed() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAskSeed must be used inside <AskSeedProvider>');
  return v;
}

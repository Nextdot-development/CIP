import { createContext, useContext } from 'react';

export type Route = 'home' | 'teach' | 'ask' | 'trust';

/**
 * How a request should be made.
 *  - instant: CIP drafts it now, on its own. Fast, not yet checked.
 *  - pod:     your people take it, check it and hand back finished work.
 */
export type AskMode = 'instant' | 'pod';

export type AskSeed = { text: string; mode: AskMode };

/** Tiny router. One app, four destinations — no dependency needed. */
export const NavContext = createContext<{
  route: Route;
  go: (r: Route, seed?: AskSeed) => void;
  seed?: AskSeed;
}>({ route: 'home', go: () => {} });

export const useNav = () => useContext(NavContext);

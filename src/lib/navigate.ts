'use client';

import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useAskSeed } from '@/context/NavContext';
import type { AskSeed } from '@/context/NavContext';

/**
 * Moving around the workspace. Routes are real paths now, so the back button,
 * bookmarks and a middle-click all behave the way people expect.
 */
export function useNavigate() {
  const router = useRouter();
  const { setSeed } = useAskSeed();

  return {
    go: (path: Route) => router.push(path),
    /** Hands a typed request to Ask without putting it in the URL. */
    ask: (seed?: AskSeed) => {
      setSeed(seed ?? null);
      router.push('/ask');
    },
  };
}

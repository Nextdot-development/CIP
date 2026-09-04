'use client';

import { useEffect } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * Says what went wrong and gives one thing to do about it. The underlying
 * error is logged rather than shown — a stack trace is not a message.
 */
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Workspace failed to load:', error);
  }, [error]);

  return (
    <div className="page-state">
      <span className="glyph" style={{ color: 'var(--stop-700)' }}>
        <Icon name="alert" size={26} />
      </span>
      <h2>We could not load your workspace</h2>
      <p>
        This is on our side, not yours. Try again in a moment — if it keeps happening, tell your pod
        and quote reference {error.digest ?? 'unknown'}.
      </p>
      <button type="button" className="btn btn-primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}

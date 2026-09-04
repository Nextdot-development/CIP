'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';

/** Brief confirmations. Nothing important is ever only said here. */
const Ctx = createContext<{ note: (message: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const note = useCallback((m: string) => setMessage(m), []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 2600);
    return () => clearTimeout(t);
  }, [message]);

  return (
    <Ctx.Provider value={{ note }}>
      {children}
      {message && (
        <div className="toast" role="status">
          <span className="ok">
            <Icon name="check" size={16} />
          </span>
          {message}
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside <ToastProvider>');
  return v;
}

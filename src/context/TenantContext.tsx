import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_TENANT_ID, TENANTS, getTenant } from '../data';
import { TenantCtx } from './tenantStore';
import type { TenantValue } from './tenantStore';

/**
 * Resolves the one workspace this session is allowed to see.
 *
 * In production: the session cookie identifies the user, the server returns
 * that user's tenant, and `switchTenant` does not exist. Here it is gated
 * behind `isDemoMode` so the switcher is unmistakably a development affordance.
 */

const STORAGE_KEY = 'cip.demo.tenant';
const isDemoMode = import.meta.env.DEV;

function initialTenantId(): string {
  if (!isDemoMode) return DEFAULT_TENANT_ID;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_TENANT_ID;
  } catch {
    return DEFAULT_TENANT_ID;
  }
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenantId, setTenantId] = useState<string>(initialTenantId);

  const switchTenant = useCallback((id: string) => {
    if (!isDemoMode) return;
    setTenantId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage can be unavailable; the switch still works for this session */
    }
  }, []);

  const value = useMemo<TenantValue>(
    () => ({ tenant: getTenant(tenantId), tenants: TENANTS, isDemoMode, switchTenant }),
    [tenantId, switchTenant],
  );

  return <TenantCtx.Provider value={value}>{children}</TenantCtx.Provider>;
}

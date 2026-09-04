import { createContext, useContext } from 'react';
import type { Tenant } from '../data/types';

export type TenantValue = {
  /** The one workspace this session is allowed to see. */
  tenant: Tenant;
  /** Demo only — production sessions resolve exactly one tenant. */
  tenants: Tenant[];
  isDemoMode: boolean;
  switchTenant: (id: string) => void;
};

export const TenantCtx = createContext<TenantValue | null>(null);

export function useTenant(): TenantValue {
  const v = useContext(TenantCtx);
  if (!v) throw new Error('useTenant must be used inside <TenantProvider>');
  return v;
}

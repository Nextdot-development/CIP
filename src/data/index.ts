import type { Tenant } from './types';
import { magicMoments } from './magicMoments';
import { narayanaHealth } from './narayanaHealth';

/**
 * The tenant registry. In production this is not a list the client holds —
 * the server resolves exactly one tenant from the session and returns it.
 * Here we keep both so the demo switcher has something to switch between.
 */
export const TENANTS: Tenant[] = [narayanaHealth, magicMoments];

export const DEFAULT_TENANT_ID = narayanaHealth.id;

/** Stands in for `GET /api/workspace` once the Brand Brain backend exists. */
export function getTenant(id: string): Tenant {
  return TENANTS.find((t) => t.id === id) ?? TENANTS[0];
}

export type { Tenant } from './types';

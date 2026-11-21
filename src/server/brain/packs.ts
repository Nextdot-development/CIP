import 'server-only';
import { withCompanyScope, type CompanyScope } from '../db';
import { marketsFor, packsOf } from '@/lib/packs';

/** Each brand's markets, among the company's: those its learned facts name. A brand with none named is offered every market. */
export async function brandMarkets(scope: CompanyScope, markets: string[]): Promise<Record<string, string[]>> {
  const rows = await withCompanyScope(scope, (tx) => tx<{ brand: string; value: string }[]>`
    select brand, value from brand_dna_facts
     where company_id = ${scope.companyId} and status = 'active' and attribute = 'market' and brand is not null
  `).catch(() => []);
  const by = new Map<string, string[]>();
  for (const r of rows) by.set(r.brand, [...(by.get(r.brand) ?? []), r.value]);
  return Object.fromEntries([...by].map(([b, said]) => [b, marketsFor(said, markets)]));
}

/** Each brand's packs, from the bottles in its library: Whytehall → Standard, Chocolate, Fire, Honey, Royal, Collection. */
export async function brandPacks(scope: CompanyScope): Promise<Record<string, string[]>> {
  const rows = await withCompanyScope(scope, (tx) => tx<{ brand: string; variant: string | null }[]>`
    select metadata->'asset'->>'brand' as brand, metadata->'asset'->>'variant' as variant
      from drive_files
     where company_id = ${scope.companyId} and archived_at is null
       and metadata->'asset'->>'kind' = 'bottle' and coalesce((metadata->'asset'->>'cutout')::boolean, false)
       and metadata->'asset'->>'brand' is not null
  `).catch(() => []);
  const by = new Map<string, (string | null)[]>();
  for (const r of rows) by.set(r.brand, [...(by.get(r.brand) ?? []), r.variant]);
  return Object.fromEntries([...by].map(([b, v]) => [b, packsOf(v)]));
}

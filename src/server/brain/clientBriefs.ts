import 'server-only';
import { withCompanyScope, type CompanyScope } from '../db';
import { requestFor, type BriefDeliverable } from '@/lib/briefRequest';

/**
 * The briefs a client sent, as filed in Drive: each one's email set out as what is to be made -
 * every piece with its size - and the files sent with it, kept in the same folder.
 * Read from what is already stored; no model is asked.
 */
export type ClientBrief = {
  id: string;
  title: string;
  from: string | null;
  date: string | null;
  market: string | null;
  brands: string[];
  skus: string[];
  notes: string[];
  deliverables: (BriefDeliverable & { request: string })[];
  files: { id: string; name: string; note: string | null; type: string }[];
};

type Stored = {
  title?: string; from?: string; date?: string; market?: string | null; brands?: string[];
  skus?: string[]; notes?: string[]; deliverables?: BriefDeliverable[];
};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);

export async function clientBriefs(scope: CompanyScope): Promise<ClientBrief[]> {
  return withCompanyScope(scope, async (tx) => {
    const briefs = await tx<{ id: string; folder_id: string | null; brief: Stored }[]>`
      select id, folder_id, metadata->'brief' as brief from drive_files
       where company_id = ${scope.companyId} and archived_at is null and metadata ? 'brief'
    `;
    if (!briefs.length) return [];
    const folders = [...new Set(briefs.map((b) => b.folder_id).filter((f): f is string => f !== null))];
    const files = folders.length
      ? await tx<{ id: string; folder_id: string; name: string; note: string | null; file_type: string }[]>`
          select id, folder_id, name, metadata->>'note' as note, file_type from drive_files
           where company_id = ${scope.companyId} and archived_at is null and folder_id in ${tx(folders)}
             and not (metadata ? 'brief')
           order by name`
      : [];
    return briefs
      .map(({ id, folder_id, brief: b }) => {
        const shown = { brands: list(b.brands), market: typeof b.market === 'string' ? b.market : null, skus: list(b.skus), notes: list(b.notes) };
        const pieces = Array.isArray(b.deliverables) ? b.deliverables.filter((d) => typeof d?.what === 'string') : [];
        return {
          id,
          title: typeof b.title === 'string' ? b.title.replace(/\s*\(brief,[^)]*\)\s*$/, '') : 'Brief',
          from: typeof b.from === 'string' ? b.from : null,
          date: typeof b.date === 'string' ? b.date : null,
          ...shown,
          deliverables: pieces.map((d) => ({ ...d, request: requestFor(shown, d) })),
          files: files.filter((f) => f.folder_id === folder_id).map((f) => ({ id: f.id, name: f.name, note: f.note, type: f.file_type })),
        };
      })
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  });
}

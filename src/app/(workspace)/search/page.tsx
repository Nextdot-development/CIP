import { requireSession } from '@/server/auth/guards';
import { withCompanyScope } from '@/server/db';
import { activeBrand } from '@/server/brain/activeBrand';
import { SearchSection } from '@/sections/SearchSection';
import type { SearchCard } from '@/sections/SearchSection';

export const metadata = { title: 'Creative Search — CIP' };
export const dynamic = 'force-dynamic';

const PRESENTATION = new Set(['ppt', 'pptx', 'key', 'odp']);
const SPREADSHEET = new Set(['xls', 'xlsx', 'csv', 'ods']);

function kindOf(mimeType: string, fileType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (PRESENTATION.has(fileType.toLowerCase())) return 'presentation';
  if (SPREADSHEET.has(fileType.toLowerCase())) return 'spreadsheet';
  return 'document';
}

/**
 * Creative Search: everything this company has made, findable by name or by
 * what it says.
 *
 * Before anything is typed the page shows the newest work for the brand chosen
 * in the sidebar, so it opens onto something rather than an empty box.
 */
export default async function SearchPage() {
  const session = await requireSession();
  const scope = session.scope;
  const { active } = await activeBrand(scope);

  const rows = await withCompanyScope(scope, (tx) =>
    tx<{
      id: string; name: string; file_type: string; mime_type: string;
      market: string | null; created_at: Date; folder_name: string | null;
    }[]>`
      select f.id, f.name, f.file_type, f.mime_type, f.market, f.created_at, d.name as folder_name
        from drive_files f
        left join drive_folders d on d.id = f.folder_id
       where f.company_id = ${scope.companyId}
         and f.archived_at is null
         and (${active}::text is null or f.brand = ${active})
       order by f.created_at desc
       limit 24
    `,
  );

  const recent: SearchCard[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: kindOf(row.mime_type, row.file_type),
    fileType: row.file_type,
    market: row.market,
    folderName: row.folder_name,
    createdAt: row.created_at.toISOString(),
  }));

  return <SearchSection recent={recent} brand={active} />;
}

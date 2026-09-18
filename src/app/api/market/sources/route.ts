import { withDriveScope, noStore } from '@/server/drive/http';
import { DriveRejected } from '@/server/drive/service';
import { MAX_FILE_BYTES, maxFileSizeLabel } from '@/lib/fileTypes';
import { activeBrand } from '@/server/brain/activeBrand';
import { addMarketFile, marketOverview } from '@/server/brain/market';
import { pumpInBackground } from '@/server/jobs/pump';

/**
 * /api/market/sources
 *
 * GET   the company's market reports and what was read from them
 * POST  multipart `file` (one or more) - store as market data and queue for reading
 *
 * A report lands in the company's "Market Intelligence" folder like any other
 * file, so it is also searchable and visible on the Add data page.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withDriveScope(async (scope) => {
    const { active } = await activeBrand(scope);
    return Response.json(await marketOverview(scope, { brand: active }), { headers: noStore });
  });
}

export async function POST(request: Request) {
  return withDriveScope(async (scope) => {
    const form = await request.formData();
    const files = form.getAll('file').filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) throw new DriveRejected('Choose a report to add.');

    const added: { fileId: string; fileName: string }[] = [];
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        throw new DriveRejected(`"${file.name}" is too large. Files need to be ${maxFileSizeLabel()} or smaller.`);
      }
      added.push(
        await addMarketFile(scope, {
          filename: file.name,
          mimeType: file.type || null,
          body: Buffer.from(await file.arrayBuffer()),
        }),
      );
    }

    // Read in the background: the person is waiting on the upload, not on the model.
    pumpInBackground();
    return Response.json({ added }, { status: 201, headers: noStore });
  });
}

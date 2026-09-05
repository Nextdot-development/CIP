import { withDriveScope, noStore } from '@/server/drive/http';
import { DriveRejected, uploadFile } from '@/server/drive/service';
import { MAX_FILE_BYTES } from '@/lib/fileTypes';

/** POST /api/drive/files — multipart form with `file` and optional `folderId` */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return withDriveScope(async (scope) => {
    const form = await request.formData();
    const entry = form.get('file');

    if (!(entry instanceof File)) {
      throw new DriveRejected('Choose a file to upload.');
    }
    if (entry.size > MAX_FILE_BYTES) {
      throw new DriveRejected('Files need to be 50 MB or smaller.');
    }

    const folderId = form.get('folderId');
    const body = Buffer.from(await entry.arrayBuffer());

    const file = await uploadFile(scope, {
      folderId: typeof folderId === 'string' && folderId && folderId !== 'root' ? folderId : null,
      filename: entry.name,
      mimeType: entry.type || null,
      body,
    });

    return Response.json(file, { status: 201, headers: noStore });
  });
}

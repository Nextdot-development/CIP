import { withDriveScope, noStore } from '@/server/drive/http';
import { DriveRejected, uploadFile } from '@/server/drive/service';
import { setFileBrand } from '@/server/brain/brands';
import { MAX_FILE_BYTES, maxFileSizeLabel } from '@/lib/fileTypes';
import { pumpInBackground } from '@/server/jobs/pump';

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
      // Derived from the constant rather than written out, so the number in the
      // message cannot drift away from the number being enforced.
      throw new DriveRejected(
        `That file is ${(entry.size / 1024 / 1024).toFixed(2)} MB. ` +
          `Files need to be ${maxFileSizeLabel()} or smaller.`,
      );
    }

    const folderId = form.get('folderId');
    const body = Buffer.from(await entry.arrayBuffer());

    const file = await uploadFile(scope, {
      folderId: typeof folderId === 'string' && folderId && folderId !== 'root' ? folderId : null,
      filename: entry.name,
      mimeType: entry.type || null,
      body,
    });

    // A brand chosen in the upload dialog. Checked against the roster, so a
    // name that is not one of this company's brands is simply not applied.
    const brand = form.get('brand');
    if (typeof brand === 'string' && brand.trim()) {
      await setFileBrand(scope, file.id, brand.trim());
    }

    // An upload lands as pending, exactly like a synced file, and needs the
    // same nudge for anything to read it. Started, not awaited: the person is
    // waiting on the upload, not on a vision model.
    pumpInBackground();

    return Response.json(file, { status: 201, headers: noStore });
  });
}

import 'server-only';
import { readFile } from 'node:fs/promises';
import { runFfmpeg, withTempFile } from '../brain/media';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { uploadFile } from '../drive/service';
import { googleDrive } from '../integrations/googleDrive';
import { requireConnected } from '../integrations/googleDrive/connection';
import { GoogleDriveNotConnected } from '../integrations/googleDrive/types';
import { VideoEditRejected } from './edit';

/**
 * Videos straight from the company's connected Google Drive.
 *
 * A doctor's recording is usually dropped into Google Drive by whoever shot
 * it. Rather than wait for a folder sync, the Video Studio lists the newest
 * videos the connection can read and brings in the one a person picks.
 */

export type GoogleVideo = { id: string; name: string; sizeBytes: number | null; modifiedAt: string | null };

/** The newest videos in the connected Drive; null when no Drive is connected. */
export async function listGoogleVideos(scope: CompanyScope): Promise<GoogleVideo[] | null> {
  let connection;
  try {
    connection = await requireConnected(scope);
  } catch (error) {
    if (error instanceof GoogleDriveNotConnected) return null;
    throw error;
  }
  const files = await googleDrive().listVideos(connection.accessToken);
  return files.map((f) => ({ id: f.id, name: f.name, sizeBytes: f.size, modifiedAt: f.modifiedTime }));
}

/**
 * Brings one Google Drive video into the workspace. Picked twice, it is
 * brought in once. A camera original is kept as a 1080p copy: a few hundred
 * megabytes of 4K becomes a few tens, and the film is 1080p anyway.
 */
export async function importGoogleVideo(scope: CompanyScope, googleId: string): Promise<{ id: string; name: string }> {
  if (!/^[\w-]{10,200}$/.test(googleId)) throw new VideoEditRejected('That Google Drive file could not be found.');
  const connection = await requireConnected(scope);
  const api = googleDrive();
  const file = await api.getFile(connection.accessToken, googleId);
  if (!file.mimeType.startsWith('video/') || file.trashed) throw new VideoEditRejected('Choose a video from Google Drive.');

  const [existing] = await withCompanyScope(scope, (tx) => tx<{ id: string; name: string }[]>`
    select id, name from drive_files
     where company_id = ${scope.companyId} and archived_at is null and bytes_retained
       and metadata->>'googleFileId' = ${googleId}
     limit 1
  `);
  if (existing) return existing;
  if (file.size !== null && file.size > MAX_SOURCE_BYTES) {
    throw new VideoEditRejected(`That video is ${Math.round(file.size / 1024 / 1024)} MB. Videos up to ${MAX_SOURCE_BYTES / 1024 / 1024 / 1024} GB can be brought in.`);
  }

  const original = await api.download(connection.accessToken, googleId, MAX_SOURCE_BYTES);
  const extension = file.name.split('.').pop()?.toLowerCase() || 'mp4';
  const body = original.length > SHRINK_ABOVE_BYTES ? await forEditing(original, extension) : original;
  const shrunk = body !== original;
  const filename = shrunk ? `${file.name.replace(/\.[^.]+$/, '')}.mp4` : file.name;
  const stored = await uploadFile(scope, { folderId: null, filename, mimeType: shrunk ? 'video/mp4' : file.mimeType, body });
  await withCompanyScope(scope, (tx) => tx`
    update drive_files set metadata = coalesce(metadata, '{}'::jsonb) || ${tx.json({ googleFileId: googleId })}
     where id = ${stored.id} and company_id = ${scope.companyId}
  `);
  return { id: stored.id, name: stored.name };
}

/** A camera original can be several gigabytes; this is what is read at all. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
/** Above this, a video is kept as a 1080p copy - all a finished film needs. */
const SHRINK_ABOVE_BYTES = 100 * 1024 * 1024;

/** A 1080p H.264 copy of a camera original, its short side at most 1080. */
async function forEditing(bytes: Buffer, extension: string): Promise<Buffer> {
  return withTempFile(bytes, extension, async (path) => {
    const out = `${path}.edit.mp4`;
    await runFfmpeg(
      ['-i', path, '-vf', "scale='if(gte(iw,ih),-2,min(1080,iw))':'if(gte(iw,ih),min(1080,ih),-2)'",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', out],
      20 * 60_000,
    );
    return readFile(out);
  });
}

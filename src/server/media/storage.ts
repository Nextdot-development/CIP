import 'server-only';
import { driveStorage } from '../drive/storage';
import { ProviderFailed } from './providers/types';

/**
 * Where generated media lives.
 *
 * The same private store the Drive uses — same bucket, same driver, same
 * server-mediated download. Generated media is not a second storage system
 * with a second set of rules to get wrong; it is more objects under the same
 * company prefix.
 *
 * The path is built from the authenticated company and ids we generated. No
 * part of it comes from a request body, so there is nothing here for a client
 * to point at another company with.
 */

export function mediaStorageKey(
  companyId: string,
  generationId: string,
  assetId: string,
  extension: string,
): string {
  const suffix = extension ? `.${extension}` : '';
  return `companies/${companyId}/media/${generationId}/${assetId}${suffix}`;
}

/** The extension for a stored asset. Kept short and known, never user input. */
export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    case 'video/quicktime':
      return 'mov';
    default:
      return 'bin';
  }
}

export async function putMediaAsset(key: string, bytes: Buffer, mimeType: string): Promise<void> {
  try {
    await driveStorage().put(key, bytes, mimeType);
  } catch (error) {
    // The provider's bytes are in hand and the object store refused them. That
    // is ours, not the provider's, and it is worth retrying.
    //
    // The reason travels with it. Swallowing it left "The generated file could
    // not be stored" as the only account of a refusal that could be a size
    // limit, a bad key, an expired credential or a network blip — four
    // different things to do about it, and no way to tell which.
    const because = error instanceof Error ? `: ${error.message}` : '';
    throw new ProviderFailed(
      'STORAGE_ERROR',
      'transient',
      `The generated file could not be stored${because}`.slice(0, 300),
    );
  }
}

export async function getMediaAsset(key: string): Promise<Buffer> {
  return driveStorage().get(key);
}

export async function removeMediaAsset(key: string): Promise<void> {
  await driveStorage().remove(key);
}

/** Which store is in use, for /api/health. Never a credential. */
export function mediaStorageName(): string {
  return driveStorage().name;
}

import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encrypting OAuth tokens at rest.
 *
 * A refresh token is a long-lived key to somebody's Google Drive. The database
 * already sits behind row-level security, but a backup, a support query or a
 * leaked dump would otherwise hand over every connected company's Drive. So the
 * tokens are encrypted before they are written and only decrypted in the
 * moment they are used.
 *
 * AES-256-GCM, because it authenticates as well as encrypts: a token that has
 * been tampered with fails to decrypt rather than being used.
 *
 * The key comes from CIP_ENCRYPTION_KEY when it is set. When it is not, it is
 * derived from SESSION_SECRET with HKDF and a fixed info string — a distinct
 * key for a distinct purpose, so token encryption and session signing never
 * share key material even though they share a secret. That keeps a development
 * machine working without a second secret to configure, while leaving a
 * deployment free to hold a real one.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const explicit = process.env.CIP_ENCRYPTION_KEY;
  if (explicit) {
    // Accept base64 or hex, but insist on a real 256-bit key either way. A
    // short passphrase silently stretched would look like encryption and offer
    // much less than it appears to.
    const decoded = decodeKey(explicit);
    if (decoded.length !== 32) {
      throw new Error('CIP_ENCRYPTION_KEY must be 32 bytes, as base64 or hex.');
    }
    cachedKey = decoded;
    return cachedKey;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('Set CIP_ENCRYPTION_KEY or SESSION_SECRET before storing OAuth tokens.');
  }

  cachedKey = Buffer.from(
    hkdfSync('sha256', Buffer.from(sessionSecret, 'utf8'), Buffer.alloc(0), 'cip.oauth.token.v1', 32),
  );
  return cachedKey;
}

function decodeKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  return Buffer.from(value, 'base64');
}

/**
 * Encrypts a token for storage.
 *
 * The output carries its version, nonce and tag, so the format can change
 * later without guessing how an old row was written.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/**
 * Decrypts a stored token.
 *
 * Throws rather than returning null on failure: a token that will not decrypt
 * is a token we cannot use, and carrying on with an empty string would produce
 * a confusing 401 from Google instead of an honest error here.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored credential is not in a format this version understands.');
  }

  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const ciphertext = Buffer.from(parts[3]!, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Stored credential is malformed.');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Compares two secrets without leaking their contents through timing. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Tests need the key recomputed after changing the environment. */
export function __resetEncryptionKey(): void {
  cachedKey = null;
}

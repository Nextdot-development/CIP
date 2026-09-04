import 'server-only';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

function scrypt(secret: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt is memory-hard, which is what makes a stolen hash expensive to attack
 * on GPUs, and it ships with Node — no native module to build on a developer's
 * machine and nothing extra to keep patched.
 */
const N = 16384; // CPU/memory cost
const r = 8; // block size
const p = 1; // parallelisation
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 12) {
    throw new Error('Password must be at least 12 characters.');
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(plain.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Constant-time verification. Returns false rather than throwing on a
 * malformed stored hash, so a corrupt row cannot become a 500 that tells an
 * attacker the account exists.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltB64, keyB64] = parts;
  const cost = Number(nRaw);
  const block = Number(rRaw);
  const par = Number(pRaw);
  if (!Number.isInteger(cost) || !Number.isInteger(block) || !Number.isInteger(par)) return false;

  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(keyB64!, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
      N: cost,
      r: block,
      p: par,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Burns roughly the same time as a real verification. Called when no user
 * matches, so sign-in takes the same time whether or not the email exists.
 */
export async function fakeVerify(): Promise<void> {
  await scrypt('no-such-user', randomBytes(SALT_LENGTH), KEY_LENGTH, { N, r, p });
}

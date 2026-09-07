import 'server-only';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { MEDIA_LIMITS, ProviderFailed } from './types';
import type { ImageGenerationProvider, ImageRequest, ImageResult } from './types';

/**
 * A deterministic image provider for tests.
 *
 * It produces a real PNG rather than a placeholder blob, so everything
 * downstream — content type, file size, storage round-trip, download headers —
 * is exercised on something a decoder would actually accept. The colour comes
 * from a hash of the prompt, so the same prompt always yields the same bytes
 * and a test can assert that two generations differ.
 *
 * No network, no key, no cost.
 */
export class FakeImageProvider implements ImageGenerationProvider {
  readonly name = 'fake-image' as const;
  readonly model = 'fake-image-1';
  readonly configured = true;
  readonly aspectRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
  readonly imageSizes = ['1K', '2K'] as const;

  /** Set by tests that need to see a failure path without a real provider. */
  failWith: ProviderFailed | null = null;

  async generate(request: ImageRequest): Promise<ImageResult> {
    if (this.failWith) throw this.failWith;

    if (request.prompt.trim().length === 0) {
      throw new ProviderFailed('INVALID_REQUEST', 'permanent', 'A prompt is required.');
    }
    if (request.prompt.length > MEDIA_LIMITS.maxPromptChars) {
      throw new ProviderFailed('INVALID_REQUEST', 'permanent', 'That prompt is too long.');
    }

    // Reference bytes participate in the digest, so editing the same image
    // twice with the same instruction is stable and editing a different one
    // is not.
    const digest = createHash('sha256').update(request.prompt);
    for (const reference of request.references) digest.update(reference.bytes);
    const hash = digest.digest();

    const { width, height } = dimensionsFor(request.aspectRatio ?? '1:1');
    const bytes = solidPng(width, height, [hash[0]!, hash[1]!, hash[2]!]);

    return {
      assets: [{ bytes, mimeType: 'image/png', width, height }],
      model: this.model,
      usage: {
        providerRequestId: `fake-${hash.subarray(0, 8).toString('hex')}`,
        inputUnits: request.prompt.length,
        outputUnits: 1,
        // A fake provider has no cost, and inventing one would put a fictional
        // number into the same column real spend is reported in.
        estimatedCost: null,
        costCurrency: null,
      },
    };
  }
}

/** Small, because tests store these and nobody looks at them. */
function dimensionsFor(aspectRatio: string): { width: number; height: number } {
  const [w = '1', h = '1'] = aspectRatio.split(':');
  const wide = Number(w) || 1;
  const tall = Number(h) || 1;
  const base = 64;
  return wide >= tall
    ? { width: base, height: Math.max(1, Math.round((base * tall) / wide)) }
    : { width: Math.max(1, Math.round((base * wide) / tall)), height: base };
}

/**
 * A valid single-colour PNG.
 *
 * Written out by hand because the alternative is a dependency that exists only
 * so tests can have bytes. PNG is a signature followed by length-tag-data-CRC
 * chunks; three chunks is a complete image.
 */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type: truecolour
  ihdrData[10] = 0; // deflate
  ihdrData[11] = 0; // adaptive filtering
  ihdrData[12] = 0; // no interlace

  // Each scanline is a filter byte followed by three bytes per pixel.
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdrData),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readPalette, withMeasuredPalette } from '../src/server/brain/palette';
import type { AssetAnalysis } from '../src/server/brain/providers/types';

/**
 * Knowing what colour a brand actually is.
 *
 * No database and no provider: this is counting pixels. What it is really
 * testing is that "what is this brand's gold?" has an answer at all. It did
 * not before — the Brain was asked for `paletteHex` and, correctly, returned
 * nothing 195 times out of 195, because no model can read a hex value off a
 * picture by eye.
 */

/** An image made of known bands, so the measured share of each is known too. */
async function banded(
  bands: { colour: string; rows: number }[],
  width = 40,
): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const height = bands.reduce((total, band) => total + band.rows, 0);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  let y = 0;
  for (const band of bands) {
    ctx.fillStyle = band.colour;
    ctx.fillRect(0, y, width, band.rows);
    y += band.rows;
  }
  return canvas.toBuffer('image/png');
}

function analysis(structured: Record<string, unknown>): AssetAnalysis {
  return {
    summary: '',
    extractedText: null,
    structured,
    facts: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe('reading the colours off an asset', () => {
  it('names a solid colour exactly', async () => {
    const palette = await readPalette(await banded([{ colour: '#c8a24b', rows: 40 }]), 'image/png');

    assert.equal(palette.length, 1);
    assert.equal(palette[0]!.hex, '#c8a24b');
    assert.equal(palette[0]!.share, 1);
  });

  it('orders colours by how much of the asset they cover', async () => {
    const palette = await readPalette(
      await banded([
        { colour: '#0d0d0d', rows: 60 },
        { colour: '#c8a24b', rows: 30 },
        { colour: '#b22222', rows: 10 },
      ]),
      'image/png',
    );

    assert.deepEqual(
      palette.map((entry) => entry.hex),
      ['#0d0d0d', '#c8a24b', '#b22222'],
    );
    assert.ok(palette[0]!.share > palette[1]!.share);
    assert.ok(palette[1]!.share > palette[2]!.share);
  });

  it('leaves out a colour too small to be a palette', async () => {
    // One row in a hundred is under the two percent floor: a stray pixel of
    // somebody's shirt is not one of the brand's colours.
    const palette = await readPalette(
      await banded([
        { colour: '#0d0d0d', rows: 99 },
        { colour: '#00ff00', rows: 1 },
      ]),
      'image/png',
    );

    assert.deepEqual(palette.map((entry) => entry.hex), ['#0d0d0d']);
  });

  it('folds near-identical shades into one colour rather than repeating it', async () => {
    // Three neighbouring golds are one gold. Reported separately they would
    // fill the palette and push the real second colour out of it.
    const palette = await readPalette(
      await banded([
        { colour: '#c8a24b', rows: 30 },
        { colour: '#c9a34c', rows: 30 },
        { colour: '#c7a14a', rows: 30 },
        { colour: '#101820', rows: 30 },
      ]),
      'image/png',
    );

    assert.equal(palette.length, 2);
    assert.ok(palette[0]!.share > 0.7, `gold should hold its combined share, got ${palette[0]!.share}`);
    assert.equal(palette[1]!.hex, '#101820');
  });

  it('returns nothing rather than throwing on bytes that are not an image', async () => {
    assert.deepEqual(await readPalette(Buffer.from('not a picture'), 'image/png'), []);
  });

  it('ignores a file type it cannot read', async () => {
    assert.deepEqual(await readPalette(Buffer.from([0]), 'application/pdf'), []);
  });
});

describe('putting measured colours into an analysis', () => {
  it('writes over whatever the model left in the field', async () => {
    const result = analysis({ design: { logoPlacement: 'top-left', paletteHex: ['#ffffff'] } });

    withMeasuredPalette(result, [{ hex: '#c8a24b' }, { hex: '#101820' }]);

    const design = (result.structured as { design: Record<string, unknown> }).design;
    assert.deepEqual(design.paletteHex, ['#c8a24b', '#101820']);
    // Everything the model did see is left alone.
    assert.equal(design.logoPlacement, 'top-left');
  });

  it('creates the design block when the model returned none', async () => {
    const result = analysis({});

    withMeasuredPalette(result, [{ hex: '#c8a24b' }]);

    assert.deepEqual(
      (result.structured as { design: Record<string, unknown> }).design.paletteHex,
      ['#c8a24b'],
    );
  });

  it('leaves the analysis untouched when nothing could be measured', async () => {
    const result = analysis({ design: { paletteHex: [] } });

    withMeasuredPalette(result, []);

    assert.deepEqual((result.structured as { design: Record<string, unknown> }).design.paletteHex, []);
  });
});

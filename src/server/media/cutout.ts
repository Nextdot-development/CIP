/**
 * A plain background taken off a picture, by its colour alone - no model, nothing spent.
 *
 * A glass shot on white, a lemon on grey: the ground is the colour all round the edge. What is
 * that colour and joined to the edge goes clear, so the white inside a glass's rim stays; the
 * pixels at the boundary fade out rather than leaving a hard fringe. A picture whose edge is not
 * one colour - a photo of a bar - is left as it is, and says so.
 */
export type Cutout = { pixels: Uint8ClampedArray; outcome: 'cut' | 'already-clear' | 'not-plain' };

/** How far from the edge's colour still counts as it, out of 441 (black to white). */
const NEAR = 38;
/** How much of the edge must be that one colour for it to be a plain ground. */
const PLAIN_EDGE = 0.72;

export function cutPlainBackground(rgba: Uint8ClampedArray, width: number, height: number): Cutout {
  const n = width * height;
  const pixels = new Uint8ClampedArray(rgba);
  // The edge, all the way round.
  const edge: number[] = [];
  for (let x = 0; x < width; x++) edge.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) edge.push(y * width, y * width + width - 1);

  const clearAtEdge = edge.filter((i) => pixels[i * 4 + 3]! < 24).length / edge.length;
  if (clearAtEdge > 0.6) return { pixels, outcome: 'already-clear' };

  // The ground's colour: the middle of the edge's, channel by channel.
  const middle = (c: number) => {
    const v = edge.map((i) => pixels[i * 4 + c]!).sort((a, b) => a - b);
    return v[v.length >> 1]!;
  };
  const ground = [middle(0), middle(1), middle(2)] as const;
  const far = (i: number) => {
    const o = i * 4;
    return Math.hypot(pixels[o]! - ground[0], pixels[o + 1]! - ground[1], pixels[o + 2]! - ground[2]);
  };
  const plain = edge.filter((i) => far(i) <= NEAR).length / edge.length;
  if (plain < PLAIN_EDGE) return { pixels, outcome: 'not-plain' };

  // Filled in from the edge: only ground joined to the edge goes.
  const gone = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (const i of edge) if (!gone[i] && far(i) <= NEAR) { gone[i] = 1; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width;
    const near = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
    for (const j of near) {
      if (j < 0 || j >= n || gone[j] || far(j) > NEAR) continue;
      gone[j] = 1;
      queue[tail++] = j;
    }
  }
  for (let i = 0; i < n; i++) {
    if (gone[i]) { pixels[i * 4 + 3] = 0; continue; }
    // Beside the ground and close to its colour: part ground, so partly clear.
    const x = i % width;
    const touches = (x > 0 && gone[i - 1]) || (x < width - 1 && gone[i + 1]) || (i >= width && gone[i - width]) || (i + width < n && gone[i + width]);
    if (!touches) continue;
    const d = far(i);
    if (d < NEAR * 2.2) pixels[i * 4 + 3] = Math.round(pixels[i * 4 + 3]! * Math.min(1, (d - NEAR) / (NEAR * 1.2) + 0.15));
  }
  return { pixels, outcome: 'cut' };
}

/**
 * A glass shot on white, made see-through - no model, nothing spent. What is coloured (the drink)
 * keeps what it adds over the white and lets the rest through; what is clear (the glass, the ice)
 * has its lines turned to light in the colour of the scene's own light, as glass catches it against
 * a dark scene, instead of the grey it shows against white.
 */
export function seeThrough(rgba: Uint8ClampedArray, light: readonly [number, number, number]): Uint8ClampedArray {
  const p = new Uint8ClampedArray(rgba);
  for (let i = 0; i < p.length; i += 4) {
    const a0 = p[i + 3]! / 255;
    if (!a0) continue;
    const r = p[i]!; const g = p[i + 1]!; const b = p[i + 2]!;
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    const sat = mx ? (mx - mn) / mx : 0;
    // The drink: what it adds over the white.
    const ac = Math.min(1, Math.max((255 - mn) / 255, 0.05));
    const un = (v: number) => Math.max(0, Math.min(255, (v - 255 * (1 - ac)) / ac));
    // The glass: its lines as light.
    const an = Math.min(0.85, ((255 - (r + g + b) / 3) / 255) * 1.6 + 0.05);
    const w = Math.min(1, sat * 3.2);
    const A = w * ac + (1 - w) * an;
    const mix = (cv: number, lv: number) => (A ? (w * ac * cv + (1 - w) * an * lv) / A : 0);
    p[i] = mix(un(r), light[0]); p[i + 1] = mix(un(g), light[1]); p[i + 2] = mix(un(b), light[2]);
    p[i + 3] = Math.round(A * a0 * 255);
  }
  return p;
}

/**
 * The colour of a scene's light: the brighter half of its pixels, averaged, brought up to full
 * brightness and softened towards white - warm amber in a bar at night, cool white by a window.
 */
export function lightOf(rgba: Uint8ClampedArray): [number, number, number] {
  let r = 0; let g = 0; let b = 0; let n = 0;
  const lums: number[] = [];
  for (let i = 0; i < rgba.length; i += 16) lums.push(rgba[i]! + rgba[i + 1]! + rgba[i + 2]!);
  const cut = [...lums].sort((x, y) => x - y)[Math.floor(lums.length / 2)] ?? 0;
  for (let i = 0; i < rgba.length; i += 16) {
    if (rgba[i]! + rgba[i + 1]! + rgba[i + 2]! < cut) continue;
    r += rgba[i]!; g += rgba[i + 1]!; b += rgba[i + 2]!; n++;
  }
  if (!n) return [255, 250, 240];
  const top = Math.max(r, g, b) / n || 1;
  const soft = (v: number) => Math.round(255 * 0.45 + ((v / n) * (255 / top)) * 0.55);
  return [soft(r), soft(g), soft(b)];
}

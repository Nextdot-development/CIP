import { deflateSync } from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const byte of b) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, c]);
};

/** Three unmistakable horizontal bands: red, green, blue. 512x512. */
function bands(): Buffer {
  const w = 512, h = 512;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 3 + 1);
    const band = Math.floor((y / h) * 3);
    const rgb = band === 0 ? [230, 20, 20] : band === 1 ? [20, 200, 60] : [20, 60, 230];
    for (let x = 0; x < w; x += 1) {
      raw[row + 1 + x * 3] = rgb[0]!; raw[row + 2 + x * 3] = rgb[1]!; raw[row + 3 + x * 3] = rgb[2]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const image = bands();
console.log('test image:', image.byteLength, 'bytes, 512x512, red/green/blue bands');

const schema = {
  type: 'object', additionalProperties: false,
  required: ['description', 'dominantColours', 'bandCount'],
  properties: {
    description: { type: 'string' },
    dominantColours: { type: 'array', items: { type: 'string' } },
    bandCount: { type: 'integer' },
  },
};

for (const [model, detail] of [['gpt-5-mini', 'auto'], ['gpt-4.1-mini', 'auto']] as [string, string][]) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Look at the attached image. Describe exactly what you see, list the dominant colours as names, and count how many horizontal colour bands there are.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}`, detail } },
        ],
      }],
      response_format: { type: 'json_schema', json_schema: { name: 'analysis', strict: true, schema } },
      max_completion_tokens: 2000,
      ...(model.startsWith('gpt-5') ? { reasoning_effort: 'low' } : {}),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await res.json()) as Record<string, any>;
  if (!res.ok) { console.log(model, res.status, JSON.stringify(body.error?.message).slice(0, 160)); continue; }
  const parsed = JSON.parse(body.choices[0].message.content);
  console.log(`\n${model}:`);
  console.log('  bands   :', parsed.bandCount, '(expected 3)');
  console.log('  colours :', parsed.dominantColours.join(', '));
  console.log('  says    :', parsed.description.slice(0, 130));
}

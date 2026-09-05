import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * Real files, built byte by byte.
 *
 * Extraction tests are worthless against fake input, so these produce genuine
 * PDF and DOCX files that any reader would accept — no binary blobs checked
 * into the repo, and no dependency on a fixture generator.
 */

const enc = (s: string) => Buffer.from(s, 'latin1');

/** A single-page PDF with one text line per entry, uncompressed. */
export function makePdf(lines: string[]): Buffer {
  // PDF strings need backslash, ( and ) escaped. Built from char codes so no
  // escape sequence has to survive a shell heredoc on the way into this file.
  const BS = String.fromCharCode(92);
  const escaped = lines.map((l) =>
    l.split(BS).join(BS + BS).split('(').join(BS + '(').split(')').join(BS + ')'),
  );
  const text = escaped
    .map((l, i) => `BT /F1 14 Tf 72 ${720 - i * 20} Td (${l}) Tj ET`)
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return enc(pdf);
}

/** A ZIP archive, deflate-stored, which is all a DOCX is. */
function makeZip(entries: { name: string; body: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.body);
    const sum = crc32(entry.body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(8, 8);        // deflate
    local.writeUInt32LE(0, 10);       // time/date
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(0, 12);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(entry.body.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 38);          // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

/** A DOCX with one paragraph per entry. */
export function makeDocx(paragraphs: string[]): Buffer {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escape(p)}</w:t></w:r></w:p>`)
    .join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return makeZip([
    { name: '[Content_Types].xml', body: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', body: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', body: Buffer.from(document, 'utf8') },
  ]);
}

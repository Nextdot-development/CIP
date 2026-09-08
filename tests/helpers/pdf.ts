/**
 * Real PDFs, built byte by byte.
 *
 * The visual pipeline is only worth testing against files a PDF reader would
 * actually accept, so these are assembled properly — object table, correct
 * xref offsets, real stream lengths — rather than stubbed. A text page uses a
 * standard font; an image page embeds a JPEG with DCTDecode, which is exactly
 * the shape a screenshot exported to PDF takes, and the case the text-layer
 * extractor cannot read.
 */

export type PdfPage =
  | { kind: 'text'; text: string; fontSize?: number }
  | { kind: 'image'; jpeg: Buffer; width: number; height: number }
  | { kind: 'mixed'; text: string; jpeg: Buffer; width: number; height: number };

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/** Escapes the three characters that end a PDF string early. */
function pdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Assembles a PDF from a list of pages.
 *
 * Objects are emitted in order and their byte offsets recorded as they go,
 * because the xref table has to point at where each one actually landed — a
 * guessed offset produces a file that opens in nothing.
 */
export function buildPdf(pages: PdfPage[]): Buffer {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let position = 0;

  const push = (data: Buffer | string): void => {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    chunks.push(buffer);
    position += buffer.length;
  };

  const startObject = (number: number): void => {
    offsets[number] = position;
    push(`${number} 0 obj\n`);
  };

  push('%PDF-1.4\n');
  // A binary comment marks the file as containing binary data, which is what
  // tells a reader not to mangle the image streams as text.
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // 1 catalog, 2 page tree, then four objects reserved per page.
  const pageObjectNumber = (index: number): number => 3 + index * 4;
  const total = 2 + pages.length * 4;

  startObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kids = pages.map((_, index) => `${pageObjectNumber(index)} 0 R`).join(' ');
  startObject(2);
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((page, index) => {
    const pageNumber = pageObjectNumber(index);
    const contentNumber = pageNumber + 1;
    const fontNumber = pageNumber + 2;
    const imageNumber = pageNumber + 3;

    const hasImage = page.kind === 'image' || page.kind === 'mixed';
    const hasText = page.kind === 'text' || page.kind === 'mixed';

    const resources =
      `<< ${hasText ? `/Font << /F1 ${fontNumber} 0 R >>` : ''} ` +
      `${hasImage ? `/XObject << /Im1 ${imageNumber} 0 R >>` : ''} >>`;

    startObject(pageNumber);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Contents ${contentNumber} 0 R /Resources ${resources} >>\nendobj\n`,
    );

    // The content stream. An image is drawn to fill the page; text sits above it.
    let stream = '';
    if (hasImage) {
      stream += `q\n${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm\n/Im1 Do\nQ\n`;
    }
    if (hasText) {
      const size = ('fontSize' in page && page.fontSize) || 24;
      const lines = (page as { text: string }).text.split('\n');
      stream += 'BT\n';
      stream += `/F1 ${size} Tf\n`;
      stream += `${size * 1.3} TL\n`;
      stream += `72 ${PAGE_HEIGHT - 96} Td\n`;
      lines.forEach((line, lineIndex) => {
        if (lineIndex > 0) stream += 'T*\n';
        stream += `(${pdfString(line)}) Tj\n`;
      });
      stream += 'ET\n';
    }

    const streamBytes = Buffer.from(stream, 'latin1');
    startObject(contentNumber);
    push(`<< /Length ${streamBytes.length} >>\nstream\n`);
    push(streamBytes);
    push('\nendstream\nendobj\n');

    // Emitted even when unused, so object numbering stays arithmetic.
    startObject(fontNumber);
    push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');

    startObject(imageNumber);
    if (hasImage) {
      const { jpeg, width, height } = page as { jpeg: Buffer; width: number; height: number };
      push(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
          '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ' +
          `/Length ${jpeg.length} >>\nstream\n`,
      );
      push(jpeg);
      push('\nendstream\nendobj\n');
    } else {
      push('<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Length 0 >>\nstream\n\nendstream\nendobj\n');
    }
  });

  const xrefOffset = position;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n += 1) {
    xref += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/**
 * A JPEG of a flat colour, at a size a vision model will accept.
 *
 * Built with the same encoder the rest of the pipeline uses, so what the tests
 * embed is a real JPEG rather than bytes that merely start like one.
 */
export async function solidJpeg(
  width: number,
  height: number,
  colour: { r: number; g: number; b: number },
): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = `rgb(${colour.r}, ${colour.g}, ${colour.b})`;
  context.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/jpeg');
}

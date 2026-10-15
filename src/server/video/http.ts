import 'server-only';

/**
 * Bytes as a download or for a player, answering a Range request so a video
 * can be scrubbed: a browser will not seek in an mp4 it cannot fetch in parts.
 */
export function bytesResponse(
  request: Request,
  file: { bytes: Buffer; name: string; type: string },
  options: { inline: boolean; cache: string },
): Response {
  const total = file.bytes.length;
  const headers: Record<string, string> = {
    'content-type': file.type,
    'accept-ranges': 'bytes',
    'content-disposition': `${options.inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/"/g, '')}"`,
    'cache-control': options.cache,
    'x-content-type-options': 'nosniff',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : total - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : total - 1;
    start = Math.max(0, start);
    end = Math.min(total - 1, end);
    if (start > end) {
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${total}` } });
    }
    return new Response(new Uint8Array(file.bytes.subarray(start, end + 1)), {
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) },
    });
  }
  return new Response(new Uint8Array(file.bytes), { headers: { ...headers, 'content-length': String(total) } });
}

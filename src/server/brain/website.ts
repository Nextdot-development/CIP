import 'server-only';

/**
 * Reading a brand's own website.
 *
 * Radico publishes a page per brand — Rampur's expressions, Jaisalmer's
 * botanicals, what Kohinoor is aged in, the strength of every 8PM variant.
 * CIP knew none of it, because it had only ever been shown pictures, and the
 * brands it knew least about were precisely the ones with the fewest
 * photographs and a perfectly good page describing them.
 *
 * A page becomes a file, which is the whole trick: the same drive_files row an
 * upload uses, so extraction, understanding, brand attribution, the brand
 * boundary and evidence counting all work on it unchanged. Nothing here is a
 * second pipeline.
 *
 * What this is not: a crawler. One page, given by name, fetched once. It
 * follows no links, obeys a size cap, and is only ever pointed at a site the
 * company owns — a brand reading its own pages is a different act from
 * harvesting somebody else's.
 */

/** Bounds, so one enormous page cannot exhaust the worker or the model. */
const LIMITS = {
  /** Bytes downloaded before giving up. A marketing page is far below this. */
  maxBytes: 2 * 1024 * 1024,
  /** Characters of readable text kept. The rest is navigation and footers. */
  maxChars: 40_000,
  timeoutMs: 20_000,
};

export type FetchedPage = {
  url: string;
  /** The page title, or the last path segment when it has none. */
  title: string;
  /** Readable text, tags and scripts removed. */
  text: string;
};

export class PageUnavailable extends Error {
  constructor(
    message: string,
    /** Safe to show: a status, or a word for what went wrong. Never page content. */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'PageUnavailable';
  }
}

/**
 * Everything between a tag and its closing partner, gone.
 *
 * Script and style first, because their *contents* are not text — stripping
 * tags alone would leave a page's JavaScript sitting in the middle of its prose
 * and the Brain would read it as brand voice. Then comments, then the tags
 * themselves, then the entities that matter.
 */
export function readableText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // A block tag becomes a line break, so paragraphs and list items do not
    // run into each other and read as one sentence.
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** The page's own title, or something honest derived from the address. */
function titleOf(html: string, url: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1]?.trim();
  if (raw && raw.length > 0) return readableText(raw).slice(0, 160);

  try {
    const path = new URL(url).pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop();
    return (path ?? new URL(url).hostname).replace(/[-_]+/g, ' ').slice(0, 160);
  } catch {
    return url.slice(0, 160);
  }
}

/**
 * Fetches one page and reduces it to text.
 *
 * Throws rather than returning something empty: a page that could not be read
 * must not become a file with nothing in it, because that file would then look
 * like knowledge CIP has and does not.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new PageUnavailable('That is not a web address.', 'not_a_url');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new PageUnavailable('Only http and https pages can be read.', 'bad_protocol');
  }

  let response: Response;
  try {
    response = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(LIMITS.timeoutMs),
      headers: {
        // Said plainly. A site owner reading their logs should be able to tell
        // who this is, and this is the company's own site.
        'user-agent': 'CIP/1.0 (brand knowledge; reads pages a customer owns)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new PageUnavailable(
      timedOut ? 'That page took too long to answer.' : 'That page could not be reached.',
      timedOut ? 'timeout' : 'unreachable',
    );
  }

  if (!response.ok) {
    throw new PageUnavailable(`That page answered ${response.status}.`, `http_${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    throw new PageUnavailable('That address is not a web page.', 'not_html');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > LIMITS.maxBytes) {
    throw new PageUnavailable('That page is too large to read.', 'too_large');
  }

  const html = buffer.toString('utf8');
  const text = readableText(html).slice(0, LIMITS.maxChars);

  // A page that rendered nothing readable is almost always one that builds
  // itself in the browser. Saying so is more useful than storing a blank.
  if (text.length < 120) {
    throw new PageUnavailable(
      'That page has almost no readable text, so it is probably drawn by script.',
      'no_text',
    );
  }

  return { url: target.toString(), title: titleOf(html, target.toString()), text };
}

/**
 * What gets stored for the page.
 *
 * The address is kept at the top of the text rather than only in the filename,
 * because the Brain reads the text and a claim about a product is worth more
 * when the thing reading it can see where it came from.
 */
export function pageDocument(page: FetchedPage): string {
  return `${page.title}\nSource: ${page.url}\n\n${page.text}`;
}

import 'server-only';
import { withCompanyScope, type CompanyScope } from '../db';
import { companyBrands } from './brands';
import { judge, type JudgedRule, type PostFacts, type Verdict } from './rulesJudge';
import { MediaRejected } from '../media/types';

/**
 * Creative QC with no model and nothing spent.
 *
 * A creative brought in is judged against its brand's and market's rules from what can be known
 * of it with no model: the words in a PDF's own text, or read off the picture on this server with
 * Tesseract (free, and the file goes nowhere). Its logo and its pack were not set by CIP,
 * and what its picture shows only eyes can say - those rules come back as a list for a person to
 * look at and tick, never passed on trust. The file is read here and kept nowhere, so nothing in
 * CIP goes on to read it with a model either.
 */
export type FreeQcReport = {
  brand: string;
  market: string | null;
  kind: 'image' | 'pdf' | 'video';
  /** How its words were read: from a PDF's own text, off the picture on this server, or not at all. */
  read: 'pdf-text' | 'ocr' | 'none';
  /** The words that were read, for a person to see what the rules were checked against. */
  words: string[];
  verdicts: Verdict[];
};

/** The rules a brand's creative in a market answers to, as the checker keeps them. */
export async function rulesToJudge(scope: CompanyScope, brand: string, market: string | null, format: 'image' | 'video'): Promise<JudgedRule[]> {
  const rows = await withCompanyScope(scope, (tx) => tx<{
    id: string; rule_code: string | null; domain: string | null; rule_type: string | null; severity: JudgedRule['severity'];
    requirement: 'required' | 'forbidden'; rule: string; allowed: string[] | null; prohibited: string[] | null; format: JudgedRule['format'];
  }[]>`
    select id, rule_code, domain, rule_type, severity, requirement, rule, allowed, prohibited, format from compliance_rules
     where company_id = ${scope.companyId} and active
       and (brand is null or lower(brand) = lower(${brand}))
       and (market is null or ${market}::text is null or lower(market) = lower(${market}))
       and format in ('all', ${format})
     order by severity nulls last, rule
  `);
  return rows.map((r) => ({
    id: r.id, code: r.rule_code, domain: r.domain, ruleType: r.rule_type, severity: r.severity, requirement: r.requirement,
    rule: r.rule, allowed: r.allowed ?? [], prohibited: r.prohibited ?? [], format: r.format,
  }));
}

export async function freeQc(
  scope: CompanyScope,
  input: { bytes: Buffer; mime: string; brand: unknown; market: unknown },
): Promise<FreeQcReport> {
  const roster = (await companyBrands(scope)).map((b) => b.name);
  const asked = typeof input.brand === 'string' ? input.brand.trim().toLowerCase() : '';
  const brand = roster.find((b) => b.toLowerCase() === asked);
  if (!brand) throw new MediaRejected('Choose the brand it is for - the rules are the brand\'s own.');
  const market = typeof input.market === 'string' && input.market.trim() ? input.market.trim().slice(0, 60) : null;
  const mime = input.mime.toLowerCase();
  const kind: FreeQcReport['kind'] = mime === 'application/pdf' ? 'pdf' : mime.startsWith('video/') ? 'video' : 'image';

  // Its words, where they can be read without a model: a PDF's own text.
  let words: string[] = [];
  let read: FreeQcReport['read'] = 'none';
  if (kind === 'pdf') {
    const { profilePdf } = await import('../drive/extraction/pdfRender');
    const profile = await profilePdf(input.bytes).catch(() => null);
    words = (profile?.pages ?? []).map((p) => p.text).filter((t) => t.trim().length > 0);
    if (words.length) read = 'pdf-text';
  }
  // No text of its own - a picture, or a PDF that is pictures: read off it here, for nothing.
  if (!words.length && kind !== 'video') {
    const { wordsInPdfPages, wordsInPicture } = await import('./freeOcr');
    words = await (kind === 'pdf' ? wordsInPdfPages(input.bytes) : wordsInPicture(input.bytes)).catch(() => []);
    if (words.length) read = 'ocr';
  }

  const facts: PostFacts = {
    brand, variant: null, words,
    logo: { on: false, box: null, rotate: 0, opacity: 1, bright: 0, shadow: 0 },
    ownBottle: false,
    known: { words: read !== 'none', logo: false, bottle: false },
  };
  const rules = await rulesToJudge(scope, brand, market, kind === 'video' ? 'video' : 'image');
  return { brand, market, kind, read, words: words.slice(0, 40), verdicts: rules.map((r) => judge(r, facts)) };
}

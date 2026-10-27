import 'server-only';
import type { CompanyScope } from '../db';
import { readBrandDna } from './brandDna';
import { standingPatterns } from './brandPatterns';

/**
 * A brand's rulebook: what it plainly does, on one page.
 *
 * Brand DNA holds thousands of observations, and a person reading them cannot
 * tell which are the brand and which are one file. This is the short list a
 * brief and a check are actually held to - the brand's standing patterns,
 * each seen in at least two files and done at least twice as often as
 * anything else - so a person can see at a glance whether CIP has the brand
 * right, and correct it where it has not.
 */

export type RulebookRule = {
  factId: string;
  /** "Logo placement", as a person would read it. */
  label: string;
  value: string;
  /** How many files show it. */
  files: number;
  /** True when it is this brand's own; false when it is the house's. */
  own: boolean;
  /** A person said this is right. */
  confirmed: boolean;
};

export type RulebookChapter = { title: string; rules: RulebookRule[] };

export type RulebookDTO = {
  brand: string | null;
  chapters: RulebookChapter[];
  /** Questions the brand's files have not yet answered, for asking the team. */
  missing: string[];
};

/** The chapters, in the order a designer reads a post. */
const CHAPTERS: { title: string; holds: RegExp }[] = [
  { title: 'Logo', holds: /^logo/ },
  { title: 'Headline and type', holds: /^(headline|font|type)/ },
  { title: 'Product', holds: /^(product|bottle|pack)/ },
  { title: 'Look and feel', holds: /^(background|palette|accent|lighting|image style|photography|composition|setting|mood|style|people)/ },
];

/** What every brand's files should be able to answer, and in which words. */
const ESSENTIALS: [RegExp, string][] = [
  [/^logo placement$/, 'where the logo sits'],
  [/^logo scale$/, 'how big the logo runs'],
  [/^headline case$/, 'how headlines are cased'],
  [/^headline placement$/, 'where the headline sits'],
  [/^product placement$/, 'where the bottle stands'],
  [/^background (kind|tone)$|^background$/, 'what the backgrounds are like'],
];

const RULES_PER_CHAPTER = 6;

export async function brandRulebook(scope: CompanyScope, brand: string | null): Promise<RulebookDTO> {
  const facts = await readBrandDna(scope, { brand, limit: 500, minEvidence: 2 });
  // Only what can be seen to be met or not - a short value, not a mood board.
  const patterns = standingPatterns(facts, brand, { forChecking: true }).filter((f) => f.evidenceCount >= 2);

  const chapters = new Map<string, RulebookRule[]>();
  for (const fact of patterns) {
    const attribute = fact.attribute.toLowerCase();
    const chapter = fact.section === 'content'
      ? 'Voice'
      : CHAPTERS.find((c) => c.holds.test(attribute))?.title ?? 'Other';
    const rules = chapters.get(chapter) ?? [];
    if (rules.length >= RULES_PER_CHAPTER) continue;
    rules.push({
      factId: fact.id,
      label: attribute.charAt(0).toUpperCase() + attribute.slice(1),
      value: fact.value,
      files: fact.evidenceCount,
      own: fact.brand !== null,
      confirmed: fact.kind === 'preference',
    });
    chapters.set(chapter, rules);
  }

  const order = [...CHAPTERS.map((c) => c.title), 'Voice', 'Other'];
  const known = patterns.filter((f) => f.brand !== null || brand === null).map((f) => f.attribute.toLowerCase());
  return {
    brand,
    chapters: order
      .filter((title) => chapters.has(title))
      .map((title) => ({ title, rules: chapters.get(title)! })),
    missing: ESSENTIALS
      .filter(([attribute]) => !known.some((k) => attribute.test(k)))
      .map(([, question]) => question),
  };
}

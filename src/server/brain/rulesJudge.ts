/**
 * A post judged against the rules by what it is made of - no model, nothing spent.
 *
 * A post made in the studio is not a picture CIP has to look at to understand: it set every piece
 * itself. It knows whether the logo is on, in which corner, how big, turned or shadowed; every word
 * on it; which bottle it is. So a rule about any of those is answered exactly, from the layers. A
 * rule about what the painted scene shows - people, how drink is shown, a competitor's product - is
 * one only eyes can answer, and is handed to a person as a line to look at, never guessed.
 */

export type JudgedRule = {
  id: string;
  code: string | null;
  domain: string | null;
  ruleType: string | null;
  severity: 'critical' | 'major' | 'minor' | 'informational' | null;
  requirement: 'required' | 'forbidden';
  rule: string;
  allowed: string[];
  prohibited: string[];
  format: 'all' | 'image' | 'video';
};

export type PostFacts = {
  brand: string;
  variant: string | null;
  /** Every word on the post: the headline's lines, the added text, the words in shapes. */
  words: string[];
  logo: { on: boolean; box: { x: number; y: number; w: number; h: number } | null; rotate: number; opacity: number; bright: number; shadow: number };
  /** The bottle is the brand's own cut-out from its library. */
  ownBottle: boolean;
  /**
   * What is known for certain. A post made in the studio: all of it. A creative brought in: its words
   * when its text could be read, and never its logo or its pack - CIP did not set them, so a rule on
   * them is for a person to look at, not passed on trust.
   */
  known?: { words: boolean; logo: boolean; bottle: boolean };
};

export type Verdict = {
  rule: JudgedRule;
  status: 'passed' | 'broke' | 'look' | 'not-for-this';
  /** Why, in a line a person reads. */
  why: string;
};

const NOT_FOR_IMAGES = /^(vo|audio|subtitles|animation)$/i;
const PACKAGING = /^(packaging|pos|retail|pack)$/i;
const CTA = /\b(shop|buy|order|book|get yours|call now|visit|tap|click|swipe)\b|%\s*off|\boffer\b|\bdeal\b|₹|\$\s?\d|\bprice\b/i;
/** American spellings a British-English rule rules out. */
const US_SPELLING: [RegExp, string][] = [
  [/\bwhiskey\b/i, 'Whiskey'], [/\bcolor(s|ful)?\b/i, 'color'], [/\bflavor(s|ful)?\b/i, 'flavor'],
  [/\bfavorite\b/i, 'favorite'], [/\bcenter\b/i, 'center'], [/\bhonor\b/i, 'honor'], [/\bsavor\b/i, 'savor'],
];

/**
 * The literal words a rule names - only what it puts in quotes. An unquoted entry ("Driving
 * environments", "Health claims") is an idea a picture can show, not a word to look for in its text.
 */
export function namedWords(rule: Pick<JudgedRule, 'rule' | 'prohibited'>): string[] {
  const out = new Set<string>();
  for (const entry of rule.prohibited) {
    for (const m of entry.matchAll(/["“]([^"”]{2,60})["”]/g)) out.add(m[1]!.trim());
  }
  const never = rule.rule.match(/never\s+["“]([^"”]{2,40})["”]/gi) ?? [];
  for (const n of never) out.add(n.replace(/^never\s+["“]|["”]$/gi, '').trim());
  return [...out].filter((w) => w.length >= 2);
}

const has = (words: string[], phrase: string) => {
  const p = phrase.toLowerCase().replace(/[^\p{L}\p{N}%₹$ ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu');
  return words.some((w) => re.test(w.toLowerCase().replace(/[^\p{L}\p{N}%₹$ ]+/gu, ' ').replace(/\s+/g, ' ')));
};

/** One rule, judged from the post's own pieces - or handed to a person when only eyes can say. */
export function judge(rule: JudgedRule, post: PostFacts): Verdict {
  const v = (status: Verdict['status'], why: string): Verdict => ({ rule, status, why });
  const text = rule.rule;
  const domain = rule.domain ?? '';
  if (rule.format === 'video' || NOT_FOR_IMAGES.test(domain)) return v('not-for-this', 'For films, not pictures.');
  if (rule.ruleType === 'conditional' && PACKAGING.test(domain)) return v('not-for-this', 'For packaging and displays, not a post.');

  const known = post.known ?? { words: true, logo: true, bottle: true };
  const wordRule = namedWords(rule).length > 0 || /british english|call to action|\bcta\b|promotional offer/i.test(text);
  if (!known.words && wordRule) return v('look', 'Its words could not be read here: read them against this rule.');
  if (!known.logo && (/^logo$/i.test(domain) || /\blogo\b/i.test(text))) return v('look', 'Look at the logo: CIP did not set it on this creative.');
  if (!known.bottle && /pack|flavour|product/i.test(domain)) return v('look', 'Look at the pack: CIP did not set it on this creative.');

  // The words on the post.
  const named = namedWords(rule);
  const said = named.filter((w) => has(post.words, w));
  if (rule.requirement === 'forbidden' && said.length) return v('broke', `The post says "${said.join('", "')}".`);
  if (/british english/i.test(text)) {
    const us = US_SPELLING.filter(([re]) => post.words.some((w) => re.test(w))).map(([, w]) => w);
    return us.length ? v('broke', `American spelling on the post: ${us.join(', ')}.`) : v('passed', 'No American spellings on the post.');
  }
  if (/call to action|\bcta\b|promotional offer/i.test(text) && rule.requirement === 'forbidden') {
    const tagline = [...text.matchAll(/["“]([^"”]{6,60})["”]/g)].map((m) => m[1]!).find((q) => has(post.words, q));
    if (!tagline) return v('passed', 'Its line is not on the post.');
    const cta = post.words.find((w) => CTA.test(w));
    return cta ? v('broke', `"${tagline}" is on the post with "${cta}".`) : v('passed', `"${tagline}" stands without a call to action or an offer.`);
  }

  // The logo, as it was set.
  if (/^logo$/i.test(domain) || /\blogo\b/i.test(text)) {
    const l = post.logo;
    if (/top[- ]right/i.test(text) && !/end card|centred|centered/i.test(text)) {
      if (!l.on || !l.box) return v('broke', 'There is no logo on the post.');
      const right = l.box.x + l.box.w / 2 > 0.5; const top = l.box.y + l.box.h / 2 < 0.5;
      return right && top ? v('passed', 'The logo is in the top right.') : v('broke', `The logo is in the ${top ? 'top' : 'bottom'} ${right ? 'right' : 'left'}.`);
    }
    if (/distort|stretch|squash|recolou?r|tilt|rotat|outline|shadow|emboss|gradient|effect|alter/i.test(text) && rule.requirement === 'forbidden') {
      if (!l.on) return v('passed', 'There is no logo on the post to alter.');
      const done = [l.rotate ? `turned ${Math.round(l.rotate)}°` : '', l.shadow ? 'given a shadow' : '', l.bright ? 'made lighter or darker' : '', l.opacity < 1 ? 'made see-through' : ''].filter(Boolean);
      return done.length ? v('broke', `The logo is ${done.join(', ')}.`) : v('passed', 'The logo is the approved file, untouched: not turned, recoloured, stretched or shadowed.');
    }
    if (/minimum|at least|too small|legib|readab|\d+\s?mm/i.test(text)) {
      if (!l.on || !l.box) return v('passed', 'There is no logo on the post.');
      return l.box.w >= 0.12 ? v('passed', `The logo is ${Math.round(l.box.w * 100)}% of the post's width.`) : v('broke', `The logo is only ${Math.round(l.box.w * 100)}% of the post's width - too small to read on a phone.`);
    }
    if (rule.requirement === 'required' && /appear|present|visible|carry|include|must (be|use|stay)|keep|always/i.test(text)) {
      if (/approved|official|correct|version|colou?r/i.test(text)) {
        if (!l.on) return v('broke', 'There is no logo on the post.');
        const done = [l.rotate ? 'turned' : '', l.shadow ? 'shadowed' : '', l.bright ? 'made lighter or darker' : '', l.opacity < 1 ? 'made see-through' : ''].filter(Boolean);
        return done.length ? v('broke', `The logo is ${done.join(', ')}.`) : v('passed', 'The logo is the brand\'s approved file from its library, in its own colour, untouched.');
      }
      return l.on ? v('passed', 'The logo is on the post.') : v('broke', 'There is no logo on the post.');
    }
  }

  // The pack: the brand's own cut-out, the variant asked for.
  if ((/pack|flavour|product/i.test(domain) || /approved pack|variant whose/i.test(text)) && /\b(pack|packaging|packshot|bottle|label|sku|variant)\b/i.test(text)) {
    const own = `The bottle is ${post.brand}'s own cut-out${post.variant ? ` for ${post.variant}` : ''}, from its library - never redrawn.`;
    if (!post.ownBottle) return v('look', 'No bottle of the brand\'s own is on the post: look at what is.');
    // A rule about the pack and about what else is in the picture: the pack is known, the rest is for eyes.
    if (/\b(bees?|people|person|scene|background|props?|ice|fruit|cinnamon|chocolate|honey)\b.*\b(picture|scene|background|add)\b|\badd\b.*\bto the picture\b|communicate (its|their|the)? ?flavou?r/i.test(text)) {
      return v('look', `${own} Look whether the background adds what the rule rules out.`);
    }
    return v('passed', own);
  }

  // Words a rule quotes, none of them on the post - and nothing else in it a picture could show.
  if (rule.requirement === 'forbidden' && named.length && !/depict|show|imply|appear|picture|scene/i.test(text)) {
    return v('passed', `None of ${named.slice(0, 3).map((w) => `"${w}"`).join(', ')} is on the post.`);
  }

  // What the painted scene shows: only eyes can say.
  return v('look', 'About what the background shows - look at it.');
}

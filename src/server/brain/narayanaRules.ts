import type { QcRuleSeed } from './radicoRules';

/**
 * Narayana Health's own rules, from what the hospital has supplied.
 *
 * Read from "Video Template NH 2026" (Video Template Guidelines for
 * Performance Marketing) and the brand's own assets - the NH | SRCC logo,
 * the name plate, the OST panel and the end screens. Colours are measured
 * from those files: NH blue #08529B, NH red #E72329, on white.
 *
 * Where the guideline's words and its own example differ - it says the logo
 * goes top-right, its sample frame shows it top-left - the words are loaded
 * and the difference is noted for a person to settle.
 */

const N = (
  code: string,
  fields: Omit<QcRuleSeed, 'code' | 'brand' | 'product' | 'market'> & { market?: string | null },
): QcRuleSeed => ({ code: `NH-${code}`, brand: null, product: null, market: null, ...fields });

const GUIDE = 'Video Template NH 2026 - Video Template Guidelines for Performance Marketing';

export const NARAYANA_QC_RULES: QcRuleSeed[] = [
  N('VID-001', {
    from: `${GUIDE}, slides 3 and 14`,
    domain: 'Video structure',
    ruleType: 'prohibited',
    severity: 'major',
    rule: "The video begins directly with the doctor's message, testimonial or key communication - no logo or title card at the beginning.",
    rationale: 'Performance-marketing videos open on the doctor.',
    allowed: ["Opening on the doctor speaking"],
    prohibited: ['A logo intro', 'An opening title card'],
    humanReview: false,
    requirement: 'forbidden',
    category: 'placement',
    format: 'video',
  }),
  N('VID-002', {
    from: `${GUIDE}, slide 3 (horizontal video)`,
    domain: 'Logo',
    ruleType: 'mandatory',
    severity: 'major',
    rule: 'In a horizontal video the hospital logo appears only in the top-right corner, throughout the video or at the end.',
    rationale: "The guideline's sample frame shows the logo top-left; the written rule says top-right. Confirm with the brand team.",
    allowed: ['Logo top-right throughout', 'Logo at the end only'],
    prohibited: ['Logo at the beginning', 'Logo elsewhere on screen'],
    humanReview: false,
    requirement: 'required',
    category: 'placement',
    format: 'video',
  }),
  N('VID-003', {
    from: `${GUIDE}, slide 14 (vertical video)`,
    domain: 'Logo',
    ruleType: 'mandatory',
    severity: 'major',
    rule: 'In a vertical video the hospital logo is shown only at the end.',
    rationale: null,
    allowed: ['Logo on the end frame'],
    prohibited: ['Logo during the video'],
    humanReview: false,
    requirement: 'required',
    category: 'placement',
    format: 'video',
  }),
  N('VID-004', {
    from: `${GUIDE}, slides 3, 5, 14 and 16`,
    domain: 'Disclaimer',
    ruleType: 'mandatory',
    severity: 'critical',
    rule: "The disclaimer runs as a ticker at the bottom of the screen immediately after the doctor's introduction, for at least 5-7 seconds.",
    rationale: 'Placement and duration set by the guideline, as per compliance requirements.',
    allowed: [],
    prohibited: ['No disclaimer', 'A disclaimer shown for under 5 seconds', 'A disclaimer anywhere but the bottom'],
    humanReview: false,
    requirement: 'required',
    category: 'disclaimer',
    format: 'video',
  }),
  N('VID-005', {
    from: `${GUIDE}, slides 5 and 16`,
    domain: 'Disclaimer',
    ruleType: 'mandatory',
    severity: 'critical',
    rule:
      'The disclaimer reads exactly: "Disclaimer: This video is for general information and educational purposes only. It does not replace ' +
      'professional medical diagnosis, treatment, or advice. Always seek the counsel of your physician or other qualified healthcare provider ' +
      'regarding any medical condition. Narayana Health does not recommend or endorse any tests, physicians, procedures, or opinions mentioned. ' +
      'Reliance on any information provided here is solely at your own risk."',
    rationale: 'Set at layout in this wording; never rewritten.',
    allowed: [],
    prohibited: ['Shortened or reworded disclaimer'],
    humanReview: false,
    requirement: 'required',
    category: 'disclaimer',
    format: 'video',
  }),
  N('VID-006', {
    from: `${GUIDE}, slides 4 and 17`,
    domain: 'Name plate',
    ruleType: 'mandatory',
    severity: 'major',
    rule: "The doctor is introduced with the NH name plate: name in red bold, designation in blue below it, and \"Hospital | City\" in white on the blue band.",
    rationale: 'Name plate: white box with NH-blue border; name Helvetica Neue Bold in NH red; designation and hospital line in Helvetica Neue LT Pro.',
    allowed: [],
    prohibited: ['Name plate in other colours or layout'],
    humanReview: false,
    requirement: 'required',
    category: 'other',
    format: 'video',
  }),
  N('VID-007', {
    from: `${GUIDE}, slide 6 (horizontal) and slide 15 (vertical)`,
    domain: 'On-screen text',
    ruleType: 'preferred',
    severity: 'minor',
    rule:
      'On-screen text uses the NH panel: horizontal - the doctor on the left half and an NH-blue panel on the right half with a red bar, ' +
      'a white bold heading and points below; vertical - a blue strip with a red bar and a white bold heading.',
    rationale: null,
    allowed: [],
    prohibited: [],
    humanReview: false,
    requirement: 'required',
    category: 'other',
    format: 'video',
  }),
  N('VID-008', {
    from: `${GUIDE}, slides 7-9 and the supplied end screens`,
    domain: 'End frame',
    ruleType: 'mandatory',
    severity: 'major',
    rule:
      'The video ends on the NH end frame, on white: "Narayana Health | Take Care" - and for an SRCC or accredited-hospital video, ' +
      'the Narayana Health | SRCC lock-up, "Take Care", and "Our Accreditations" with the accreditation marks.',
    rationale: null,
    allowed: ['The supplied end-screen videos'],
    prohibited: ['A different end frame'],
    humanReview: false,
    requirement: 'required',
    category: 'other',
    format: 'video',
  }),
  N('THUMB-001', {
    from: `${GUIDE}, slides 11-12 (background for doctor YouTube thumbnail)`,
    domain: 'YouTube thumbnail',
    ruleType: 'preferred',
    severity: 'minor',
    rule:
      "A doctor's YouTube thumbnail: the doctor on the left half over a soft, blurred hospital background, the Narayana Health logo " +
      'top-left in a white card; on the right half an NH-blue panel with the speciality at the top right, the topic as a large white ' +
      'bold title beside a red bar, then the name plate (name in red bold, designation in blue) and "Hospital | City" in white.',
    rationale: null,
    allowed: [],
    prohibited: [],
    humanReview: false,
    requirement: 'required',
    category: 'placement',
    format: 'image',
  }),
  N('BRAND-001', {
    from: `${GUIDE}; colours measured from the supplied assets`,
    domain: 'Colour and type',
    ruleType: 'mandatory',
    severity: 'minor',
    rule: 'Use the NH colours - blue #08529B and red #E72329 on white - and Helvetica Neue (Bold for names and headings, LT Pro for body text).',
    rationale: null,
    allowed: [],
    prohibited: ['Other brand colours', 'Other typefaces'],
    humanReview: false,
    requirement: 'required',
    category: 'other',
    format: 'all',
  }),
  N('BRAND-002', {
    from: 'Supplied logo NHSRCC-Logo.png',
    domain: 'Logo',
    ruleType: 'prohibited',
    severity: 'major',
    rule: 'The Narayana Health logo and the NH | SRCC lock-up are used as supplied - not recoloured, redrawn or rearranged.',
    rationale: null,
    allowed: ['Narayana Health logo', 'Narayana Health | SRCC lock-up'],
    prohibited: ['Recoloured or redrawn logo'],
    humanReview: false,
    requirement: 'forbidden',
    category: 'other',
    format: 'all',
  }),
];

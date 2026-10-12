/**
 * The words each kind of company is spoken to the model in. Pure data, so
 * the providers can read it without reaching for the database.
 */

export type Category = 'alcohol' | 'healthcare' | 'general';
export type LogoCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';


type Words = {
  /** Told to the image generator: the lines it must not draw. */
  legalLinesNote: string;
  /** Told to the brief writer: what a statutory line is here, and who adds it. */
  legalLinesBrief: string;
  /** Told to the concept writer: what every concept must never do. */
  ideationGuards: string;
  /** What the product itself is called, where a sentence needs it. */
  product: string;
  /** What a "restricted" day means on the calendar. */
  restrictedDay: string;
  /** The compliance that applies to any creative, said in a rule's format note. */
  complianceKind: string;
};

export const WORDS: Record<Category, Words> = {
  alcohol: {
    legalLinesNote:
      'Do not include any health warning, "Drink Responsibly" line, age mark such as 18+ or 25+, ' +
      'or other legal disclaimer text anywhere in the image.',
    legalLinesBrief:
      'Statutory lines - health warnings, "Drink Responsibly", age marks such as 18+ or 25+, and any other ' +
      'legal disclaimer - are never part of the picture.',
    ideationGuards: 'never show under-age people, never promise effects of drinking, and never plan content for a dry day.',
    product: 'bottle',
    restrictedDay: 'a dry day: publish nothing showing alcohol',
    complianceKind: 'legal or alcohol compliance',
  },
  healthcare: {
    legalLinesNote:
      'Do not include any medical disclaimer, "consult your doctor" line, registration number or other ' +
      'legal text anywhere in the image.',
    legalLinesBrief:
      'Statutory lines - medical disclaimers, "consult your doctor", registration numbers and any other ' +
      'legal text - are never part of the picture.',
    ideationGuards:
      'never promise a cure or a guaranteed outcome, never show an identifiable patient without consent, ' +
      'never compare with another hospital or doctor by name, and never use fear to sell treatment.',
    product: 'service',
    restrictedDay: 'a day to publish nothing promotional',
    complianceKind: 'legal or medical-advertising compliance',
  },
  general: {
    legalLinesNote: 'Do not include any legal disclaimer or statutory text anywhere in the image.',
    legalLinesBrief: 'Statutory lines - disclaimers and any other legal text - are never part of the picture.',
    ideationGuards: 'never make a claim the sources do not support.',
    product: 'product',
    restrictedDay: 'a day to publish nothing promotional',
    complianceKind: 'legal compliance',
  },
};

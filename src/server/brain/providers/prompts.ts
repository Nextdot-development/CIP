import type { MarketDocumentInput } from './types';

/**
 * The words sent to read one part of a market report.
 *
 * Exported because the training exporter has to send exactly these. A fine-tuned
 * model stands behind the same `OPENAI_BASE_URL` and is asked the question in
 * these words, or it is asked one it never saw while training. Keeping the
 * prompt in one place is what stops the two drifting apart unnoticed.
 */
export function marketPrompt(input: MarketDocumentInput): string {
  const own = input.brands.map((b) => b.name).join(', ') || '(none listed)';
  return (
    `You are reading part ${input.part} of ${input.parts} of a market-intelligence document named ` +
    `"${input.filename}". The house's own brands are: ${own}.` +
    (input.markets.length ? ` It works in: ${input.markets.join(', ')}.` : '') +
    '\n\nReport the market signals this text states: market shares, growth, prices, distribution, ' +
    'consumer insight, competitor moves, regulation and trends.\n\n' +
    'Rules:\n' +
    '- Report only what the text states. Never estimate, infer or calculate a number it does not give.\n' +
    '- excerpt must be copied exactly, character for character, from the text: the sentence or table ' +
    'row that states it, under 300 characters. A signal whose excerpt is not in the text is thrown away.\n' +
    '- subjectType is own_brand only for the brands listed above. Any other brand or company is a ' +
    'competitor. The market or category as a whole is category.\n' +
    '- value is a number only when the text gives one, with its unit as written ("%", "INR crore", ' +
    '"million cases"). Otherwise value and unit are null.\n' +
    '- period as written ("FY24", "Q2 2025"), or null. market is the country or region the statement ' +
    'is about, as written, or null.\n' +
    '- statement is one plain sentence a marketer can read on its own.\n' +
    '- If this part states no market signals - a contents page, a disclaimer - return none.\n\n' +
    `Text:\n${input.text}`
  );
}

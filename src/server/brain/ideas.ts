import 'server-only';
import type { CompanyScope } from '../db';
import { brain } from './providers';
import { brandInRequest, companyBrands } from './brands';
import { gatherSources } from './chat';
import type { ChatSourceDTO } from './chat';

/**
 * Campaign Ideation: concepts for a brief, grounded in what CIP knows.
 *
 * The same sources Chat with the Brain draws on - the brand's DNA, its files,
 * market signals, the calendar and the compliance rules - handed to the model
 * with refs. Each concept has to name the sources it stands on. A ref that was
 * never sent is dropped, and a concept left standing on nothing is dropped with
 * it: that is a generic idea with the brand's name written on top, which is
 * exactly what the guidebook says this module must not produce.
 */

export class IdeasRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdeasRejected';
  }
}

export type ConceptDTO = {
  title: string;
  pitch: string;
  format: string;
  groundedIn: ChatSourceDTO[];
};

const CONCEPTS = 3;

export async function ideate(
  scope: CompanyScope,
  input: { brief: string; activeBrand: string | null },
): Promise<{ brand: string | null; concepts: ConceptDTO[] }> {
  const brief = input.brief.trim();
  if (brief.length < 3) throw new IdeasRejected('Describe the campaign in a few words first.');
  if (brief.length > 1_000) throw new IdeasRejected('Keep the brief under 1,000 characters.');

  const roster = await companyBrands(scope);
  const brand = brandInRequest(brief, roster.map((b) => b.name)) ?? input.activeBrand ?? null;
  const sources = await gatherSources(scope, brief, brand);

  const result = await brain().ideateConcepts({
    brief,
    brand,
    sources: sources.map((s) => s.forModel),
    count: CONCEPTS,
  });

  const sent = new Map(sources.map((s) => [s.forModel.ref, s.shown]));
  const concepts = result.concepts
    .map((concept) => ({
      title: (concept.title ?? '').trim().slice(0, 80),
      pitch: (concept.pitch ?? '').trim().slice(0, 500),
      format: (concept.format ?? '').trim().slice(0, 40),
      groundedIn: [...new Set(concept.groundedIn ?? [])].filter((ref) => sent.has(ref)).map((ref) => sent.get(ref)!),
    }))
    .filter((concept) => concept.title && concept.pitch && concept.groundedIn.length > 0)
    .slice(0, CONCEPTS);

  return { brand, concepts };
}

'use client';

import { useState } from 'react';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import { useAskSeed } from '@/context/NavContext';
import type { ConceptDTO } from '@/server/brain/ideas';

/**
 * The Campaign Ideation Engine, in the prototype's shape: a brief, then three
 * concept cards, each saying what it is grounded in.
 *
 * "Make this" hands a concept to the composer below, which already turns a
 * request into an on-brand image or video - so a concept goes from idea to a
 * first visual without being typed out again.
 */
export function IdeationPanel({ brand, configured }: { brand: string | null; configured: boolean }) {
  const { note } = useToast();
  const { setSeed } = useAskSeed();
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [concepts, setConcepts] = useState<ConceptDTO[] | null>(null);
  const [forBrand, setForBrand] = useState<string | null>(brand);

  const generate = async () => {
    const text = brief.trim();
    if (text.length < 3 || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/brain/ideas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief: text }),
      });
      const data = (await res.json().catch(() => ({}))) as { brand?: string | null; concepts?: ConceptDTO[]; message?: string };
      if (!res.ok) throw new Error(data.message ?? 'Concepts could not be made right now.');
      setConcepts(data.concepts ?? []);
      setForBrand(data.brand ?? null);
    } catch (error) {
      note(error instanceof Error ? error.message : 'Concepts could not be made right now.');
    } finally {
      setBusy(false);
    }
  };

  const make = (concept: ConceptDTO) => {
    setSeed({
      text: `${concept.title}: ${concept.pitch}${concept.format ? ` Format: ${concept.format}.` : ''}`,
      mode: 'instant',
    });
    document.querySelector('.composer')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    note('Concept added to the request below. Choose image or video, then make it.');
  };

  return (
    <section className="ideation" aria-label="Campaign concepts">
      <form
        className="ideabar"
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
      >
        <Icon name="compass" size={18} />
        <input
          id="idea-brief"
          aria-label="Campaign brief"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder={`${brand ? `${brand}: ` : ''}Diwali 2026 — premium gifting, urban metros, digital-first`}
        />
        <button type="submit" className="searchbtn" disabled={busy || !configured || brief.trim().length < 3}>
          {busy ? 'Thinking…' : 'Generate concepts'}
        </button>
      </form>

      {concepts && concepts.length === 0 && (
        <p className="small muted">
          CIP could not ground a concept for this brief in what it knows about {forBrand ?? 'these brands'}. Add
          more of the brand&apos;s own material, or name the brand in the brief.
        </p>
      )}

      {concepts && concepts.length > 0 && (
        <div className="ideagrid">
          {concepts.map((concept) => (
            <article key={concept.title} className="ideacard">
              <p className="title">{concept.title}</p>
              <p className="pitch">{concept.pitch}</p>
              <div className="groundedlabel">Grounded in</div>
              <div className="groundedtags">
                {concept.groundedIn.map((source) =>
                  source.href ? (
                    <a
                      key={source.ref}
                      className="gtag"
                      href={source.href}
                      target={source.href.startsWith('/api/') ? '_blank' : undefined}
                      rel="noreferrer noopener"
                      title={source.label}
                    >
                      {source.label}
                    </a>
                  ) : (
                    <span key={source.ref} className="gtag" title={source.label}>
                      {source.label}
                    </span>
                  ),
                )}
              </div>
              <div className="ideafoot">
                <span className="formattag">{concept.format}</span>
                <button type="button" className="btnghost ideamake" onClick={() => make(concept)}>
                  Make this
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

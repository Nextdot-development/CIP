'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pill } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import type { RulebookDTO, RulebookRule } from '@/server/brain/rulebook';

/**
 * A brand's rulebook: the few things it plainly does, each with how many of
 * its files show it. What a brief and a check hold a post to, so a person can
 * see at a glance whether CIP has the brand right - and say so. Right makes a
 * rule hold whatever the files later show; wrong removes it for good.
 */
export function Rulebook({ rulebook }: { rulebook: RulebookDTO }) {
  const { brand, chapters, missing } = rulebook;
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last rule marked wrong, so it can be brought back. */
  const [removed, setRemoved] = useState<RulebookRule | null>(null);

  const judge = async (rule: RulebookRule, verdict: 'right' | 'wrong' | 'clear') => {
    if (verdict === 'wrong' && !rule.own && brand
      && !window.confirm(`This is a rule for every brand, not only ${brand}. Remove it for all of them?`)) return;
    setBusy(rule.factId);
    setError(null);
    try {
      const res = await fetch('/api/brain/brand-dna', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ factId: rule.factId, verdict }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? 'That did not save.');
      }
      setRemoved(verdict === 'wrong' ? rule : null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not save.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rulebook" aria-label="Rulebook">
      <header className="rulebook-head">
        <div>
          <p className="eyebrow">Rulebook</p>
          <h2>{brand ? `How ${brand} is done` : 'How the house is done'}</h2>
          <p className="small muted">
            What CIP holds every post to: each seen in at least two files, and done at least twice as often as anything
            else. Mark a rule right to make it stick, or wrong to remove it.
          </p>
        </div>
      </header>

      {removed && (
        <p className="rulebook-note small">
          Removed &ldquo;{removed.label.toLowerCase()}: {removed.value}&rdquo;.{' '}
          <button type="button" className="rulebook-link" disabled={busy !== null} onClick={() => judge(removed, 'clear')}>
            Undo
          </button>
        </p>
      )}
      {error && <p className="rulebook-note rulebook-error small">{error}</p>}

      {chapters.length === 0 ? (
        <p className="small muted">Nothing is settled yet. Add more of this brand&apos;s posts and CIP will find its patterns.</p>
      ) : (
        <div className="rulebook-grid">
          {chapters.map((chapter) => (
            <div className="rulebook-chapter" key={chapter.title}>
              <h3>{chapter.title}</h3>
              <ul>
                {chapter.rules.map((rule) => (
                  <li key={rule.factId} className={rule.confirmed ? 'is-confirmed' : ''}>
                    <span className="rulebook-rule">
                      <span className="muted">{rule.label}</span>
                      <b>{rule.value}</b>
                      <span className="rulebook-meta">
                        {rule.files} files
                        {!rule.own && brand && <Pill tone="neutral">house</Pill>}
                        {rule.confirmed && <Pill tone="ok">confirmed</Pill>}
                      </span>
                    </span>
                    <span className="rulebook-actions">
                      {rule.confirmed ? (
                        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => judge(rule, 'clear')}>
                          Undo
                        </button>
                      ) : (
                        <>
                          <button type="button" className="rulebook-icon" title="Right" aria-label={`${rule.label} ${rule.value} is right`}
                            disabled={busy !== null} onClick={() => judge(rule, 'right')}>
                            <Icon name="check" size={14} />
                          </button>
                          <button type="button" className="rulebook-icon" title="Wrong" aria-label={`${rule.label} ${rule.value} is wrong`}
                            disabled={busy !== null} onClick={() => judge(rule, 'wrong')}>
                            <Icon name="x" size={14} />
                          </button>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <p className="rulebook-missing small">
          <b>Not yet shown by {brand ? `${brand}'s` : 'the'} files:</b> {missing.join(', ')}.
          {' '}Posts that show these will fill it in.
        </p>
      )}
    </section>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useWorkspace } from '@/context/workspace';
import { useNavigate } from '@/lib/navigate';
import type { AskMode } from '@/context/NavContext';
import { PromptSuggestions, RequestComposer } from '../components/RequestComposer';
import { Card, EmptyState, LogoMark } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import type { KnowledgeOverview } from '@/server/brain/overview';

/**
 * Home — ask for something, and see how much CIP has to answer with.
 *
 * The composer and the company's own art sit across the top, because the first
 * thing a person wants is to say what they need, and the page should look like
 * theirs while they do it. What follows is how much CIP actually knows.
 *
 * Those figures used to be a seeded "62% understood" with a bar towards a
 * threshold that unlocked features, and none of it moved when a file was
 * uploaded. Everything here is counted from the database when the page loads.
 */
export function HomeDashboard({ overview }: { overview: KnowledgeOverview }) {
  const workspace = useWorkspace();
  const { ask } = useNavigate();
  const [draft, setDraft] = useState('');

  const { files, learned, sources } = overview;

  const send = (mode: AskMode) => {
    if (draft.trim()) ask({ text: draft.trim(), mode });
  };

  return (
    <div className="rise">
      <div className="home-top">
        <div className="greeting">
          <h1>
            {greeting()}, {workspace.user.firstName}
            <span className="wave">👋</span>
          </h1>
          <p className="ask-line">What would you like to create today?</p>
          <p className="ask-sub">
            {overview.empty
              ? 'Teach CIP about your brand first, and everything it makes will sound like you.'
              : `Tell us in your own words. CIP writes the brief from the ${learned.facts} things ` +
                `it has learned about ${workspace.name}.`}
          </p>

          <RequestComposer
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            placeholder={workspace.composerPlaceholder}
          />

          <PromptSuggestions
            lead="Try asking:"
            items={workspace.promptSuggestions}
            onPick={(s) => ask({ text: s, mode: 'instant' })}
          />
        </div>

        <HeroPanel />
      </div>

      {overview.empty ? (
        <EmptyState
          icon="teach"
          title="CIP does not know your brand yet"
          copy="Connect a Google Drive folder and it keeps itself up to date, or upload files yourself. Either way it reads them and learns what your brand looks and sounds like."
          action={
            <Link className="btn btn-primary btn-sm" href="/teach">
              Start teaching <Icon name="arrow-right" size={14} />
            </Link>
          }
        />
      ) : (
        <>
          <div className="sec-head">
            <div>
              <h2>What CIP knows</h2>
              <p className="hint">Counted now, from what it has actually read.</p>
            </div>
            <Link className="btn btn-ghost btn-sm" href="/trust">
              See all of it <Icon name="arrow-right" size={14} />
            </Link>
          </div>

          <KnowledgePanel overview={overview} />

          {(learned.posts > 0 || learned.lessons > 0) && (
            <div className="metrics">
              {learned.posts > 0 && <Stat icon="image" label="Posts found" value={learned.posts} />}
              {learned.lessons > 0 && (
                <Stat icon="check" label="Lessons from feedback" value={learned.lessons} />
              )}
            </div>
          )}

          {(files.waiting > 0 || files.failed > 0) && (
            <Card className="pad">
              <p className="small">
                {files.waiting > 0 && (
                  <>
                    <Icon name="clock" size={14} /> {files.waiting} file
                    {files.waiting === 1 ? '' : 's'} still being read.{' '}
                  </>
                )}
                {files.failed > 0 && (
                  <>
                    <Icon name="alert" size={14} /> {files.failed} could not be read —{' '}
                    <Link href="/trust">see why</Link>.
                  </>
                )}
              </p>
            </Card>
          )}

          <div className="sec-head">
            <div>
              <h2>What it has to work with</h2>
              <p className="hint">Everything here came from your Drive or your uploads.</p>
            </div>
            <Link className="btn btn-ghost btn-sm" href="/teach">
              Add more <Icon name="arrow-right" size={14} />
            </Link>
          </div>

          <div className="kind-grid">
            {files.byKind.map((k) => (
              <article className="card kind-card" key={k.kind}>
                <span className="kc-icon"><Icon name={iconFor(k.kind)} size={19} /></span>
                <span className="stack grow">
                  <span className="kc-title">{k.kind}</span>
                  <span className="kc-sub">{k.understood} of {k.count} read</span>
                </span>
              </article>
            ))}
          </div>

          {sources.driveConnected && (
            <p className="tiny muted" style={{ marginTop: 18 }}>
              <Icon name="link" size={13} /> Syncing “{sources.driveFolder ?? 'a folder'}” from Google
              Drive{sources.lastSyncAt ? ` · last checked ${relative(sources.lastSyncAt)}` : ''}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * How much CIP has learned, as something you can read at a glance.
 *
 * Two figures, and each is a real ratio rather than a score:
 *
 *   - the meter is files read against files held, which moves the moment a file
 *     finishes;
 *   - the bar is what the knowledge is about, which is the facts themselves
 *     grouped by the section they were filed under.
 *
 * Neither is a "brand understanding percentage". There was one of those here
 * before — a seeded 62% with a bar towards a threshold — and it never moved when
 * a file was uploaded, because nothing computed it.
 *
 * The colours are the app's own brand, positive and warning steps, checked for
 * colour-vision separation rather than picked by eye (worst adjacent pair ΔE 8.5
 * protan, 20.9 normal). Amber falls under 3:1 against white, so every segment
 * carries a visible label and a value — identity is never colour alone.
 */
function KnowledgePanel({ overview }: { overview: KnowledgeOverview }) {
  const { files, learned } = overview;

  const read = files.total > 0 ? files.understood / files.total : 0;
  const sections = learned.bySection.slice(0, 4);
  const sectionTotal = sections.reduce((sum, s) => sum + s.count, 0);

  // Colour follows the section, never its position in the list. Ordering by
  // count means the order changes as facts accumulate, and a hue that moves
  // with rank repaints the whole bar when one category overtakes another.
  const SLOT: Record<string, number> = { visual: 1, content: 2, video: 3, rules: 4 };
  const slotFor = (section: string): number => SLOT[section] ?? 4;

  return (
    <div className="know-panel">
      <article className="card know-meter">
        <p className="km-label">Files read</p>
        <p className="km-figure">
          {files.understood}
          <span className="km-of">/{files.total}</span>
        </p>

        {/* Track and fill are steps of one ramp, so the state reads across the
            whole bar rather than only where it stops. */}
        <div
          className="km-track"
          role="img"
          aria-label={`${files.understood} of ${files.total} files read`}
        >
          <span className="km-fill" style={{ width: `${Math.round(read * 100)}%` }} />
        </div>

        <p className="km-note">
          {files.waiting > 0
            ? `${files.waiting} still being read`
            : files.failed > 0
              ? `${files.failed} could not be read`
              : 'Everything you have given it'}
        </p>
      </article>

      <article className="card know-mix">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <p className="km-label">What it has learned about you</p>
          <p className="km-count">{learned.facts}</p>
        </div>

        {sectionTotal > 0 ? (
          <>
            <div className="mix-bar" role="img" aria-label={sections.map((s) => `${s.label}: ${s.count}`).join(', ')}>
              {sections.map((s) => (
                <span
                  key={s.section}
                  className="mix-seg"
                  data-slot={slotFor(s.section)}
                  style={{ width: `${(s.count / sectionTotal) * 100}%` }}
                />
              ))}
            </div>

            {/* Legend and direct labels in one: three series, each named with its
                own count, so nothing depends on telling two fills apart. */}
            <ul className="mix-key">
              {sections.map((s) => (
                <li key={s.section}>
                  <span className="mix-dot" data-slot={slotFor(s.section)} aria-hidden />
                  <span className="mix-name">{s.label}</span>
                  <span className="mix-value">{s.count}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="km-note">Nothing learned yet.</p>
        )}

        <p className="km-note">
          {learned.derived > 0
            ? `${learned.derived} confirmed by more than one file`
            : 'Each seen once so far — add more and CIP starts confirming patterns'}
        </p>
      </article>
    </div>
  );
}

/** Company-owned art. Changes completely with the workspace. */
function HeroPanel() {
  const workspace = useWorkspace();

  return (
    <aside className="hero">
      <div className="hero-logo">
        <LogoMark
          name={workspace.name}
          logoUrl={workspace.logoUrl}
          bg="rgba(255,255,255,.14)"
          fg="currentColor"
          size="md"
        />
        <span className="hero-name">{workspace.name}</span>
      </div>
      <h2>{workspace.hero.title}</h2>
      <p className="hero-sub">{workspace.hero.subtitle}</p>
      {workspace.logoUrl && (
        <span className="hero-watermark" aria-hidden>
          <LogoMark
            name={workspace.name}
            logoUrl={workspace.logoUrl}
            bg="transparent"
            fg="currentColor"
            size="lg"
          />
        </span>
      )}
    </aside>
  );
}

function Stat({
  icon, label, value, of, note,
}: {
  icon: IconName; label: string; value: number; of?: number; note?: string;
}) {
  return (
    <article className="metric">
      <span className="m-icon"><Icon name={icon} size={18} /></span>
      <span className="stack grow">
        <span className="m-value">
          {value}
          {of !== undefined && <span className="m-of"> / {of}</span>}
        </span>
        <span className="m-label">{label}</span>
        {note && <span className="m-delta flat">{note}</span>}
      </span>
    </article>
  );
}

function iconFor(kind: string): IconName {
  if (kind === 'Images') return 'image';
  if (kind === 'Video') return 'video';
  if (kind === 'PDFs') return 'doc';
  if (kind === 'Audio') return 'voice';
  return 'book';
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

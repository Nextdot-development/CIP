'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useWorkspace } from '@/context/workspace';
import { useNavigate } from '@/lib/navigate';
import { Card, EmptyState } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import type { KnowledgeOverview } from '@/server/brain/overview';

/**
 * Home — how much CIP knows about you, and the two things you can do about it.
 *
 * Every figure is counted from the database when the page loads. The version
 * before this showed a seeded "62% understood" with a progress bar and a list
 * of things it would unlock, none of which moved when you uploaded a file:
 * a number that never changes is worse than no number, because people plan
 * around it.
 */
export function HomeDashboard({ overview }: { overview: KnowledgeOverview }) {
  const workspace = useWorkspace();
  const { ask: goAsk } = useNavigate();
  const [draft, setDraft] = useState('');

  const { files, learned, sources } = overview;

  const ask = () => {
    const text = draft.trim();
    if (text) goAsk({ text, mode: 'instant' });
  };

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">{greeting()}, {workspace.user.firstName}</p>
        <h1>
          {overview.empty
            ? `CIP does not know ${workspace.name} yet`
            : `CIP has read ${files.understood} of ${workspace.name}'s ${files.total} files`}
        </h1>
        <p className="lede">
          {overview.empty
            ? 'Teach it something and everything else here starts working.'
            : `${learned.facts} things learned about your brand, each traceable to the file it came from.`}
        </p>
      </header>

      {overview.empty ? (
        <EmptyState
          icon="teach"
          title="Nothing taught yet"
          copy="Connect a Google Drive folder and CIP keeps itself up to date, or upload files yourself. Either way it reads them and learns what your brand looks and sounds like."
          action={
            <Link className="btn btn-primary btn-sm" href="/teach">
              Start teaching <Icon name="arrow-right" size={14} />
            </Link>
          }
        />
      ) : (
        <>
          {/* What is in there. Counted, not estimated. */}
          <div className="metrics">
            <Stat icon="book" label="Files read" value={files.understood} of={files.total} />
            <Stat icon="sparkle" label="Things learned" value={learned.facts} note={
              learned.derived > 0 ? `${learned.derived} confirmed by more than one file` : undefined
            } />
            {learned.posts > 0 && <Stat icon="image" label="Posts found" value={learned.posts} />}
            {learned.lessons > 0 && <Stat icon="check" label="Lessons from feedback" value={learned.lessons} />}
          </div>

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
              <h2>What CIP has to work with</h2>
              <p className="hint">Everything here came from your Drive or your uploads.</p>
            </div>
            <Link className="btn btn-ghost btn-sm" href="/trust">
              See all of it <Icon name="arrow-right" size={14} />
            </Link>
          </div>

          <div className="kind-grid">
            {files.byKind.map((k) => (
              <article className="card kind-card" key={k.kind}>
                <span className="kc-icon"><Icon name={iconFor(k.kind)} size={19} /></span>
                <div className="stack grow">
                  <span className="kc-title">{k.kind}</span>
                  <span className="kc-sub">
                    {k.understood} of {k.count} read
                  </span>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {/* The way in. Whatever is typed here is carried into Ask. */}
      <div className="sec-head">
        <div>
          <h2>Make something</h2>
          <p className="hint">
            {overview.empty
              ? 'This works better once CIP has read a few of your files.'
              : 'Describe it. CIP writes the brief from what it knows about you, then makes it.'}
          </p>
        </div>
      </div>

      <Card className="pad">
        <textarea
          className="field-input"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={workspace.composerPlaceholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask();
          }}
        />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={ask} disabled={!draft.trim()}>
            Ask CIP <Icon name="arrow-right" size={14} />
          </button>
        </div>
      </Card>

      {sources.driveConnected && (
        <p className="tiny muted" style={{ marginTop: 18 }}>
          <Icon name="link" size={13} /> Syncing “{sources.driveFolder ?? 'a folder'}” from Google Drive
          {sources.lastSyncAt ? ` · last checked ${relative(sources.lastSyncAt)}` : ''}.
        </p>
      )}
    </div>
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
  if (hour < 18) return 'Good afternoon';
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

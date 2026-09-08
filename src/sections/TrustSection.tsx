'use client';

import { useState } from 'react';
import Link from 'next/link';
import { KnowledgeGraphSection } from './KnowledgeGraphSection';
import { BrainSection } from './BrainSection';
import { Card, EmptyState, Pill } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import type { KnowledgeGraphDTO } from '@/types/graph';
import type { BrainOverviewDTO } from '@/types/brain';
import type { KnowledgeOverview } from '@/server/brain/overview';

/**
 * Trust — everything CIP knows, and where each piece of it came from.
 *
 * The point of this page is that nothing here is asserted. Every fact carries
 * the files that produced it, every file says how far it got, and the graph
 * shows how the two connect. If something CIP made looks wrong, this is where
 * you find out why it thought that.
 *
 * What used to be here — work items, rights expiring, a monthly cost split —
 * was seeded demo data describing an agency workflow that does not exist. The
 * graph and the Brain were real, and were each on a page of their own that you
 * had to know to look for.
 */

type Tab = 'knowledge' | 'graph' | 'files';

export function TrustSection({
  overview,
  graph,
  brain,
}: {
  overview: KnowledgeOverview;
  graph: KnowledgeGraphDTO;
  brain: BrainOverviewDTO;
}) {
  const [tab, setTab] = useState<Tab>('knowledge');

  if (overview.empty) {
    return (
      <div className="rise">
        <header className="page-head">
          <p className="eyebrow">Trust</p>
          <h1>What CIP knows</h1>
        </header>
        <EmptyState
          icon="trust"
          title="Nothing to show yet"
          copy="Once CIP has read some of your files, everything it has learned appears here — each fact next to the file it came from."
          action={
            <Link className="btn btn-primary btn-sm" href="/teach">
              Teach CIP <Icon name="arrow-right" size={14} />
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Trust</p>
        <h1>What CIP knows</h1>
        <p className="lede">
          {overview.learned.facts} things learned from {overview.files.understood} files. Every one
          of them can be traced back to what it came from.
        </p>
      </header>

      <div className="tabs" role="tablist">
        <Tabs tab={tab} setTab={setTab} />
      </div>

      {tab === 'knowledge' && <BrainSection initial={brain} />}
      {tab === 'graph' && <KnowledgeGraphSection initial={graph} />}
      {tab === 'files' && <Files overview={overview} />}
    </div>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string; icon: 'sparkle' | 'grid' | 'book' }[] = [
    { id: 'knowledge', label: 'What it learned', icon: 'sparkle' },
    { id: 'graph', label: 'How it connects', icon: 'grid' },
    { id: 'files', label: 'What it read', icon: 'book' },
  ];

  return (
    <>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          className={`tab ${tab === item.id ? 'active' : ''}`}
          onClick={() => setTab(item.id)}
        >
          <Icon name={item.icon} size={16} /> {item.label}
        </button>
      ))}
    </>
  );
}

/** Every file, and how far the pipeline got with it. */
function Files({ overview }: { overview: KnowledgeOverview }) {
  const { files, sources } = overview;

  return (
    <>
      <Card className="pad">
        <div className="row" style={{ gap: 22, flexWrap: 'wrap' }}>
          <Figure label="Read" value={files.understood} tone="ok" />
          {files.waiting > 0 && <Figure label="Still reading" value={files.waiting} tone="warn" />}
          {files.failed > 0 && <Figure label="Could not read" value={files.failed} tone="stop" />}
          <Figure label="Uploaded by you" value={sources.uploaded} />
          <Figure label="From Google Drive" value={sources.googleDrive} />
        </div>
        {sources.driveConnected && (
          <p className="tiny muted" style={{ marginTop: 14 }}>
            <Icon name="link" size={13} /> Syncing “{sources.driveFolder ?? 'a folder'}” — new files
            are read automatically.
          </p>
        )}
      </Card>

      <div className="sec-head">
        <div>
          <h2>By kind</h2>
          <p className="hint">CIP reads each of these differently: documents by their words, images and video by looking.</p>
        </div>
        <Link className="btn btn-ghost btn-sm" href="/teach">
          Add more <Icon name="arrow-right" size={14} />
        </Link>
      </div>

      <div className="kind-grid">
        {files.byKind.map((k) => (
          <article className="card kind-card" key={k.kind}>
            <span className="stack grow">
              <span className="kc-title">{k.kind}</span>
              <span className="kc-sub">{k.understood} of {k.count} read</span>
            </span>
            <Pill tone={k.understood === k.count ? 'ok' : 'warn'}>
              {k.understood === k.count ? 'Done' : 'In progress'}
            </Pill>
          </article>
        ))}
      </div>
    </>
  );
}

function Figure({
  label, value, tone,
}: {
  label: string; value: number; tone?: 'ok' | 'warn' | 'stop';
}) {
  return (
    <span className="stack">
      <span className="fig-value" data-tone={tone}>{value}</span>
      <span className="tiny muted">{label}</span>
    </span>
  );
}

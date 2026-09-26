'use client';

import { useState, useTransition } from 'react';
import { setActiveBrand } from '@/app/actions';
import Link from 'next/link';
import { KnowledgeGraphSection } from './KnowledgeGraphSection';
import { BrainSection } from './BrainSection';
import { BrandBrainGraph } from './BrandBrainGraph';
import { Card, EmptyState, Pill } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import { useWorkspace } from '@/context/workspace';
import type { KnowledgeGraphDTO } from '@/types/graph';
import type { BrainOverviewDTO } from '@/types/brain';
import type { KnowledgeOverview } from '@/server/brain/overview';
import type { ProductBrainDTO } from '@/server/brain/productBrain';
import type { SharedTrait } from '@/server/brain/relations';

/**
 * The Brand Brain - everything CIP knows, and where each piece of it came from.
 *
 * Two views, as the guidebook draws them. The Product Brain is one brand: its
 * DNA in six areas, the brand chosen in the sidebar. The Company Brain is the
 * house: which brands share what, and where each stays its own.
 *
 * Nothing here is asserted. Every count is read from the tables, every fact
 * carries the files that produced it, and an area CIP knows nothing about is
 * drawn empty rather than filled in to make the picture look finished.
 */

type Mode = 'product' | 'company';
type Tab = 'learned' | 'read';

export type CompanyBrainDTO = { brands: number; assets: number; traits: SharedTrait[] };

export function TrustSection({
  overview,
  graph,
  brain,
  product,
  company,
}: {
  overview: KnowledgeOverview;
  graph: KnowledgeGraphDTO;
  brain: BrainOverviewDTO;
  product: ProductBrainDTO;
  company: CompanyBrainDTO;
}) {
  const workspace = useWorkspace();
  const [mode, setMode] = useState<Mode>('product');
  const [tab, setTab] = useState<Tab>('learned');
  const [, startTransition] = useTransition();

  /**
   * From a brand in the Company Brain to that brand's own brain: choose it in
   * the sidebar, as the switcher would, and show the Product Brain.
   */
  const openBrand = (brand: string) => {
    startTransition(async () => {
      await setActiveBrand(brand);
      setMode('product');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  if (overview.empty) {
    return (
      <div className="rise">
        <header className="page-head">
          <p className="eyebrow">Brand Brain</p>
          <h1>What CIP knows</h1>
        </header>
        <EmptyState
          icon="trust"
          title="Nothing to show yet"
          copy="Once CIP has read some of your files, everything it has learned appears here — each fact next to the file it came from."
          action={
            <Link className="btn btn-primary btn-sm" href="/teach">
              Add data <Icon name="arrow-right" size={14} />
            </Link>
          }
        />
      </div>
    );
  }

  const reportHref = `/api/brain/brand-dna/report${product.brand ? `?brand=${encodeURIComponent(product.brand)}` : ''}`;

  return (
    <div className="rise">
      <div className="brainmodebar" role="group" aria-label="Which brain">
        <button type="button" className={`modebtn ${mode === 'product' ? 'on' : ''}`} aria-pressed={mode === 'product'} onClick={() => setMode('product')}>
          Product Brain
        </button>
        <button type="button" className={`modebtn ${mode === 'company' ? 'on' : ''}`} aria-pressed={mode === 'company'} onClick={() => setMode('company')}>
          Company Brain
        </button>
      </div>

      {mode === 'product' ? (
        <>
          <header className="page-head pagehead-row">
            <div>
              <p className="eyebrow">Product Brain</p>
              <h1>Brand Brain — {product.brand ?? 'All brands'}</h1>
              <p className="lede">
                Every colour, phrase, campaign and rule {product.brand ? 'this brand has' : 'the house has'} used,
                mapped and connected.{product.brand ? '' : ' Choose a brand in the sidebar to see one on its own.'}
              </p>
            </div>
            <div className="headside">
              <div className="statrow">
                <Stat n={product.assets.toLocaleString('en-IN')} l="assets indexed" />
                <Stat n={product.facts.toLocaleString('en-IN')} l="patterns learned" />
                <Stat n={`${product.covered} of 6`} l="DNA areas covered" />
              </div>
              <a className="exportbtn" href={reportHref} download>
                <Icon name="download" size={14} /> Export Brand DNA Report
              </a>
            </div>
          </header>

          <div className="graphcard">
            <BrandBrainGraph brain={product} />
          </div>

          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'learned'} className={`tab ${tab === 'learned' ? 'active' : ''}`} onClick={() => setTab('learned')}>
              <Icon name="sparkle" size={16} /> What it learned
            </button>
            <button type="button" role="tab" aria-selected={tab === 'read'} className={`tab ${tab === 'read' ? 'active' : ''}`} onClick={() => setTab('read')}>
              <Icon name="book" size={16} /> What it read
            </button>
          </div>
          {tab === 'learned' ? <BrainSection initial={brain} /> : <Files overview={overview} />}
        </>
      ) : (
        <>
          <header className="page-head pagehead-row">
            <div>
              <p className="eyebrow">Company Brain</p>
              <h1>Company Brain — {workspace.name}</h1>
              <p className="lede">
                How the group&apos;s brands share DNA, and where each one stays distinct. A line between two
                brands is something both were described as.
              </p>
            </div>
            <div className="statrow">
              <Stat n={String(company.brands)} l="brands mapped" />
              <Stat n={company.assets.toLocaleString('en-IN')} l="total assets" />
              <Stat n={String(company.traits.length)} l="shared traits" />
            </div>
          </header>

          <KnowledgeGraphSection initial={graph} onOpenBrand={openBrand} />
          <CompanyInsights traits={company.traits} />
        </>
      )}
    </div>
  );
}

function Stat({ n, l }: { n: string; l: string }) {
  return (
    <div className="statchip">
      <span className="n">{n}</span>
      <span className="l">{l}</span>
    </div>
  );
}

function names(brands: string[]): string {
  if (brands.length <= 4) return brands.join(', ');
  return `${brands.slice(0, 4).join(', ')} and ${brands.length - 4} more`;
}

/**
 * The two readings the prototype puts under the graph, taken from the traits
 * rather than written for it: the trait the most brands share, and a telling
 * one that only a few of them do.
 */
function CompanyInsights({ traits }: { traits: SharedTrait[] }) {
  if (traits.length === 0) return null;

  const widest = [...traits].sort((a, b) => b.brands.length - a.brands.length || b.weight - a.weight)[0]!;
  const narrow = traits
    .filter((t) => t !== widest && t.dimension !== null && t.brands.length <= 3)
    .sort((a, b) => b.weight - a.weight)[0];

  return (
    <div className="insightgrid">
      <div className="insightcard">
        <div className="k">Shared most widely</div>
        <p>
          <b>{widest.value}</b> joins {widest.brands.length} brands: {names(widest.brands)}.
        </p>
      </div>
      {narrow && (
        <div className="insightcard">
          <div className="k">Shared only where it&apos;s true</div>
          <p>
            <b>{narrow.value}</b>
            {narrow.dimension ? ` (${narrow.dimension})` : ''} joins only {names(narrow.brands)}. The rest of the
            portfolio keeps its own positioning here.
          </p>
        </div>
      )}
    </div>
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

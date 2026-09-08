'use client';

import { useCallback, useState } from 'react';
import { Card, EmptyState, Pill } from '@/components/ui/Bits';
import { BrainPdfPanel } from './BrainPdfPanel';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/context/toast';
import { relativeDay } from '@/lib/format';
import { FACT_KIND_LABEL } from '@/types/brain';
import type {
  BrainOverviewDTO,
  BrandEvidenceDTO,
  BrandFactDTO,
  BrandSection,
  LessonDTO,
  MemoryDTO,
} from '@/types/brain';

/**
 * What CIP has learned about this company.
 *
 * Four views, each answering a different question: how much has been
 * understood, what the brand looks like, what is in memory, and what feedback
 * has taught. Every number comes from the company's own rows — a company with
 * nothing analysed sees an empty state and a way to start, not an encouraging
 * dashboard of zeroes.
 *
 * Provenance is a first-class thing here: a brand fact can be opened to see
 * the assets it was derived from, because a claim nobody can check is not
 * worth making.
 */

type Tab = 'overview' | 'brand' | 'memory' | 'pdfs' | 'learning';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'brand', label: 'Brand DNA' },
  { id: 'memory', label: 'Memory' },
  { id: 'pdfs', label: 'PDFs' },
  { id: 'learning', label: 'Learning' },
];

const SECTIONS: BrandSection[] = ['visual', 'video', 'content', 'rules'];

export function BrainSection({ initial }: { initial: BrainOverviewDTO }) {
  const { note } = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);

  const [memory, setMemory] = useState<MemoryDTO[]>([]);
  const [query, setQuery] = useState('');
  const [evidence, setEvidence] = useState<{ fact: BrandFactDTO; items: BrandEvidenceDTO[] } | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/brain', { cache: 'no-store' });
    if (res.ok) setData((await res.json()) as BrainOverviewDTO);
  }, []);

  const loadMemory = useCallback(
    async (term: string) => {
      const res = await fetch(`/api/brain/memory?q=${encodeURIComponent(term)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { memory: MemoryDTO[] };
      setMemory(body.memory);
    },
    [],
  );

  const understand = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/brain/understand', { method: 'POST' });
      if (res.status === 429) {
        note('That just ran. Give it a moment.');
        return;
      }
      if (!res.ok) {
        const problem = (await res.json().catch(() => null)) as { message?: string } | null;
        note(problem?.message ?? 'That did not work.');
        return;
      }
      const body = (await res.json()) as { queued: number };
      note(
        body.queued > 0
          ? `${body.queued} asset(s) queued. Run the worker to analyse them.`
          : 'Everything has already been analysed.',
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [note, refresh]);

  const openEvidence = useCallback(async (fact: BrandFactDTO) => {
    const res = await fetch(`/api/brain/brand-dna?factId=${encodeURIComponent(fact.id)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return;
    const body = (await res.json()) as { evidence: BrandEvidenceDTO[] };
    setEvidence({ fact, items: body.evidence });
  }, []);

  const { counts, provider } = data;

  return (
    <>
      <div className="kind-filters">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`kind-chip ${tab === entry.id ? 'on' : ''}`}
            onClick={() => {
              setTab(entry.id);
              if (entry.id === 'memory' && memory.length === 0) void loadMemory('');
            }}
          >
            {entry.label}
          </button>
        ))}
        <span className="filter-divider" aria-hidden="true" />
        <button type="button" className="kind-chip" disabled={busy} onClick={() => void understand()}>
          <Icon name="sparkle" size={14} /> Analyse new assets
        </button>
      </div>

      {!provider.configured && (
        <div className="notice">
          <Icon name="alert" size={15} />
          <span>
            <b className="strong">The Brain is not configured.</b> No provider key is set, so
            nothing can be analysed and no brand knowledge can be built.
          </span>
        </div>
      )}

      {data.empty && provider.configured && tab === 'overview' && (
        <EmptyState
          icon="sparkle"
          title="CIP has not learned anything yet"
          copy={
            counts.assets > 0
              ? `${counts.assets} file(s) are in your Drive. Analyse them to start building brand memory.`
              : 'Upload documents or connect Google Drive, then analyse them to start building brand memory.'
          }
          action={
            counts.assets > 0 ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void understand()}>
                Analyse new assets
              </button>
            ) : (
              <a className="btn btn-primary btn-sm" href="/drive">Open Drive</a>
            )
          }
        />
      )}

      {tab === 'overview' && !data.empty && (
        <>
          <Card title="What CIP understands">
            <div className="brain-stats">
              <Stat value={counts.understood} label="Assets understood" />
              <Stat value={counts.facts} label="Brand facts" />
              <Stat value={counts.derived} label="Confirmed patterns" hint="backed by several assets" />
              <Stat value={counts.confirmed} label="Confirmed lessons" hint={`of ${counts.lessons}`} />
              <Stat value={counts.feedback} label="Ratings given" />
              <Stat value={counts.briefs} label="Briefs written" />
            </div>

            {(counts.pending > 0 || counts.failed > 0 || counts.unsupported > 0) && (
              <p className="small muted" style={{ marginTop: 12 }}>
                {counts.pending > 0 && `${counts.pending} waiting to be analysed. `}
                {counts.failed > 0 && `${counts.failed} could not be analysed. `}
                {counts.unsupported > 0 && `${counts.unsupported} are not a kind CIP can read.`}
              </p>
            )}

            <p className="small muted" style={{ marginTop: 10 }}>
              Analysis runs in a worker: <code>npm run cip:worker -- --watch</code>. Video
              understanding {data.video.ffmpeg ? 'is available' : 'needs ffmpeg, which is not installed'}.
            </p>
          </Card>

          {data.topFacts.length > 0 && (
            <Card title="Strongest brand signals">
              {data.topFacts.slice(0, 8).map((fact) => (
                <FactRow key={fact.id} fact={fact} onEvidence={openEvidence} />
              ))}
            </Card>
          )}
        </>
      )}

      {tab === 'brand' && (
        <>
          {data.topFacts.length === 0 ? (
            <EmptyState
              icon="palette"
              title="No brand knowledge yet"
              copy="Brand DNA is built from your own assets. Analyse some to begin."
            />
          ) : (
            SECTIONS.map((section) => {
              const facts = data.topFacts.filter((f) => f.section === section);
              if (facts.length === 0) return null;
              return (
                <Card key={section} title={`${section[0]!.toUpperCase()}${section.slice(1)} DNA`}>
                  {facts.map((fact) => (
                    <FactRow key={fact.id} fact={fact} onEvidence={openEvidence} />
                  ))}
                </Card>
              );
            })
          )}
        </>
      )}

      {tab === 'memory' && (
        <Card title="Company memory">
          <div className="graph-search" style={{ marginBottom: 14 }}>
            <Icon name="search" size={15} />
            <input
              value={query}
              placeholder="Search what CIP understands…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadMemory(query);
              }}
            />
          </div>

          {memory.length === 0 ? (
            <p className="small muted">Nothing understood yet, or nothing matched that search.</p>
          ) : (
            memory.map((item) => (
              <div className="gen-row" key={item.fileId}>
                <span className="gen-thumb"><Icon name="doc" size={16} /></span>
                <span className="stack grow">
                  <span className="gen-prompt">{item.fileName}</span>
                  <span className="small muted">{item.summary}</span>
                </span>
                <a className="btn btn-sm" href={`/api/drive/files/${item.fileId}/content`} download>
                  Open
                </a>
              </div>
            ))
          )}
        </Card>
      )}

      {tab === 'pdfs' && <BrainPdfPanel />}

      {tab === 'learning' && (
        <>
          <Card title="What feedback has taught">
            {data.recentLessons.length === 0 ? (
              <p className="small muted">
                Nothing yet. Rate a generation out of 10 and say why, and CIP will start learning.
              </p>
            ) : (
              data.recentLessons.map((lesson) => <LessonRow key={lesson.id} lesson={lesson} />)
            )}
          </Card>

          <Card title="Recent ratings">
            {data.recentFeedback.length === 0 ? (
              <p className="small muted">No ratings yet.</p>
            ) : (
              data.recentFeedback.map((entry) => (
                <div className="gen-row" key={entry.id}>
                  <span className={`score-badge ${entry.score >= 8 ? 'good' : entry.score <= 4 ? 'bad' : ''}`}>
                    {entry.score}
                  </span>
                  <span className="stack grow">
                    <span className="gen-prompt">{entry.comment ?? 'No comment given.'}</span>
                    <span className="small muted">{relativeDay(entry.createdAt)}</span>
                  </span>
                  <Pill tone={entry.analysed ? 'ok' : 'warn'}>
                    {entry.analysed ? 'Learned from' : 'Waiting'}
                  </Pill>
                </div>
              ))
            )}
          </Card>
        </>
      )}

      {evidence && (
        <div className="evidence-sheet" role="dialog" aria-label="Evidence">
          <div className="row-between">
            <span className="insp-kind">Why CIP believes this</span>
            <button type="button" className="insp-close" onClick={() => setEvidence(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <h3>{evidence.fact.attribute}: {evidence.fact.value}</h3>
          <p className="small muted">
            {FACT_KIND_LABEL[evidence.fact.kind]} · {evidence.fact.evidenceCount} asset(s) ·
            {' '}confidence {(evidence.fact.confidence * 100).toFixed(0)}%
          </p>
          {evidence.items.length === 0 ? (
            <p className="small muted">No assets recorded for this.</p>
          ) : (
            evidence.items.map((item, index) => (
              <div className="gen-row" key={`${item.fileId}-${index}`}>
                <span className="stack grow">
                  <span className="gen-prompt">{item.fileName ?? 'An asset'}</span>
                  {item.note && <span className="small muted">{item.note}</span>}
                </span>
                {item.fileId && (
                  <a className="btn btn-sm" href={`/api/drive/files/${item.fileId}/content`} download>
                    Open
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}

function Stat({ value, label, hint }: { value: number; label: string; hint?: string }) {
  return (
    <div className="brain-stat">
      <b>{value}</b>
      <span>{label}</span>
      {hint && <i>{hint}</i>}
    </div>
  );
}

function FactRow({
  fact,
  onEvidence,
}: {
  fact: BrandFactDTO;
  onEvidence: (fact: BrandFactDTO) => void;
}) {
  return (
    <div className="gen-row">
      <span className="stack grow">
        <span className="gen-prompt">
          <b className="strong">{fact.attribute}</b>: {fact.value}
        </span>
        <span className="small muted">
          {FACT_KIND_LABEL[fact.kind]} · {fact.evidenceCount} asset(s) ·{' '}
          {(fact.confidence * 100).toFixed(0)}% confidence
        </span>
      </span>
      <button type="button" className="btn btn-sm" onClick={() => onEvidence(fact)}>
        Evidence
      </button>
    </div>
  );
}

function LessonRow({ lesson }: { lesson: LessonDTO }) {
  // The scope is the important part: a lesson that applies everywhere is a very
  // different claim from one learned about a single campaign.
  const scope = [lesson.campaign, lesson.product, lesson.platform, lesson.taskType]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="gen-row">
      <Pill tone={lesson.polarity === 'prefer' ? 'ok' : 'stop'}>
        {lesson.polarity === 'prefer' ? 'Prefer' : 'Avoid'}
      </Pill>
      <span className="stack grow">
        <span className="gen-prompt">{lesson.statement}</span>
        <span className="small muted">
          {scope || 'applies everywhere'} · {lesson.evidenceCount} rating(s)
        </span>
      </span>
      <Pill tone={lesson.status === 'confirmed' ? 'ok' : 'warn'}>{lesson.status}</Pill>
    </div>
  );
}

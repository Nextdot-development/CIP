'use client';

import { useState } from 'react';
import { EmptyState } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import type { DriveSearchResultDTO, SemanticSearchDTO } from '@/types/drive';

/**
 * Creative Search.
 *
 * Two ways to look, because they answer different questions. "Search" finds a
 * file by its name - fast, exact, and free. "Search by meaning" finds passages
 * about something even when no file is named for it - "everything mentioning
 * heritage" - and costs an embedding call, so it runs only when asked.
 */
export type SearchCard = {
  id: string;
  name: string;
  kind: string;
  fileType: string;
  market: string | null;
  folderName: string | null;
  createdAt: string;
};

type KindFilter = 'image' | 'video' | 'presentation' | 'document' | null;

const KINDS: { value: KindFilter; label: string }[] = [
  { value: null, label: 'Everything' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Video' },
  { value: 'presentation', label: 'Presentations' },
  { value: 'document', label: 'Documents' },
];

const KIND_ICON: Record<string, IconName> = {
  image: 'image',
  video: 'video',
  presentation: 'slides',
  spreadsheet: 'sheet',
  audio: 'music',
};

const contentUrl = (id: string) => `/api/drive/files/${id}/content?disposition=inline`;

export function SearchSection({ recent, brand }: { recent: SearchCard[]; brand: string | null }) {
  const { note } = useToast();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>(null);
  const [busy, setBusy] = useState<'words' | 'meaning' | null>(null);
  const [files, setFiles] = useState<SearchCard[] | null>(null);
  const [hits, setHits] = useState<SemanticSearchDTO['hits'] | null>(null);
  const [asked, setAsked] = useState('');

  const byName = async (filter: KindFilter = kind) => {
    const q = query.trim();
    if (q.length < 2) {
      note('Search for at least two characters.');
      return;
    }
    setBusy('words');
    try {
      const params = new URLSearchParams({ q });
      if (filter) params.set('kind', filter);
      const res = await fetch(`/api/drive/search?${params}`);
      if (!res.ok) throw new Error('search failed');
      const data = (await res.json()) as DriveSearchResultDTO;
      setFiles(
        data.files.map((file) => ({
          id: file.id,
          name: file.name,
          kind: file.kind,
          fileType: file.fileType,
          market: file.market ?? null,
          folderName: file.folderName,
          createdAt: file.createdAt,
        })),
      );
      setHits(null);
      setAsked(q);
    } catch {
      note('Search is unavailable right now.');
    } finally {
      setBusy(null);
    }
  };

  const byMeaning = async () => {
    const q = query.trim();
    if (q.length < 2) {
      note('Search for at least two characters.');
      return;
    }
    setBusy('meaning');
    try {
      const res = await fetch('/api/drive/search/semantic', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, limit: 24 }),
      });
      if (!res.ok) {
        const body: { message?: string } = await res.json().catch(() => ({}));
        note(body.message ?? 'Search by meaning is unavailable right now.');
        return;
      }
      const data = (await res.json()) as SemanticSearchDTO;
      setHits(data.hits);
      setFiles(null);
      setAsked(q);
    } catch {
      note('Search by meaning is unavailable right now.');
    } finally {
      setBusy(null);
    }
  };

  const chooseKind = (value: KindFilter) => {
    setKind(value);
    if (files) void byName(value);
  };

  const clear = () => {
    setQuery('');
    setFiles(null);
    setHits(null);
    setAsked('');
  };

  const shownRecent = recent.filter((card) => !kind || card.kind === kind);

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Creative Search</p>
        <h1>Creative Search</h1>
        <p className="lede">
          Find anything this brand has made before - by the name of the file, or by what it is about.
          Search runs across every file CIP has, for this company only.
        </p>
      </header>

      <form
        className="searchbar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void byName();
        }}
      >
        <Icon name="search" size={18} />
        <input
          id="creative-search"
          aria-label="Search creative"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try “Diwali”, “bottle shot”, or “everything mentioning heritage”"
        />
        {(files || hits) && (
          <button type="button" className="searchbtn is-quiet" onClick={clear}>
            Clear
          </button>
        )}
        <button type="button" className="searchbtn is-quiet" onClick={() => void byMeaning()} disabled={busy !== null}>
          {busy === 'meaning' ? 'Searching…' : 'Search by meaning'}
        </button>
        <button type="submit" className="searchbtn" disabled={busy !== null}>
          {busy === 'words' ? 'Searching…' : 'Search'}
        </button>
      </form>

      {!hits && (
        <div className="chiprow" role="group" aria-label="Kind of file">
          {KINDS.map((option) => (
            <button
              key={option.label}
              type="button"
              className={`chip ${kind === option.value ? 'is-on' : ''}`}
              aria-pressed={kind === option.value}
              onClick={() => chooseKind(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {files && (
        <>
          <p className="searchnote">
            {files.length === 0
              ? `No file is named like “${asked}”. Search by meaning looks inside them instead.`
              : `${files.length} file${files.length === 1 ? '' : 's'} named like “${asked}”.`}
          </p>
          <div className="resultgrid">
            {files.map((card) => (
              <FileCard key={card.id} card={card} />
            ))}
          </div>
        </>
      )}

      {hits && (
        <>
          <p className="searchnote">
            {hits.length === 0
              ? `Nothing CIP has read is about “${asked}”.`
              : `${hits.length} passage${hits.length === 1 ? '' : 's'} about “${asked}”, closest first.`}
          </p>
          <div className="resultgrid">
            {hits.map((hit) => (
              <a
                key={hit.chunkId}
                className="resultcard"
                href={contentUrl(hit.fileId)}
                target="_blank"
                rel="noreferrer noopener"
              >
                <div className="body">
                  <span className="tag">{hit.fileType}</span>
                  <p className="title">{hit.fileName}</p>
                  <p className="meta">{[hit.heading, hit.folderName].filter(Boolean).join(' · ') || 'Passage'}</p>
                  <p className="snippet">{hit.snippet}</p>
                </div>
              </a>
            ))}
          </div>
        </>
      )}

      {!files && !hits && (
        <>
          <p className="searchnote">Newest for {brand ?? 'all brands'}.</p>
          {shownRecent.length === 0 ? (
            <EmptyState
              icon="search"
              title="Nothing here yet"
              copy={brand ? `No files are attributed to ${brand} yet. Choose All brands in the sidebar, or add some.` : 'Add files to the brain and they become searchable here.'}
            />
          ) : (
            <div className="resultgrid">
              {shownRecent.map((card) => (
                <FileCard key={card.id} card={card} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FileCard({ card }: { card: SearchCard }) {
  return (
    <a className="resultcard" href={contentUrl(card.id)} target="_blank" rel="noreferrer noopener">
      <div className="thumb">
        {card.kind === 'image' ? (
          <img src={`${contentUrl(card.id)}&size=640`} alt="" loading="lazy" decoding="async" />
        ) : (
          <Icon name={KIND_ICON[card.kind] ?? 'doc'} size={28} />
        )}
      </div>
      <div className="body">
        <span className="tag">{card.kind}</span>
        <p className="title">{card.name}</p>
        <p className="meta">
          {[card.folderName, card.market, card.createdAt.slice(0, 10)].filter(Boolean).join(' · ')}
        </p>
      </div>
    </a>
  );
}

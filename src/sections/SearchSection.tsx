'use client';

import { useState } from 'react';
import { EmptyState } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import type { FoundFile } from '@/server/drive/findEverything';

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
  const [found, setFound] = useState<FoundFile[] | null>(null);
  const [asked, setAsked] = useState('');

  /**
   * One search, three ways of looking, merged.
   *
   * There used to be two buttons and the person had to choose. Nobody knows
   * which of them will find the thing they are looking for - that is the whole
   * reason they are searching - and choosing wrong came back empty and read
   * like an empty Drive.
   */
  const look = async () => {
    const q = query.trim();
    if (q.length < 2) {
      note('Search for at least two characters.');
      return;
    }
    setBusy('words');
    try {
      const res = await fetch(`/api/drive/search/everything?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error('search failed');
      const data = (await res.json()) as { files: FoundFile[] };
      setFound(data.files);
      setAsked(q);
    } catch {
      note('Search is unavailable right now.');
    } finally {
      setBusy(null);
    }
  };

  // The kind chips filter what is on screen before anything is searched. Once
  // a search has run, its results are what they are - narrowing them by kind
  // would quietly hide the picture somebody was looking for.
  const chooseKind = (value: KindFilter) => setKind(value);

  const clear = () => {
    setQuery('');
    setFound(null);
    setAsked('');
  };

  const shownRecent = recent.filter((card) => !kind || card.kind === kind);

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Creative Search</p>
        <h1>Creative Search</h1>
        <p className="lede">
          Search once and CIP looks three ways at the same time: the names of the files, the
          words inside the documents, and what it saw when it looked at the pictures. Every
          file this company has, and nobody else&apos;s.
        </p>
      </header>

      <form
        className="searchbar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void look();
        }}
      >
        <Icon name="search" size={18} />
        <input
          id="creative-search"
          aria-label="Search creative"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try “festive celebration”, “friends toasting”, or “tiger at sunrise”"
        />
        {found && (
          <button type="button" className="searchbtn is-quiet" onClick={clear}>
            Clear
          </button>
        )}
        <button type="submit" className="searchbtn" disabled={busy !== null}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {!found && (
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

      {found && (
        <>
          <p className="searchnote">
            {found.length === 0
              ? `Nothing here is about “${asked}” — not by name, not inside a document, not in a picture.`
              : `${found.length} file${found.length === 1 ? '' : 's'} about “${asked}”, closest first.`}
          </p>
          <div className="resultgrid">
            {found.map((card) => (
              <a
                key={card.id}
                className="resultcard"
                href={contentUrl(card.id)}
                target="_blank"
                rel="noreferrer noopener"
              >
                <div className="body">
                  <span className="tag">{card.fileType}</span>
                  <p className="title">{card.name}</p>
                  {/* Why it is here. A result nobody expected is only useful if
                      it can be understood, and "it matched" is not a reason. */}
                  <p className="meta">
                    {[
                      card.why.byName ? 'name' : null,
                      card.why.inText ? 'in the text' : null,
                      card.why.inPicture ? 'in the picture' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {card.folderName ? ` · ${card.folderName}` : ''}
                  </p>
                  {(card.why.inPicture || card.why.inText) && (
                    <p className="snippet">{card.why.inPicture ?? card.why.inText}</p>
                  )}
                </div>
              </a>
            ))}
          </div>
        </>
      )}

      {!found && (
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

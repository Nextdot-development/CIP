'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { FilePreview } from '@/components/drive/FilePreview';
import { useToast } from '@/context/toast';
import { ACCEPT_ATTRIBUTE, humanSize, isExtractable } from '@/lib/fileTypes';
import type { FileKind } from '@/lib/fileTypes';
import { relativeDay } from '@/lib/format';
import type { DriveFileDTO, DriveListingDTO, DriveSearchResultDTO, SemanticSearchDTO } from '@/types/drive';

/**
 * The Company Drive.
 *
 * The folder id travels in the URL, and the server checks it belongs to this
 * company before returning anything — so a pasted link to another company's
 * folder is a 404, not a leak. Nothing here filters by company, because only
 * one company's rows ever arrive.
 */

const KIND_ICON: Record<FileKind, IconName> = {
  document: 'doc',
  spreadsheet: 'sheet',
  presentation: 'slides',
  image: 'image',
  video: 'video',
  audio: 'music',
  data: 'grid',
};

const KIND_TINT: Record<FileKind, { bg: string; fg: string }> = {
  document: { bg: 'var(--ink-050)', fg: 'var(--ink-600)' },
  spreadsheet: { bg: 'var(--ok-050)', fg: 'var(--ok-700)' },
  presentation: { bg: 'var(--warn-050)', fg: 'var(--warn-700)' },
  image: { bg: 'var(--brand-soft)', fg: 'var(--brand-deep)' },
  video: { bg: 'var(--info-050)', fg: 'var(--info-700)' },
  audio: { bg: 'var(--info-050)', fg: 'var(--info-700)' },
  data: { bg: 'var(--ink-050)', fg: 'var(--ink-600)' },
};

const KINDS: { id: FileKind; label: string }[] = [
  { id: 'document', label: 'Documents' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'spreadsheet', label: 'Spreadsheets' },
  { id: 'presentation', label: 'Presentations' },
  { id: 'data', label: 'Data' },
];

/**
 * Which market a file's knowledge belongs to.
 *
 * Shown because it decides which briefs draw on this file: a deck labelled
 * India shapes Indian work and stays out of Nigerian work. The label is a
 * suggestion read off the filename, so it has to be correctable — a wrong one
 * quietly shaping every brief is worse than no label at all.
 */
function MarketChip({ file }: { file: DriveFileDTO }) {
  const { note } = useToast();
  const [market, setMarket] = useState(file.market);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file.market ?? '');

  const save = async (value: string | null) => {
    const res = await fetch(`/api/drive/files/${file.id}/market`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market: value }),
    });
    if (!res.ok) {
      note('That could not be saved.');
      return;
    }
    setMarket(value);
    setEditing(false);
    note(value ? `Filed under ${value}` : 'Market cleared');
  };

  if (editing) {
    return (
      <input
        className="market-input"
        value={draft}
        autoFocus
        placeholder="Market…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save(draft.trim() || null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save(draft.trim() || null);
          if (e.key === 'Escape') setEditing(false);
        }}
        aria-label="Which market this file belongs to"
      />
    );
  }

  return (
    <button
      type="button"
      className={`market-chip ${market ? 'set' : ''}`}
      onClick={() => {
        setDraft(market ?? '');
        setEditing(true);
      }}
      title={
        market
          ? `Filed under ${market}. Click to change.`
          : 'No market — this counts towards every market. Click to set one.'
      }
    >
      <Icon name="link" size={12} /> {market ?? 'Any market'}
    </button>
  );
}

/**
 * What CIP has made of a file.
 *
 * Every file gets read. What differs is how: a document by its words, an image
 * or a video by looking at it, a PDF of screenshots by looking at every page.
 *
 * This used to report only the text-extraction status, which meant an image
 * said "Not read yet" for ever — it is never extracted as text, so that status
 * never moves — and a 53 MB PDF with 126 posts pulled out of it said "Waiting
 * to be read". Both had been read. Understanding is what the label follows
 * now, and extraction only fills in while the Brain has not reached the file.
 *
 * A failed read is amber, not red: it needs attention, but it does not stop
 * anything shipping.
 */
function ProcessingChip({ file }: { file: DriveFileDTO }) {
  const understanding = file.understanding;

  if (understanding) {
    switch (understanding.status) {
      case 'ready':
        return (
          <span className="proc proc-ready" title={readTitle(understanding.kind)}>
            {readLabel(understanding.kind)}
          </span>
        );
      case 'processing':
        return (
          <span className="proc proc-reading">
            <span className="spin" aria-hidden="true" /> Reading
          </span>
        );
      case 'failed':
        return <span className="proc proc-failed">Could not read</span>;
      case 'unsupported':
        return (
          <span className="proc proc-none" title="CIP looked at this one and could not use it">
            Nothing to learn
          </span>
        );
      default:
        return <span className="proc proc-waiting">Waiting to be read</span>;
    }
  }

  // Not queued for the Brain yet. For a text type, extraction is the step in
  // front of it and is worth showing; for anything else, the queue simply has
  // not reached it.
  if (isExtractable(file.fileType)) {
    switch (file.processingStatus) {
      case 'processed':
        return <span className="proc proc-ready">Text ready</span>;
      case 'processing':
        return (
          <span className="proc proc-reading">
            <span className="spin" aria-hidden="true" /> Reading
          </span>
        );
      case 'failed':
        return <span className="proc proc-failed">Could not read</span>;
      default:
        return <span className="proc proc-waiting">Waiting to be read</span>;
    }
  }

  return <span className="proc proc-waiting">Waiting to be read</span>;
}

/** What "read" meant for this kind of file, in the words a person would use. */
function readLabel(kind: string): string {
  if (kind === 'image') return 'Looked at';
  if (kind === 'video') return 'Watched';
  if (kind === 'pdf_visual') return 'Pages read';
  return 'Read';
}

function readTitle(kind: string): string {
  if (kind === 'image') return 'CIP has looked at this image and knows what is in it';
  if (kind === 'video') return 'CIP has watched this video and listened to its audio';
  if (kind === 'pdf_visual') return 'This PDF had no text layer, so CIP read every page by looking at it';
  return 'CIP has read this and learned from it';
}

type Upload = { id: string; name: string; status: 'uploading' | 'failed'; message?: string };
type Renaming = { id: string; type: 'file' | 'folder'; value: string };

export function DriveSection({
  listing,
  /** Rendered inside Teach, which supplies its own heading. */
  embedded = false,
}: {
  listing: DriveListingDTO;
  embedded?: boolean;
}) {
  const router = useRouter();
  const { note } = useToast();

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<FileKind | null>(null);
  const [results, setResults] = useState<DriveSearchResultDTO | null>(null);
  const [mode, setMode] = useState<'name' | 'meaning'>('name');
  const [meaning, setMeaning] = useState<SemanticSearchDTO | null>(null);
  const [searchingByMeaning, setSearchingByMeaning] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [preview, setPreview] = useState<DriveFileDTO | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const folderId = listing.folder?.id ?? null;
  const searching = query.trim().length >= 2;

  // Search runs on the server, so it can only ever see this company.
  useEffect(() => {
    if (!searching) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim() });
      if (kind) params.set('kind', kind);
      fetch(`/api/drive/search?${params}`)
        .then((r) => r.json())
        .then(setResults)
        .catch(() => note('Search is unavailable right now'));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, kind, searching, note]);

  const call = useCallback(
    async (input: string, init: RequestInit): Promise<boolean> => {
      const res = await fetch(input, init);
      if (res.ok) {
        router.refresh();
        return true;
      }
      const body = await res.json().catch(() => ({ message: 'Something went wrong.' }));
      note(body.message ?? 'Something went wrong.');
      return false;
    },
    [router, note],
  );

  const upload = useCallback(
    async (chosen: FileList | File[]) => {
      for (const file of Array.from(chosen)) {
        const id = `${file.name}-${Date.now()}-${Math.random()}`;
        setUploads((u) => [...u, { id, name: file.name, status: 'uploading' }]);

        const form = new FormData();
        form.append('file', file);
        if (folderId) form.append('folderId', folderId);

        const res = await fetch('/api/drive/files', { method: 'POST', body: form });
        if (res.ok) {
          setUploads((u) => u.filter((x) => x.id !== id));
          router.refresh();
        } else {
          const body = await res.json().catch(() => ({ message: 'Upload failed.' }));
          setUploads((u) =>
            u.map((x) => (x.id === id ? { ...x, status: 'failed' as const, message: body.message } : x)),
          );
        }
      }
    },
    [folderId, router],
  );

  const runSemanticSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setSearchingByMeaning(true);
    try {
      const res = await fetch('/api/drive/search/semantic', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, limit: 20, folderId, fileTypes: kind ? [kind] : null }),
      });
      if (res.status === 429) {
        note('That is a lot of searching. Give it a moment.');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: 'Search is unavailable.' }));
        note(body.message ?? 'Search is unavailable.');
        return;
      }
      setMeaning((await res.json()) as SemanticSearchDTO);
    } finally {
      setSearchingByMeaning(false);
    }
  }, [query, folderId, kind, note]);

  const createFolder = async () => {
    const name = window.prompt('Name this folder');
    if (!name || !name.trim()) return;
    const ok = await call('/api/drive/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: folderId, name }),
    });
    if (ok) note(`Created "${name.trim()}"`);
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { id, type, value } = renaming;
    setRenaming(null);
    if (!value.trim()) return;
    await call(`/api/drive/${type === 'file' ? 'files' : 'folders'}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: value }),
    });
  };

  const reprocess = async (id: string, name: string) => {
    const ok = await call(`/api/drive/files/${id}/reprocess`, { method: 'POST' });
    if (ok) note(`${name} is back in the queue`);
  };

  const archive = async (id: string, type: 'file' | 'folder', name: string) => {
    const what = type === 'folder' ? `"${name}" and everything in it` : `"${name}"`;
    if (!window.confirm(`Move ${what} to the archive? You can restore it later.`)) return;
    const ok = await call(`/api/drive/${type === 'file' ? 'files' : 'folders'}/${id}`, { method: 'DELETE' });
    if (ok) note(`Moved ${name} to the archive`);
  };

  // Stale results from a previous query are simply not shown, rather than
  // cleared from an effect.
  const shown = searching && results && results.query === query.trim() ? results : null;
  const folders = searching ? shown?.folders ?? [] : listing.folders;
  const files = searching ? shown?.files ?? [] : listing.files;
  const nothingHere = folders.length === 0 && files.length === 0;
  const matchCount = folders.length + files.length;

  return (
    <div className="rise">
      {!embedded && (
        <header className="page-head">
          <p className="eyebrow">Drive</p>
          <h1>Company Drive</h1>
          <p className="lede">
            Everything your brand runs on, in one place. Only your company can see any of it.
          </p>
        </header>
      )}

      <div className="drive-bar">
        <nav className="crumbs" aria-label="Breadcrumb">
          {listing.breadcrumbs.map((crumb, i) => {
            const last = i === listing.breadcrumbs.length - 1;
            return (
              <span key={crumb.id ?? 'root'} className="row gap-6">
                {i > 0 && (
                  <span className="sep">
                    <Icon name="chevron-right" size={14} />
                  </span>
                )}
                <button
                  type="button"
                  className={`crumb ${last ? 'current' : ''}`}
                  onClick={() => router.push(crumb.id ? `/teach?folder=${crumb.id}` : '/teach')}
                  aria-current={last ? 'page' : undefined}
                >
                  {i === 0 && <Icon name="drive" size={15} />}
                  {crumb.name}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="drive-actions">
          <label className="drive-search">
            <Icon name="search" size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search this Drive..."
              aria-label="Search the Drive"
            />
            {query && (
              <button type="button" className="clear" onClick={() => setQuery('')} aria-label="Clear search">
                <Icon name="close" size={14} />
              </button>
            )}
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={createFolder}>
            <Icon name="folder-plus" size={15} /> New folder
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={15} /> Upload
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT_ATTRIBUTE}
            hidden
            onChange={(e) => {
              if (e.target.files && e.target.files.length) void upload(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {searching && (
        <div className="kind-filters">
          <button
            type="button"
            className={`kind-chip ${mode === 'name' ? 'on' : ''}`}
            onClick={() => { setMode('name'); setMeaning(null); }}
          >
            By name
          </button>
          <button
            type="button"
            className={`kind-chip ${mode === 'meaning' ? 'on' : ''}`}
            onClick={() => { setMode('meaning'); void runSemanticSearch(); }}
            title="Find passages that mean the same thing, even in different words"
          >
            By meaning
          </button>
          <span className="filter-divider" aria-hidden="true" />
          <button type="button" className={`kind-chip ${kind === null ? 'on' : ''}`} onClick={() => setKind(null)}>
            Everything
          </button>
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`kind-chip ${kind === k.id ? 'on' : ''}`}
              onClick={() => setKind(kind === k.id ? null : k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}

      {!searching && (
        <div
          className={`dropzone ${dragging ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
          }}
        >
          Drop files here to add them to <b className="strong">{listing.folder?.name ?? 'your Drive'}</b>, or use Upload.
          <br />
          <span className="tiny">PDF, Office documents, CSV, images, video and audio. Up to 50 MB each.</span>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="upload-list">
          {uploads.map((u) => (
            <div key={u.id} className={`upload-item ${u.status === 'failed' ? 'failed' : ''}`}>
              {u.status === 'uploading' ? (
                <span className="spinner-sm" aria-hidden="true" />
              ) : (
                <Icon name="alert" size={15} />
              )}
              <span className="name">{u.name}</span>
              <span className="grow tiny">{u.status === 'failed' ? u.message : 'Uploading...'}</span>
              {u.status === 'failed' && (
                <button
                  type="button"
                  className="fr-btn"
                  onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}
                  aria-label="Dismiss"
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {searching && mode === 'meaning' && (
        <Card title={`Passages matching "${query.trim()}"`}>
          {searchingByMeaning ? (
            <p className="small muted" style={{ padding: '14px 0' }}>Reading your Drive...</p>
          ) : meaning === null ? (
            <p className="small muted" style={{ padding: '14px 0' }}>
              Press <b className="strong">By meaning</b> again to search.
            </p>
          ) : meaning.hits.length === 0 ? (
            <p className="small muted" style={{ padding: '14px 0' }}>
              Nothing in your Drive covers that yet.
            </p>
          ) : (
            meaning.hits.map((hit) => (
              <div className="passage" key={hit.chunkId}>
                <span className="stack grow">
                  <span className="p-where">
                    {hit.folderName ? `${hit.folderName} / ` : ''}
                    <b className="strong">{hit.fileName}</b>
                    {hit.heading ? ` · ${hit.heading}` : ''}
                  </span>
                  <span className="p-text">{hit.snippet}</span>
                </span>
                <a className="fr-btn" href={`/api/drive/files/${hit.fileId}/content`} download aria-label={`Download ${hit.fileName}`}>
                  <Icon name="download" size={15} />
                </a>
              </div>
            ))
          )}
        </Card>
      )}

      {searching && mode === 'name' && (
        <p className="drive-count">
          {matchCount === 0
            ? `Nothing matches "${query.trim()}"`
            : `${matchCount} match${matchCount === 1 ? '' : 'es'} for "${query.trim()}"`}
        </p>
      )}

      {(!searching || mode === 'name') && folders.length > 0 && (
        <div className="folder-grid">
          {folders.map((f) => (
            <div key={f.id} className="folder-card">
              <span className="f-icon">
                <Icon name="folder" size={18} />
              </span>
              {renaming && renaming.id === f.id ? (
                <input
                  className="rename-input"
                  autoFocus
                  value={renaming.value}
                  onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  aria-label="Folder name"
                />
              ) : (
                <button type="button" className="folder-open" onClick={() => router.push(`/teach?folder=${f.id}`)}>
                  <span className="f-name truncate">{f.name}</span>
                  <span className="f-meta">Added {relativeDay(f.createdAt)}</span>
                </button>
              )}
              <span className="fr-actions always">
                <button
                  type="button"
                  className="fr-btn"
                  onClick={() => setRenaming({ id: f.id, type: 'folder', value: f.name })}
                  aria-label={`Rename ${f.name}`}
                >
                  <Icon name="pencil" size={14} />
                </button>
                <button
                  type="button"
                  className="fr-btn danger"
                  onClick={() => archive(f.id, 'folder', f.name)}
                  aria-label={`Archive ${f.name}`}
                >
                  <Icon name="trash" size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {(!searching || mode === 'name') && (
      <Card title={searching ? 'Matching files' : listing.folder ? listing.folder.name : 'Files'}>
        {files.length === 0 ? (
          nothingHere && !searching ? (
            <EmptyState
              icon="drive"
              title={listing.folder ? `${listing.folder.name} is empty` : 'Your Drive is empty'}
              copy="Add your brand guidelines, logos, product shots and past campaigns. CIP will read them once the Brand Brain is switched on."
              action={
                <button type="button" className="btn btn-primary btn-sm" onClick={() => fileInput.current?.click()}>
                  Upload your first file
                </button>
              }
            />
          ) : (
            <p className="small muted" style={{ padding: '14px 0' }}>
              {searching ? 'No files match that search.' : 'No files here yet — the folders above hold everything.'}
            </p>
          )
        ) : (
          files.map((f) => {
            const tint = KIND_TINT[f.kind];
            const where = (f as { folderName?: string | null }).folderName;
            return (
              <div className="file-row" key={f.id}>
                <span className="fr-icon" style={{ background: tint.bg, color: tint.fg }}>
                  <Icon name={KIND_ICON[f.kind]} size={18} />
                </span>
                <span className="stack grow">
                  {renaming && renaming.id === f.id ? (
                    <input
                      className="rename-input"
                      autoFocus
                      value={renaming.value}
                      onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      aria-label="File name"
                    />
                  ) : (
                    <button type="button" className="fr-name truncate file-open" onClick={() => setPreview(f)}>
                      {f.name}
                    </button>
                  )}
                  <span className="fr-meta row gap-8" style={{ flexWrap: 'wrap' }}>
                    <span>
                      {humanSize(f.fileSize)} · Added {relativeDay(f.createdAt)}
                      {f.uploadedBy ? ` by ${f.uploadedBy.name}` : ''}
                      {searching && where ? ` · in ${where}` : ''}
                    </span>
                    <MarketChip file={f} />
                    <MarketChip file={f} />
                <ProcessingChip file={f} />
                  </span>
                </span>
                <span className="fr-actions">
                  {f.processingStatus === 'failed' && isExtractable(f.fileType) && (
                    <button
                      type="button"
                      className="fr-btn"
                      onClick={() => reprocess(f.id, f.name)}
                      aria-label={`Try reading ${f.name} again`}
                      title="Try reading this file again"
                    >
                      <Icon name="restore" size={15} />
                    </button>
                  )}
                  <button type="button" className="fr-btn" onClick={() => setPreview(f)} aria-label={`Preview ${f.name}`}>
                    <Icon name="search" size={15} />
                  </button>
                  <a
                    className="fr-btn"
                    href={`/api/drive/files/${f.id}/content`}
                    download={f.name}
                    aria-label={`Download ${f.name}`}
                  >
                    <Icon name="download" size={15} />
                  </a>
                  <button
                    type="button"
                    className="fr-btn"
                    onClick={() => setRenaming({ id: f.id, type: 'file', value: f.name })}
                    aria-label={`Rename ${f.name}`}
                  >
                    <Icon name="pencil" size={15} />
                  </button>
                  <button
                    type="button"
                    className="fr-btn danger"
                    onClick={() => archive(f.id, 'file', f.name)}
                    aria-label={`Archive ${f.name}`}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </span>
              </div>
            );
          })
        )}
      </Card>
      )}

      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

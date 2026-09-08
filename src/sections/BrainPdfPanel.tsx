'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Pill } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import type { PdfPageDTO, PdfPostDTO, PdfSummaryDTO } from '@/types/brain';

/**
 * How CIP read each PDF, and what it saw.
 *
 * A PDF of Instagram posts has no text layer, so it is read by rendering each
 * page and looking at it. That is expensive and fallible in ways reading text
 * is not — a page can render blank, a model can refuse one — so this view
 * reports the run honestly: pages attempted, pages understood, pages failed
 * and why.
 *
 * The rendered page sits next to what was extracted from it, because that is
 * what makes a claim checkable. "Page 7 says the call to action is 'Tag a
 * friend'" is worth something only when page 7 can be looked at.
 */

function ms(value: number | null): string {
  if (value === null || value <= 0) return '—';
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function BrainPdfPanel() {
  const [pdfs, setPdfs] = useState<PdfSummaryDTO[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ pages: PdfPageDTO[]; posts: PdfPostDTO[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/brain/pdf', { cache: 'no-store' });
      if (res.ok) setPdfs(((await res.json()) as { pdfs: PdfSummaryDTO[] }).pdfs);
      else setPdfs([]);
    })();
  }, []);

  const inspect = useCallback(
    async (fileId: string) => {
      if (open === fileId) {
        setOpen(null);
        setDetail(null);
        return;
      }
      setOpen(fileId);
      setDetail(null);
      setLoading(true);
      const res = await fetch(`/api/brain/pdf/${fileId}`, { cache: 'no-store' });
      if (res.ok) setDetail((await res.json()) as { pages: PdfPageDTO[]; posts: PdfPostDTO[] });
      setLoading(false);
    },
    [open],
  );

  if (pdfs === null) return <Card title="PDFs"><p className="small muted">Loading…</p></Card>;

  if (pdfs.length === 0) {
    return (
      <Card title="PDFs">
        <p className="small muted">
          No PDFs yet. Upload one to the Drive and CIP will read it — by its text where it has
          any, and by looking at each page where it does not.
        </p>
      </Card>
    );
  }

  return (
    <Card title="PDFs">
      {pdfs.map((pdf) => {
        const visual = pdf.kind === 'pdf_visual';
        const isOpen = open === pdf.fileId;

        return (
          <div key={pdf.fileId} className="stack" style={{ marginBottom: 14 }}>
            <div className="gen-row">
              <span className="gen-thumb"><Icon name="doc" size={16} /></span>
              <span className="stack grow">
                <span className="gen-prompt">{pdf.name}</span>
                <span className="small muted">
                  {bytes(pdf.fileSize)}
                  {pdf.pageCount > 0 ? ` · ${pdf.pageCount} page${pdf.pageCount === 1 ? '' : 's'}` : ''}
                  {pdf.pagesProcessed > 0 ? ` · ${pdf.pagesProcessed} rendered` : ''}
                  {pdf.pagesUnderstood > 0 ? ` · ${pdf.pagesUnderstood} understood` : ''}
                  {pdf.pagesWithText > 0 ? ` · ${pdf.pagesWithText} with a text layer` : ''}
                  {pdf.postsDetected > 0 ? ` · ${pdf.postsDetected} post${pdf.postsDetected === 1 ? '' : 's'}` : ''}
                  {pdf.pagesFailed > 0 ? ` · ${pdf.pagesFailed} failed` : ''}
                  {pdf.processingMs ? ` · ${ms(pdf.processingMs)}` : ''}
                </span>
                {pdf.error && <span className="small" style={{ color: 'var(--danger, #c33)' }}>{pdf.error}</span>}
              </span>
              <Pill tone={pdf.status === 'ready' ? 'ok' : pdf.status === 'failed' ? 'stop' : 'neutral'}>
                {visual ? 'read visually' : pdf.status}
              </Pill>
              <button type="button" className="btn btn-sm" onClick={() => void inspect(pdf.fileId)}>
                {isOpen ? 'Hide' : 'Inspect'}
              </button>
            </div>

            {isOpen && loading && <p className="small muted">Loading pages…</p>}

            {isOpen && detail && detail.pages.length === 0 && (
              <p className="small muted">
                No pages were rendered for this PDF. It was read as text, or it could not be read.
              </p>
            )}

            {isOpen && detail && detail.pages.map((page) => {
              const posts = detail.posts.filter((post) => post.pageNumber === page.pageNumber);

              return (
                <div key={page.id} className="pdf-page">
                  <div className="pdf-page-image">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={page.imageUrl}
                      alt={`Page ${page.pageNumber}`}
                      loading="lazy"
                      width={page.width ?? undefined}
                      height={page.height ?? undefined}
                    />
                    <span className="small muted">
                      Page {page.pageNumber}
                      {page.hasTextLayer ? ' · has a text layer' : ' · no text layer'}
                      {page.durationMs ? ` · ${ms(page.durationMs)}` : ''}
                    </span>
                  </div>

                  <div className="pdf-page-detail stack">
                    {page.status === 'failed' ? (
                      <p className="small" style={{ color: 'var(--danger, #c33)' }}>
                        {page.errorMessage ?? 'This page could not be understood.'}
                      </p>
                    ) : (
                      <>
                        <p className="small">{page.summary}</p>

                        {posts.length === 0 ? (
                          <p className="small muted">No distinct posts on this page.</p>
                        ) : (
                          posts.map((post) => (
                            <div key={post.id} className="pdf-post">
                              <span className="small">
                                <strong>Post {post.postIndex + 1}</strong>
                                {post.country ? ` · ${post.country}` : ''}
                                {' · '}
                                {/* Said plainly rather than shown as a bar: a
                                    number a person can argue with is more
                                    useful than a graphic they cannot. */}
                                confidence {post.confidence.toFixed(2)}
                                <span className="muted"> · page {post.pageNumber}</span>
                              </span>
                              {post.headline && <span className="small">{post.headline}</span>}
                              {post.caption && <span className="small muted">{post.caption}</span>}
                              {post.summary && <span className="small muted">{post.summary}</span>}
                              <Structured data={post.structured} />
                              {post.visibleText && (
                                <details>
                                  <summary className="small muted">Text on this post</summary>
                                  <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>
                                    {post.visibleText}
                                  </p>
                                </details>
                              )}
                            </div>
                          ))
                        )}

                        <details>
                          <summary className="small muted">What this page showed</summary>
                          <Structured data={page.structured} />
                        </details>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </Card>
  );
}

/** Structured fields, skipping the ones with nothing in them. */
function Structured({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, value]) => {
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });

  if (entries.length === 0) return null;

  return (
    <div className="pdf-structured">
      {entries.map(([key, value]) => (
        <span key={key} className="small">
          <span className="muted">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}: </span>
          {Array.isArray(value) ? value.join(', ') : String(value)}
        </span>
      ))}
    </div>
  );
}

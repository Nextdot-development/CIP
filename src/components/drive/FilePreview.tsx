'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { humanSize, specFor } from '@/lib/fileTypes';
import type { DriveFileDTO } from '@/types/drive';

/**
 * Shows a file without downloading it, where the browser can be trusted to.
 *
 * Everything is fetched from our own content route, which proves the session
 * first. SVG is deliberately never rendered inline — it can carry script, and
 * this is our own origin.
 */
export function FilePreview({ file, onClose }: { file: DriveFileDTO; onClose: () => void }) {
  const spec = specFor(file.name);
  const src = `/api/drive/files/${file.id}/content?disposition=inline`;
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isText = spec?.extension === 'txt' || spec?.extension === 'csv';

  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => !cancelled && setText(t.slice(0, 20000)))
      .catch(() => !cancelled && setTextError(true));
    return () => {
      cancelled = true;
    };
  }, [src, isText]);

  return (
    <div className="preview-scrim" onClick={onClose} role="presentation">
      <div
        className="preview-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Preview of ${file.name}`}
      >
        <header className="preview-head">
          <span className="stack grow">
            <span className="p-title truncate">{file.name}</span>
            <span className="p-meta">
              {spec?.label ?? file.fileType.toUpperCase()} · {humanSize(file.fileSize)}
            </span>
          </span>
          <span className="p-actions">
            <a className="btn btn-ghost btn-sm" href={`/api/drive/files/${file.id}/content`} download={file.name}>
              <Icon name="download" size={15} /> Download
            </a>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close preview">
              <Icon name="close" size={18} />
            </button>
          </span>
        </header>

        <div className="preview-body">
          {file.kind === 'image' && spec?.extension !== 'svg' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={file.name} />
          )}
          {file.kind === 'video' && <video src={src} controls playsInline />}
          {file.kind === 'audio' && <audio src={src} controls style={{ width: 'min(520px, 80vw)' }} />}
          {spec?.extension === 'pdf' && <iframe src={src} title={file.name} />}
          {isText && (
            textError ? (
              <p className="preview-none">We could not read that file.</p>
            ) : text === null ? (
              <span className="spinner" aria-label="Loading" />
            ) : (
              <pre>{text}</pre>
            )
          )}
          {!file.previewable && (
            <p className="preview-none">
              This file type opens in its own application. Download it to take a look.
            </p>
          )}
          {spec?.extension === 'svg' && (
            <p className="preview-none">
              SVGs can contain code, so we do not display them here. Download it to open it safely.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

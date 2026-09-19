'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from './ui/Icon';

/**
 * "Add data to brain", from anywhere.
 *
 * Uploads go to the same place the Add data page sends them, and are read by
 * the same pipeline. Nothing here claims a file has been learned from: it
 * says a file arrived, because learning from it happens afterwards and takes
 * as long as it takes.
 */
type Row = { id: string; name: string; status: 'uploading' | 'done' | 'failed'; message?: string };

export function AddDataModal({
  brand,
  brands,
  house,
  onClose,
}: {
  brand: string | null;
  /** The company's roster, so a file can be filed under the right brand. */
  brands: string[];
  house: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState(false);
  // Starts on the brand chosen in the sidebar. A file whose name says nothing
  // about its brand - IMG_2034.jpg - otherwise belongs to no brand, and reaches
  // every brand's briefs.
  const [brandChoice, setBrandChoice] = useState(brand ?? '');
  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const upload = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const id = `${file.name}-${Date.now()}-${Math.random()}`;
      setRows((r) => [...r, { id, name: file.name, status: 'uploading' }]);
      const form = new FormData();
      form.append('file', file);
      if (brandChoice) form.append('brand', brandChoice);
      const res = await fetch('/api/drive/files', { method: 'POST', body: form }).catch(() => null);
      if (res?.ok) {
        setRows((r) => r.map((x) => (x.id === id ? { ...x, status: 'done' } : x)));
      } else {
        const body: { message?: string } = res ? await res.json().catch(() => ({})) : {};
        const message = body.message ?? 'Upload failed.';
        setRows((r) => r.map((x) => (x.id === id ? { ...x, status: 'failed', message } : x)));
      }
    }
    router.refresh();
  };

  const uploading = rows.some((r) => r.status === 'uploading');

  /**
   * Into the body, not into the sidebar it is written in.
   *
   * The sidebar is `position: sticky`, and a sticky element makes its own
   * stacking context whatever its z-index. Everything inside it is then stacked
   * against its siblings rather than against the page, so a dialog that says
   * `z-index: 100` sits behind the page it is covering: the hero card and the
   * composer drew straight over the top of it.
   *
   * Raising the number would not have helped. The dialog has to leave the
   * sidebar, and a portal is how it leaves while staying this component's
   * child for state, focus and the Escape key.
   *
   * No guard for the server: this is only ever rendered after somebody presses
   * the button, so `document` is always there by the time it runs.
   */
  return createPortal(
    <div
      className="modalback"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !uploading) onClose();
      }}
    >
      <div className="modalpanel" role="dialog" aria-modal="true" aria-labelledby="add-data-title">
        <button ref={closeButton} type="button" className="modalclose" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
        <h3 id="add-data-title">Add data to the brain — {brand ?? house}</h3>
        <p className="sub">
          Anything you add is read and folded into what CIP knows: visual identity, tone, compliance
          rules and searchable history.
        </p>

        {brands.length > 0 && (
          <label className="modalfield" htmlFor="add-data-brand">
            <span>Which brand are these files about?</span>
            <select id="add-data-brand" value={brandChoice} onChange={(event) => setBrandChoice(event.target.value)}>
              <option value="">Let CIP work it out from each file name</option>
              {brands.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
        )}

        <button
          type="button"
          className={`dropzone ${dragging ? 'is-over' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
          }}
        >
          <Icon name="upload" size={26} />
          <span className="t">Drag files here, or click to browse</span>
          <span className="f">Images, PDFs, brand guideline docs, presentations, video files</span>
        </button>
        <input
          id="add-data-files"
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files?.length) void upload(event.target.files);
            event.target.value = '';
          }}
        />

        {rows.length > 0 && (
          <ul className="uploadlist">
            {rows.map((row) => (
              <li key={row.id} className={`is-${row.status}`}>
                <Icon name={row.status === 'failed' ? 'alert' : row.status === 'done' ? 'check' : 'clock'} size={14} />
                <span className="truncate grow">{row.name}</span>
                <span className="tiny">
                  {row.status === 'uploading'
                    ? 'Uploading…'
                    : row.status === 'done'
                      ? 'Added — reading it now'
                      : row.message}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="modalnote">
          New files are read automatically, with no retraining step. To keep a whole Google Drive
          folder in sync instead,{' '}
          <Link href="/teach" onClick={onClose}>
            connect it on the Add data page
          </Link>
          .
        </p>
        <div className="modalactions">
          <button type="button" className="btnghost" onClick={onClose} disabled={uploading}>
            {rows.length > 0 && !uploading ? 'Done' : 'Cancel'}
          </button>
          <button type="button" className="btnprimary" onClick={() => input.current?.click()} disabled={uploading}>
            Upload
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

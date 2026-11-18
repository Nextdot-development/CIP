'use client';

import { useRef, useState } from 'react';
import { Icon } from '../components/ui/Icon';
import { useToast } from '@/context/toast';
import { RulesReport, type RuleVerdict } from './PostRulesCheck';

type Report = { brand: string; market: string | null; kind: 'image' | 'pdf' | 'video'; read: 'pdf-text' | 'none'; verdicts: RuleVerdict[] };

/**
 * Creative QC with no model: a creative brought in - a banner, a deck page, a PDF from an agency -
 * checked against its brand's and market's rules. The file is read for this check and kept nowhere,
 * so nothing goes on to read it with AI either. Nothing is spent.
 */
export function FreeQc({ brands, activeBrand, markets, held }: {
  brands: string[];
  activeBrand: string | null;
  markets: string[];
  held: { id: string; name: string; kind: string }[];
}) {
  const { note } = useToast();
  const [brand, setBrand] = useState(activeBrand ?? '');
  const [market, setMarket] = useState(markets[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ name: string; report: Report } | null>(null);
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const results = useRef<HTMLDivElement>(null);

  const run = async (name: string, body: FormData | { fileId: string }) => {
    if (!brand) { note('Choose the brand first - the rules are the brand\'s own.'); return; }
    setBusy(true);
    setReport(null);
    const res = await fetch('/api/brain/qc/free', body instanceof FormData
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, brand, market: market || null }) }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const message = (await res?.json().catch(() => null) as { message?: string } | null)?.message;
      note(message ?? 'That could not be checked.');
      return;
    }
    setReport({ name, report: (await res.json()) as Report });
    setTimeout(() => results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  const checkFile = (file: File) => {
    const form = new FormData();
    form.append('file', file);
    form.append('brand', brand);
    if (market) form.append('market', market);
    void run(file.name, form);
  };

  const shown = held.filter((f) => !search || f.name.toLowerCase().includes(search.toLowerCase())).slice(0, 30);

  return (
    <section className="rules-qc" aria-label="Check a creative against the rules">
      <div className="rules-qc-head">
        <div>
          <p className="eyebrow" style={{ margin: 0 }}>Creative QC</p>
          <h2 style={{ margin: '2px 0 4px' }}>Check it before it goes out - free</h2>
          <p className="tiny muted" style={{ margin: 0 }}>
            Bring a banner, a deck page or a PDF. It is checked against the brand&apos;s and the market&apos;s rules with no AI and nothing spent,
            and kept nowhere. A PDF&apos;s words are read and checked; its logo, its pack and its picture are a list for you to look at.
          </p>
        </div>
        <span className="rules-qc-free">Free · no AI</span>
      </div>

      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="modalfield" style={{ margin: 0 }}>
          <span>Brand</span>
          <select value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">Choose the brand</option>
            {brands.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label className="modalfield" style={{ margin: 0 }}>
          <span>Market</span>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="">Every market</option>
            {markets.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>

      <label
        className={`rules-qc-drop ${dragging ? 'is-on' : ''} ${busy || !brand ? 'is-off' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f && brand) checkFile(f); }}
      >
        <Icon name="upload" size={18} />
        <span>{busy ? 'Checking…' : brand ? 'Drop a creative here, or click to choose one' : 'Choose the brand first'}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf,video/mp4,video/quicktime,video/webm" hidden disabled={busy || !brand}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) checkFile(f); }} />
      </label>

      {held.length > 0 && (
        <details>
          <summary className="tiny muted" style={{ cursor: 'pointer' }}>Or check a file already in Drive</summary>
          <input className="field-input" style={{ margin: '8px 0' }} placeholder="Find by name" value={search} onChange={(e) => setSearch(e.target.value)} />
          <ul className="rules-qc-list">
            {shown.map((f) => (
              <li key={f.id}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !brand} onClick={() => void run(f.name, { fileId: f.id })}>Check</button>
                <span className="tiny">{f.name} <span className="muted">· {f.kind}</span></span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div ref={results}>
        {report && (
          <RulesReport
            title={`${report.name} - ${report.report.brand}${report.report.market ? ` · ${report.report.market}` : ''}`}
            verdicts={report.report.verdicts}
            note={report.report.read === 'pdf-text'
              ? 'Its words were read from the PDF and checked against every rule about words.'
              : report.report.kind === 'pdf'
                ? 'This PDF holds no text of its own (a picture saved as PDF): its words are on the list to look at.'
                : 'A picture\'s words cannot be read without a text reader (OCR), so rules about words are on the list to look at.'}
          />
        )}
      </div>
    </section>
  );
}

import { useEffect, useRef } from 'react';
import { Icon } from './ui/Icon';
import type { AskMode } from '../context/NavContext';

/**
 * The one primary action of the product: say what you need, in your own words.
 *
 * Two ways out of the box, and the difference is stated in plain language:
 * generate it now on your own, or hand it to your pod to be made and checked.
 */
export function RequestComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  autoFocus = false,
  podCta = 'Create with pod',
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (mode: AskMode) => void;
  placeholder: string;
  autoFocus?: boolean;
  podCta?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const empty = !value.trim();

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 58)}px`;
  }, [value]);

  return (
    <div className="composer">
      <div className="composer-top">
        <Icon name="sparkle" size={20} className="spark" />
        <textarea
          ref={ref}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit('pod');
            }
          }}
          aria-label="Tell us what you need"
          rows={1}
        />
      </div>
      <div className="composer-foot">
        <div className="composer-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onSubmit('instant')}
            disabled={empty}
            title="A first draft in a couple of minutes, before any checks"
          >
            <Icon name="bolt" size={16} /> Generate instantly
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onSubmit('pod')} disabled={empty}>
            {podCta} <Icon name="arrow-right" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function PromptSuggestions({
  lead,
  items,
  onPick,
}: {
  lead?: string;
  items: string[];
  onPick: (s: string) => void;
}) {
  return (
    <div className="suggests">
      {lead && <span className="lead">{lead}</span>}
      {items.map((s) => (
        <button key={s} type="button" className="chip" onClick={() => onPick(s)}>
          {s}
        </button>
      ))}
    </div>
  );
}

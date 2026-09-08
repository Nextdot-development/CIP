import { useEffect, useRef } from 'react';
import { Icon } from './ui/Icon';
import type { AskMode } from '../context/NavContext';

/**
 * The one primary action of the product: say what you need, in your own words.
 *
 * One way out of the box, because there is only one that works. There used to
 * be two — generate it now, or hand it to your pod to be made and checked —
 * and the second had nothing behind it: no queue, no handoff, no one to
 * receive it. Both buttons led to the same place and did the same thing, while
 * promising different things.
 */
export function RequestComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (mode: AskMode) => void;
  placeholder: string;
  autoFocus?: boolean;
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
              onSubmit('instant');
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
            className="btn btn-primary"
            onClick={() => onSubmit('instant')}
            disabled={empty}
            title="CIP plans it against your brand, then makes it"
          >
            <Icon name="bolt" size={16} /> Make it
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

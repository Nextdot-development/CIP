'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import type { Route } from 'next';
import { Icon } from './ui/Icon';
import { EmptyState } from './ui/Bits';

/**
 * Notifications and help, as panels rather than two buttons that did nothing.
 *
 * Both were in the sidebar with no handler attached, which is its own kind of
 * lie — a control that looks pressable and is not.
 *
 * What is in them is real. Notifications are derived from the state of this
 * company's own rows when the panel opens, so the list cannot claim a sync
 * failed that has since worked. Help says what each part of CIP does and what
 * is configured right now; it does not offer a support address nobody reads.
 */

export type Notice = {
  id: string;
  tone: 'problem' | 'attention' | 'working' | 'good';
  title: string;
  detail: string;
  href: string | null;
  action: string | null;
};

/** Escape closes whichever panel is open, and the page holds still behind it. */
function useDrawer(onClose: () => void): void {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
}

function Drawer({
  title, subtitle, onClose, children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useDrawer(onClose);

  // Rendered into <body>: the sidebar is sticky, which creates its own stacking
  // context, and an overlay left inside it would sit under the page.
  return createPortal(
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title} aria-modal="true">
        <header className="drawer-head">
          <div>
            <h3>{title}</h3>
            <p className="small muted" style={{ marginTop: 6 }}>{subtitle}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}

export function SideDrawers({ initial }: { initial: Notice[] }) {
  const [open, setOpen] = useState<'notifications' | 'help' | null>(null);
  // Counted on the server, so the badge is right on the first paint. Opening
  // the panel refetches, because something may have finished since.
  const [notices, setNotices] = useState<Notice[]>(initial);

  const load = useCallback(async () => {
    const res = await fetch('/api/notifications', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { notices: Notice[] };
    setNotices(body.notices);
  }, []);

  const close = useCallback(() => setOpen(null), []);
  const count = notices.filter((n) => n.tone === 'problem' || n.tone === 'attention').length;

  return (
    <>
      <button
        type="button"
        className="side-link"
        onClick={() => {
          setOpen('notifications');
          void load();
        }}
      >
        <Icon name="bell" size={17} /> Notifications
        {count > 0 && <span className="count">{count}</span>}
      </button>

      <button type="button" className="side-link" onClick={() => setOpen('help')}>
        <Icon name="help" size={17} /> Help &amp; support
      </button>

      {open === 'notifications' && (
        <Drawer
          title="Notifications"
          subtitle="Worked out from what is true right now, so nothing here is stale."
          onClose={close}
        >
          {notices.length === 0 ? (
            <EmptyState
              icon="check"
              title="Nothing needs you"
              copy="Everything CIP holds has been read, and nothing has failed."
            />
          ) : (
            <div className="notice-list">
              {notices.map((notice) => (
                <article className={`notice-row ${notice.tone}`} key={notice.id}>
                  <span className="nr-mark" aria-hidden>
                    <Icon name={iconFor(notice.tone)} size={15} />
                  </span>
                  <span className="stack grow">
                    <span className="nr-title">{notice.title}</span>
                    <span className="nr-detail">{notice.detail}</span>
                    {notice.href && notice.action && (
                      <Link
                        className="nr-action"
                        href={notice.href as Route}
                        onClick={close}
                      >
                        {notice.action} <Icon name="arrow-right" size={13} />
                      </Link>
                    )}
                  </span>
                </article>
              ))}
            </div>
          )}
        </Drawer>
      )}

      {open === 'help' && (
        <Drawer
          title="Help &amp; support"
          subtitle="How CIP works, and what to do when something looks wrong."
          onClose={close}
        >
          <div className="help-list">
            <HelpItem
              icon="teach"
              title="Teach"
              body="Give CIP something to learn from. Connect a Google Drive folder and it stays up to date on its own, or upload files here. It reads documents by their words, and images, video and PDFs of posts by looking at them."
              href="/teach"
              cta="Go to Teach"
              onNavigate={close}
            />
            <HelpItem
              icon="ask"
              title="Ask"
              body="Describe what you want the way you would to a colleague. CIP writes the brief from what it has learned about your brand, then makes it. Say what it is for — a banner, a story, a carousel card — and it uses the right shape."
              href="/ask"
              cta="Go to Ask"
              onNavigate={close}
            />
            <HelpItem
              icon="trust"
              title="Trust"
              body="Everything CIP knows, and where each piece came from. Every fact names the file behind it, so if something it made looks wrong, this is where you find out why it thought that."
              href="/trust"
              cta="Go to Trust"
              onNavigate={close}
            />

            <div className="help-item">
              <span className="hi-icon"><Icon name="sparkle" size={18} /></span>
              <div className="stack grow">
                <p className="hi-title">Rating what it makes</p>
                <p className="hi-body">
                  Give a result a score out of ten and a line about what would make it
                  better. CIP turns that into a lesson and carries it into the next brief
                  for the same kind of work — you can see the lessons under Trust.
                </p>
              </div>
            </div>

            <div className="help-item">
              <span className="hi-icon"><Icon name="clock" size={18} /></span>
              <div className="stack grow">
                <p className="hi-title">When something is taking a while</p>
                <p className="hi-body">
                  An image is about a minute. A video is queued and takes several, and you
                  can leave the page while it runs. A large PDF is read a page at a time,
                  so a long one can take a few minutes to finish.
                </p>
              </div>
            </div>

            <div className="help-item">
              <span className="hi-icon"><Icon name="alert" size={18} /></span>
              <div className="stack grow">
                <p className="hi-title">When something fails</p>
                <p className="hi-body">
                  Notifications says what failed and why, in the words of whatever refused
                  it. A file that could not be read, a sync that stopped, a generator that
                  turned a request down — each says which it was, so it is clear whether
                  it is worth retrying or something needs changing.
                </p>
              </div>
            </div>
          </div>
        </Drawer>
      )}
    </>
  );
}

function HelpItem({
  icon, title, body, href, cta, onNavigate,
}: {
  icon: 'teach' | 'ask' | 'trust';
  title: string;
  body: string;
  href: string;
  cta: string;
  onNavigate: () => void;
}) {
  return (
    <div className="help-item">
      <span className="hi-icon"><Icon name={icon} size={18} /></span>
      <div className="stack grow">
        <p className="hi-title">{title}</p>
        <p className="hi-body">{body}</p>
        <Link className="nr-action" href={href as Route} onClick={onNavigate}>
          {cta} <Icon name="arrow-right" size={13} />
        </Link>
      </div>
    </div>
  );
}

function iconFor(tone: Notice['tone']): 'alert' | 'clock' | 'check' {
  if (tone === 'working') return 'clock';
  if (tone === 'good') return 'check';
  return 'alert';
}

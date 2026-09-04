import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTenant } from '../context/tenantStore';
import { Avatar } from './ui/Bits';
import { Icon } from './ui/Icon';

/** The pod is always visible. People and AI, working together — not a black box. */
export function PodCard() {
  const { tenant } = useTenant();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="pod-card">
        <div className="pod-stack">
          {tenant.pod.members.map((m) => (
            <Avatar key={m.id} initials={m.initials} tint={m.tint} size="md" title={`${m.name} — ${m.craft}`} />
          ))}
        </div>
        <div className="pod-title">Your CIP Pod</div>
        <p className="pod-copy">{tenant.pod.blurb}</p>
        <button type="button" className="pod-cta" onClick={() => setOpen(true)}>
          Meet your pod <Icon name="arrow-right" size={14} />
        </button>
      </div>

      {open && <PodDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Rendered into <body>. The sidebar is `position: sticky`, which creates its own
 * stacking context — an overlay left inside it would sit under the page.
 */
function PodDrawer({ onClose }: { onClose: () => void }) {
  const { tenant } = useTenant();

  // Hold the page still while the drawer is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Your CIP Pod">
        <header className="drawer-head">
          <div>
            <h3>Your CIP Pod</h3>
            <p className="small muted" style={{ marginTop: 6 }}>
              The people behind {tenant.name}&apos;s work. CIP does the heavy lifting; they make the calls.
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="drawer-body">
          {tenant.pod.members.map((m) => (
            <div className="pod-member" key={m.id}>
              <Avatar initials={m.initials} tint={m.tint} size="lg" />
              <div>
                <div className="pm-name">{m.name}</div>
                <div className="pm-role">{m.craft}</div>
                <p className="pm-bio">{m.bio}</p>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </>,
    document.body,
  );
}

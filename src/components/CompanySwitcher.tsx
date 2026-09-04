import { useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/tenantStore';
import { Icon } from './ui/Icon';
import { LogoMark } from './ui/Bits';

/**
 * Shows which workspace you are in. In demo builds it also lets you move
 * between the sample tenants; in production it is a label, not a menu.
 */
export function CompanySwitcher() {
  const { tenant, tenants, isDemoMode, switchTenant } = useTenant();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="switcher" ref={ref}>
      <button
        type="button"
        className="switcher-btn"
        onClick={() => isDemoMode && setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup={isDemoMode ? 'menu' : undefined}
      >
        <LogoMark logo={tenant.branding.logo} bg={tenant.branding.markBg} fg={tenant.branding.markFg} size="sm" />
        <span className="name truncate">{tenant.name}</span>
        {isDemoMode && <Icon name="chevron-down" size={16} className="chev" />}
      </button>

      {open && (
        <div className="switcher-menu" role="menu">
          <div className="menu-label">Switch workspace</div>
          {tenants.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              className="switcher-opt"
              onClick={() => {
                switchTenant(t.id);
                setOpen(false);
              }}
            >
              <LogoMark logo={t.branding.logo} bg={t.branding.markBg} fg={t.branding.markFg} size="sm" />
              <span className="stack">
                <span className="strong small">{t.name}</span>
                <span className="tiny muted">{t.industry}</span>
              </span>
              {t.id === tenant.id && <Icon name="check" size={16} className="tick" />}
            </button>
          ))}
          <p className="switcher-note">
            Demo only. Signed-in users see just their own company.
          </p>
        </div>
      )}
    </div>
  );
}

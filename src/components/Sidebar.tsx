'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useWorkspace } from '@/context/workspace';
import { Avatar } from './ui/Bits';
import { Icon } from './ui/Icon';
import type { IconName } from './ui/Icon';
import { logout, setActiveBrand } from '@/app/actions';
import { SideDrawers } from './SideDrawers';
import type { Notice } from './SideDrawers';
import { AddDataModal } from './AddDataModal';

/**
 * The sidebar, laid out as the CIS Brand Brain prototype lays it out.
 *
 * The active brand at the top, because nearly everything below it is about
 * one brand at a time. "Add data to brain" directly under it, because the
 * guidebook wants feeding the brain within reach from anywhere. Then the
 * brain itself, then the modules.
 *
 * All seven modules are built. A module that is not yet can still be listed
 * with a "later" tag instead of a link - a door that opens onto nothing is how
 * a product stops being believed, and a door marked "later" is not that.
 *
 * The addresses did not change when the names did - /trust is the Brand Brain
 * and /ask is Campaign Ideation - so nothing anybody bookmarked broke.
 */
type NavItem = { label: string; icon: IconName } & ({ href: Route } | { later: string });

const BRAIN_NAV: NavItem[] = [
  { label: 'Chat with the Brain', icon: 'chat', href: '/chat' },
  { label: 'Brand Brain', icon: 'graph', href: '/trust' },
];

const MODULE_NAV: NavItem[] = [
  { label: 'Creative Search', icon: 'search', href: '/search' },
  { label: 'Consistency Check', icon: 'shield', href: '/check' },
  { label: 'Campaign Ideation', icon: 'compass', href: '/ask' },
  { label: 'Market Intelligence', icon: 'bars', href: '/market' },
  { label: 'Social Calendar', icon: 'calendar', href: '/calendar' },
];

export function Sidebar({
  notices,
  brands,
  activeBrand,
}: {
  notices: Notice[];
  brands: string[];
  activeBrand: string | null;
}) {
  const workspace = useWorkspace();
  const pathname = usePathname();
  const [adding, setAdding] = useState(false);
  // Below 1080px the sidebar is a drawer, opened from the bar at the top.
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const renderItem = (item: NavItem) => {
    if ('later' in item) {
      return (
        <div key={item.label} className="navrow is-later" title="Not built yet">
          <Icon name={item.icon} size={18} />
          <span>{item.label}</span>
          <span className="navtag">{item.later}</span>
        </div>
      );
    }
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`navrow ${active ? 'active' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={() => setMenuOpen(false)}
      >
        <Icon name={item.icon} size={18} />
        <span>{item.label}</span>
      </Link>
    );
  };

  return (
    <>
    <header className="mobilebar">
      <button
        type="button"
        className="mobilemenu"
        aria-label="Open menu"
        aria-controls="main-nav"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(true)}
      >
        <Icon name="grid" size={17} />
      </button>
      <Link href="/" className="brandmark" aria-label="CIP home">
        <span className="dot" aria-hidden="true" />
        <span className="wordmark">CIP</span>
      </Link>
      <span className="mobilebrand truncate">{activeBrand ?? 'All brands'}</span>
    </header>
    {menuOpen && <div className="navscrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />}

    <nav id="main-nav" className={`sidebar ${menuOpen ? 'is-open' : ''}`} aria-label="Main">
      <button type="button" className="sideclose" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
        <Icon name="close" size={18} />
      </button>
      <Link href="/" className="brandmark" aria-label="CIP home" onClick={() => setMenuOpen(false)}>
        <span className="dot" aria-hidden="true" />
        <span className="wordmark">CIP</span>
      </Link>

      <BrandSwitcher house={workspace.name} brands={brands} active={activeBrand} />

      <button
        type="button"
        className="uploadbtn"
        onClick={() => {
          setAdding(true);
          setMenuOpen(false);
        }}
      >
        <Icon name="upload" size={15} />
        <span>Add data to brain</span>
      </button>

      <div className="navlabel">Brand brain</div>
      <div className="navgroup">{BRAIN_NAV.map(renderItem)}</div>

      <div className="navdivider" />

      <div className="navlabel">Modules</div>
      <div className="navgroup">{MODULE_NAV.map(renderItem)}</div>

      <div className="side-foot">
        <SideDrawers initial={notices} />
        <div className="side-user">
          <Avatar initials={workspace.user.initials} tint={['#3b352b', '#221f18']} size="sm" />
          <span className="stack grow">
            <span className="who truncate">{workspace.user.name}</span>
            <span className="role truncate">{workspace.user.roleLabel}</span>
          </span>
          <form action={logout}>
            <button type="submit" className="sign-out" aria-label="Sign out" title="Sign out">
              <Icon name="signout" size={16} />
            </button>
          </form>
        </div>
      </div>

      {adding && (
        <AddDataModal brand={activeBrand} brands={brands} house={workspace.name} onClose={() => setAdding(false)} />
      )}
    </nav>
    </>
  );
}

/**
 * The active brand.
 *
 * "All brands" is a real choice, not an empty state: a compliance rule or a
 * house fact belongs to every brand, and somebody looking across the whole
 * portfolio should be able to say so.
 */
function BrandSwitcher({
  house,
  brands,
  active,
}: {
  house: string;
  brands: string[];
  active: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (name: string | null) => {
    setOpen(false);
    if (name === active) return;
    startTransition(() => setActiveBrand(name));
  };

  // A company with no roster has nothing to switch between.
  if (brands.length === 0) {
    return (
      <div className="brandwrap">
        <div className="brandselect is-static">
          <span className="stack grow">
            <span className="label">Workspace</span>
            <span className="name truncate">{house}</span>
          </span>
        </div>
      </div>
    );
  }

  const options: (string | null)[] = [null, ...brands];

  return (
    <div className="brandwrap" ref={wrap}>
      <button
        type="button"
        className="brandselect"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
      >
        <span className="stack grow">
          <span className="label">{pending ? 'Switching…' : 'Active brand'}</span>
          <span className="name truncate">{active ?? 'All brands'}</span>
          <span className="house truncate">{house}</span>
        </span>
        <Icon name="chevron-down" size={15} className={open ? 'flip' : ''} />
      </button>
      {open && (
        <div className="branddrop" role="listbox" aria-label="Brands">
          {options.map((name) => (
            <button
              key={name ?? '__all'}
              type="button"
              role="option"
              aria-selected={name === active}
              className={`branditem ${name === active ? 'sel' : ''}`}
              onClick={() => choose(name)}
            >
              <span className="truncate">{name ?? 'All brands'}</span>
              <Icon name="check" size={14} className="tick" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

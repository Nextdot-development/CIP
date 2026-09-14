'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useWorkspace } from '@/context/workspace';
import { Avatar, LogoMark } from './ui/Bits';
import { Icon } from './ui/Icon';
import type { IconName } from './ui/Icon';
import { logout } from '@/app/actions';
import { SideDrawers } from './SideDrawers';
import type { Notice } from './SideDrawers';

/**
 * The modules of the Creative Intelligence System, in the guidebook's order.
 *
 * The guidebook lays out seven: Chat with the Brain, Brand Brain, Creative
 * Search, Consistency Check, Campaign Ideation, Market Intelligence and
 * Social Calendar. Only the ones that actually work are listed. A module that
 * is not built yet does not get a "coming soon" entry: a menu full of doors
 * that open onto nothing is how a product stops being believed.
 *
 * The addresses did not change when the names did - /trust is the Brand Brain
 * and /ask is Campaign Ideation - so nothing anybody bookmarked broke.
 *
 * "Add data" stays in the menu on purpose. The guidebook asks for adding to
 * the brain to be always within reach rather than buried inside one screen.
 */
const NAV: { href: Route; label: string; sub: string; icon: IconName }[] = [
  { href: '/', label: 'Home', sub: 'Where things stand', icon: 'home' },
  { href: '/trust', label: 'Brand Brain', sub: 'What CIP knows', icon: 'trust' },
  { href: '/check', label: 'Consistency Check', sub: 'Score a creative', icon: 'shield' },
  { href: '/ask', label: 'Campaign Ideation', sub: 'Make something', icon: 'ask' },
  { href: '/teach', label: 'Add data', sub: 'Feed the brain', icon: 'upload' },
];

export function Sidebar({ notices }: { notices: Notice[] }) {
  const workspace = useWorkspace();
  const pathname = usePathname();

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brandmark">
        <span className="wordmark">CIP</span>
        <span className="promise">Create. Comply. Perform.</span>
      </div>

      {/* Which company you are in, not a control. There is no switcher: the
          workspace comes from the session and nothing else. */}
      <div className="company-badge">
        <LogoMark
          name={workspace.name}
          logoUrl={workspace.logoUrl}
          bg={workspace.branding.markBg}
          fg={workspace.branding.markFg}
          size="sm"
        />
        <span className="stack grow">
          <span className="name truncate">{workspace.name}</span>
          {workspace.industry && <span className="industry truncate">{workspace.industry}</span>}
        </span>
      </div>

      <div className="nav">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item ${active ? 'active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon name={item.icon} size={19} className="ico" />
              <span className="stack">
                <span className="label">{item.label}</span>
                <span className="sub">{item.sub}</span>
              </span>
            </Link>
          );
        })}
      </div>

      <div className="side-foot">
        <SideDrawers initial={notices} />
        <div className="side-user">
          <Avatar
            initials={workspace.user.initials}
            tint={[workspace.branding.primary, workspace.branding.deep]}
            size="md"
          />
          <span className="stack grow">
            <span className="who truncate">{workspace.user.name}</span>
            <span className="role truncate">{workspace.user.roleLabel}</span>
          </span>
          <form action={logout}>
            <button type="submit" className="sign-out" aria-label="Sign out" title="Sign out">
              <Icon name="signout" size={17} />
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}

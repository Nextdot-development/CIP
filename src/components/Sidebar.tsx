'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useWorkspace } from '@/context/workspace';
import { Avatar, LogoMark } from './ui/Bits';
import { Icon } from './ui/Icon';
import type { IconName } from './ui/Icon';
import { logout } from '@/app/actions';

/**
 * Four places, and everything lives inside one of them.
 *
 * There were nine. Drive, Media, Knowledge, Knowledge Graph and Brain were
 * each a real thing, but as separate destinations they asked the reader to
 * know CIP's internals before they could find anything: to teach it you went
 * to two different pages, and to see what it had learned, three.
 *
 * The four that remain are the four things a person actually does.
 *
 *   Home   what CIP knows, at a glance
 *   Teach  give it more — a folder it syncs, or files you upload
 *   Ask    have it make something out of what it knows
 *   Trust  look at everything it has learned, and where each piece came from
 */
const NAV: { href: Route; label: string; sub: string; icon: IconName }[] = [
  { href: '/', label: 'Home', sub: 'Where things stand', icon: 'home' },
  { href: '/teach', label: 'Teach', sub: 'Feed your brand in', icon: 'teach' },
  { href: '/ask', label: 'Ask', sub: 'Make something', icon: 'ask' },
  { href: '/trust', label: 'Trust', sub: 'What CIP knows', icon: 'trust' },
];

export function Sidebar() {
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
        <button type="button" className="side-link">
          <Icon name="bell" size={17} /> Notifications
        </button>
        <button type="button" className="side-link">
          <Icon name="help" size={17} /> Help &amp; support
        </button>
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

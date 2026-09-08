'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useWorkspace } from '@/context/workspace';
import { PodCard } from './PodCard';
import { Avatar, LogoMark } from './ui/Bits';
import { Icon } from './ui/Icon';
import type { IconName } from './ui/Icon';
import { logout } from '@/app/actions';

const NAV: { href: Route; label: string; sub?: string; icon: IconName }[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/teach', label: 'Teach', sub: 'Your brand', icon: 'teach' },
  { href: '/ask', label: 'Ask', sub: 'Create with CIP', icon: 'ask' },
  { href: '/drive', label: 'Drive', sub: 'Your files', icon: 'drive' },
  { href: '/media', label: 'Media', sub: 'Images & video', icon: 'image' },
  { href: '/knowledge', label: 'Knowledge', sub: 'Connected sources', icon: 'book' },
  { href: '/knowledge-graph', label: 'Knowledge Graph', sub: 'How it connects', icon: 'grid' },
  { href: '/trust', label: 'Trust', sub: 'Track & review', icon: 'trust' },
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
                {item.sub && <span className="sub">{item.sub}</span>}
              </span>
            </Link>
          );
        })}
      </div>

      <PodCard />

      <div className="side-foot">
        <button type="button" className="side-link">
          <Icon name="bell" size={17} /> Notifications <span className="count">3</span>
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

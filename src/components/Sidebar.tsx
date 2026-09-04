import { useTenant } from '../context/tenantStore';
import { useNav } from '../context/NavContext';
import type { Route } from '../context/NavContext';
import { CompanySwitcher } from './CompanySwitcher';
import { PodCard } from './PodCard';
import { Avatar } from './ui/Bits';
import { Icon } from './ui/Icon';
import type { IconName } from './ui/Icon';

const NAV: { id: Route; label: string; sub?: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'teach', label: 'Teach', sub: 'Your brand', icon: 'teach' },
  { id: 'ask', label: 'Ask', sub: 'Create with CIP', icon: 'ask' },
  { id: 'trust', label: 'Trust', sub: 'Track & review', icon: 'trust' },
];

export function Sidebar() {
  const { tenant } = useTenant();
  const { route, go } = useNav();

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brandmark">
        <span className="wordmark">CIP</span>
        <span className="promise">Create. Comply. Perform.</span>
      </div>

      <CompanySwitcher />

      <div className="nav">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${route === item.id ? 'active' : ''}`}
            onClick={() => go(item.id)}
            aria-current={route === item.id ? 'page' : undefined}
          >
            <Icon name={item.icon} size={19} className="ico" />
            <span className="stack">
              <span className="label">{item.label}</span>
              {item.sub && <span className="sub">{item.sub}</span>}
            </span>
          </button>
        ))}
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
          <Avatar initials={tenant.user.initials} tint={[tenant.branding.primary, tenant.branding.deep]} size="md" />
          <span className="stack grow">
            <span className="who truncate">{tenant.user.name}</span>
            <span className="role truncate">{tenant.user.role}</span>
          </span>
        </div>
      </div>
    </nav>
  );
}

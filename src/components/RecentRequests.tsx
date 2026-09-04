import type { CSSProperties } from 'react';
import { useTenant } from '../context/tenantStore';
import { useNav } from '../context/NavContext';
import { Card, EmptyState, LinkCta, StatusPill } from './ui/Bits';
import { Icon } from './ui/Icon';

export function RecentRequests() {
  const { tenant } = useTenant();
  const { go } = useNav();
  const items = tenant.requests.slice(0, 4);

  return (
    <Card
      title="Your recent requests"
      action={<LinkCta onClick={() => go('trust')}>View all</LinkCta>}
    >
      {items.length === 0 ? (
        <EmptyState
          icon="sparkle"
          title="Nothing here yet — and that is easy to fix"
          copy={`You haven't asked ${'CIP'} for anything yet. Tell us what you are launching next and we will take it from there.`}
          action={
            <button type="button" className="btn btn-primary btn-sm" onClick={() => go('ask')}>
              Create something
            </button>
          }
        />
      ) : (
        items.map((r) => (
          <div className="req-row" key={r.id}>
            <span className="req-thumb" style={{ '--t1': r.tint[0], '--t2': r.tint[1] } as CSSProperties}>
              <Icon name={r.icon} size={20} />
            </span>
            <span className="stack grow">
              <span className="req-title truncate">{r.title}</span>
              <span className="req-meta">{r.summary}</span>
            </span>
            <StatusPill status={r.status} />
            <span className="req-when">{r.when}</span>
          </div>
        ))
      )}
    </Card>
  );
}

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTenant } from '../context/tenantStore';
import { useNav } from '../context/NavContext';
import type { AskMode } from '../context/NavContext';
import { PromptSuggestions, RequestComposer } from '../components/RequestComposer';
import { RecentRequests } from '../components/RecentRequests';
import { MonthlySummary } from '../components/MonthlySummary';
import { LogoMark, Progress } from '../components/ui/Bits';
import { Icon } from '../components/ui/Icon';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function HomeDashboard() {
  const { tenant } = useTenant();
  const { go } = useNav();
  const [draft, setDraft] = useState('');

  const send = (mode: AskMode) => {
    if (draft.trim()) go('ask', { text: draft.trim(), mode });
  };

  return (
    <div className="rise">
      <div className="home-top">
        <div className="greeting">
          <h1>
            {greeting()}, {tenant.user.firstName}
            <span className="wave">👋</span>
          </h1>
          <p className="ask-line">What would you like to create today?</p>
          <p className="ask-sub">Tell us what you need in your own words. We will take care of the rest.</p>

          <RequestComposer
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            placeholder={tenant.composerPlaceholder}
          />

          <PromptSuggestions
            lead="Try asking:"
            items={tenant.promptSuggestions}
            onPick={(s) => go('ask', { text: s, mode: 'pod' })}
          />
        </div>

        <HeroPanel />
      </div>

      <Pillars />

      <div className="home-grid">
        <RecentRequests />
        <MonthlySummary />
      </div>

    </div>
  );
}

/** Company-owned art. Changes completely with the tenant. */
function HeroPanel() {
  const { tenant } = useTenant();
  return (
    <aside className="hero">
      <div className="hero-logo">
        <LogoMark logo={tenant.branding.logo} bg="rgba(255,255,255,.14)" fg="currentColor" size="md" />
        <span className="hero-name">{tenant.name}</span>
      </div>
      <h2>{tenant.hero.title}</h2>
      <p className="hero-sub">{tenant.hero.subtitle}</p>
      <span className="hero-watermark" aria-hidden>
        <LogoMark logo={tenant.branding.logo} bg="transparent" fg="currentColor" size="lg" />
      </span>
    </aside>
  );
}

function Pillars() {
  const { tenant } = useTenant();
  const { go } = useNav();
  const bb = tenant.brandBrain;

  return (
    <div className="pillars">
      <article
        className="pillar"
        style={{
          '--p-bg': '#F1FAF5',
          '--p-line': '#D6EFE2',
          '--p-icon-bg': '#ffffff',
          '--p-icon-fg': '#0D7A52',
          '--p-title': '#0D7A52',
        } as CSSProperties}
      >
        <span className="p-icon"><Icon name="book" size={22} /></span>
        <h3>Teach</h3>
        <p className="p-tag">Give us your brand.</p>
        <p className="p-copy">
          Upload, connect and confirm. Help us understand what makes {tenant.name} unlike anyone else.
        </p>
        <div className="p-meta">
          <Progress value={bb.understanding} goal={bb.unlockAt} />
          <p className="p-unlock">
            <b className="strong">{bb.understanding}% understood.</b> Paid campaigns unlock at {bb.unlockAt}%.
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => go('teach')}>
          Continue setup <Icon name="arrow-right" size={15} />
        </button>
      </article>

      <article
        className="pillar"
        style={{
          '--p-bg': 'var(--brand-tint)',
          '--p-line': 'color-mix(in srgb, var(--brand) 18%, var(--line))',
          '--p-icon-bg': '#ffffff',
          '--p-icon-fg': 'var(--brand-deep)',
          '--p-title': 'var(--brand-deep)',
        } as CSSProperties}
      >
        <span className="p-icon"><Icon name="ask" size={22} /></span>
        <h3>Ask</h3>
        <p className="p-tag">Tell us what you need.</p>
        <p className="p-copy">
          Describe your idea the way you would to a colleague. CIP turns it into on-brand work.
        </p>
        <button type="button" className="btn btn-ghost" onClick={() => go('ask')}>
          Create something <Icon name="arrow-right" size={15} />
        </button>
      </article>

      <article
        className="pillar"
        style={{
          '--p-bg': '#F2F7FE',
          '--p-line': '#D9E7FB',
          '--p-icon-bg': '#ffffff',
          '--p-icon-fg': '#134A96',
          '--p-title': '#134A96',
        } as CSSProperties}
      >
        <span className="p-icon"><Icon name="shield" size={22} /></span>
        <h3>Trust</h3>
        <p className="p-tag">Everything, checked.</p>
        <p className="p-copy">
          Track progress, review approvals, manage rights and see what we have learned about your brand.
        </p>
        <div className="p-meta">
          <TrustLine />
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => go('trust')}>
          View dashboard <Icon name="arrow-right" size={15} />
        </button>
      </article>
    </div>
  );
}

/** Says plainly whether anything is actually stuck. */
function TrustLine() {
  const { tenant } = useTenant();
  const blocked = tenant.trust.work.filter((w) => w.status === 'blocked').length;
  const review = tenant.trust.work.filter((w) => w.status === 'in_review').length;

  if (blocked > 0) {
    return (
      <p className="p-unlock" style={{ color: 'var(--stop-700)', fontWeight: 600 }}>
        {blocked} item cannot be shipped yet. {review > 0 && `${review} waiting on review.`}
      </p>
    );
  }
  return (
    <p className="p-unlock">
      {review > 0 ? `${review} item waiting on review. ` : ''}Nothing is blocked right now.
    </p>
  );
}

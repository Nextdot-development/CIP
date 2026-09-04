import 'server-only';
import type { TransactionSql } from 'postgres';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import type { AuthenticatedSession } from '../auth/session';
import type * as W from '@/types/workspace';

/**
 * Every read of company-owned data goes through here.
 *
 * Two things make cross-company reads impossible rather than merely unlikely:
 * the only argument is a CompanyScope, which can be built only from a verified
 * session; and the whole read runs inside withCompanyScope, so migration
 * 0003's row-level security policies apply even to a query that forgets its
 * own WHERE clause.
 */
export async function getWorkspace(session: AuthenticatedSession): Promise<W.WorkspaceDTO> {
  const scope = session.scope;

  return withCompanyScope(scope, async (tx) => {
    const [company, branding, pod, brand, requests, month, trust] = await Promise.all([
      loadCompany(tx, scope),
      loadBranding(tx, scope),
      loadPod(tx, scope),
      loadBrand(tx, scope),
      loadRequests(tx, scope),
      loadMonth(tx, scope),
      loadTrust(tx, scope),
    ]);

    return {
      company,
      branding,
      viewer: {
        id: session.user.id,
        fullName: session.user.fullName,
        email: session.user.email,
        role: scope.role,
      },
      pod,
      brand,
      requests,
      month,
      trust,
    };
  });
}

async function loadCompany(tx: TransactionSql, scope: CompanyScope): Promise<W.CompanyDTO> {
  const rows = await tx<
    { id: string; slug: string; name: string; legal_name: string | null; industry: string | null; logo_url: string | null }[]
  >`
    select id, slug, name, legal_name, industry, logo_url
      from companies where id = ${scope.companyId}
  `;
  const row = rows[0];
  if (!row) throw new Error('Workspace not found for this session.');
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    legalName: row.legal_name,
    industry: row.industry,
    logoUrl: row.logo_url,
  };
}

async function loadBranding(tx: TransactionSql, scope: CompanyScope): Promise<W.BrandingDTO> {
  const rows = await tx<
    {
      primary_color: string; deep_color: string; nav_theme: 'light' | 'dark';
      hero_title: string; hero_subtitle: string; hero_from: string;
      hero_to: string; hero_glow: string; hero_ink: string;
    }[]
  >`
    select primary_color, deep_color, nav_theme, hero_title, hero_subtitle,
           hero_from, hero_to, hero_glow, hero_ink
      from company_branding where company_id = ${scope.companyId}
  `;
  const row = rows[0];
  if (!row) throw new Error('Branding has not been set up for this company.');
  return {
    primaryColor: row.primary_color,
    deepColor: row.deep_color,
    navTheme: row.nav_theme,
    hero: {
      title: row.hero_title,
      subtitle: row.hero_subtitle,
      from: row.hero_from,
      to: row.hero_to,
      glow: row.hero_glow,
      ink: row.hero_ink,
    },
  };
}

async function loadPod(tx: TransactionSql, scope: CompanyScope): Promise<W.PodMemberDTO[]> {
  const rows = await tx<
    { id: string; full_name: string; craft: string; bio: string; avatar_url: string | null }[]
  >`
    select id, full_name, craft, bio, avatar_url
      from pod_members where company_id = ${scope.companyId}
     order by sort_order, full_name
  `;
  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    craft: r.craft,
    bio: r.bio,
    avatarUrl: r.avatar_url,
  }));
}

async function loadRequests(tx: TransactionSql, scope: CompanyScope): Promise<W.RequestDTO[]> {
  const rows = await tx<
    {
      id: string; title: string; summary: string; status: W.WorkStatus; kind: W.RequestKind;
      submitted_at: Date; due_at: Date | null; completed_at: Date | null;
    }[]
  >`
    select id, title, summary, status, kind, submitted_at, due_at, completed_at
      from requests where company_id = ${scope.companyId}
     order by submitted_at desc
     limit 20
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    status: r.status,
    kind: r.kind,
    submittedAt: r.submitted_at.toISOString(),
    dueAt: r.due_at ? r.due_at.toISOString() : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
  }));
}

async function loadBrand(tx: TransactionSql, scope: CompanyScope): Promise<W.BrandDTO> {
  const [profileRows, unlockRows, topicRows, confirmRows, paletteRows] = await Promise.all([
    tx<
      {
        understanding_pct: number; paid_unlock_pct: number; headline: string; note: string;
        composer_placeholder: string; prompt_suggestions: string[]; voice_sounds: string[]; voice_never: string[];
      }[]
    >`select understanding_pct, paid_unlock_pct, headline, note, composer_placeholder,
             prompt_suggestions, voice_sounds, voice_never
        from brand_profiles where company_id = ${scope.companyId}`,
    tx<{ id: string; label: string; at_pct: number }[]>`
      select id, label, at_pct from brand_unlocks
       where company_id = ${scope.companyId} order by at_pct, sort_order`,
    tx<
      { id: string; key: string; title: string; blurb: string; cta: string; items: { label: string; done: boolean }[] }[]
    >`select id, key, title, blurb, cta, items from brand_topics
        where company_id = ${scope.companyId} order by sort_order`,
    tx<{ id: string; question: string; context: string; suggestion: string }[]>`
      select id, question, context, suggestion from brand_confirmations
       where company_id = ${scope.companyId} and answered_at is null order by sort_order`,
    tx<{ id: string; name: string; hex: string }[]>`
      select id, name, hex from brand_palette
       where company_id = ${scope.companyId} order by sort_order`,
  ]);

  const profile = profileRows[0];
  if (!profile) throw new Error('Brand profile has not been set up for this company.');

  return {
    understandingPct: profile.understanding_pct,
    paidUnlockPct: profile.paid_unlock_pct,
    headline: profile.headline,
    note: profile.note,
    composerPlaceholder: profile.composer_placeholder,
    promptSuggestions: profile.prompt_suggestions,
    voice: { sounds: profile.voice_sounds, never: profile.voice_never },
    unlocks: unlockRows.map((r) => ({ id: r.id, label: r.label, atPct: r.at_pct })),
    topics: topicRows.map((r) => ({
      id: r.id, key: r.key, title: r.title, blurb: r.blurb, cta: r.cta,
      items: Array.isArray(r.items) ? r.items : [],
    })),
    confirmations: confirmRows,
    palette: paletteRows,
  };
}

async function loadMonth(tx: TransactionSql, scope: CompanyScope): Promise<W.WorkspaceDTO['month']> {
  // The workspace shows the most recent month that actually has figures,
  // rather than assuming the current calendar month has been closed.
  const periodRows = await tx<{ period: Date }[]>`
    select max(period) as period from monthly_metrics where company_id = ${scope.companyId}
  `;
  const period = periodRows[0]?.period ?? null;
  if (!period) return { period: new Date().toISOString().slice(0, 10), metrics: [] };

  const rows = await tx<
    {
      id: string; key: string; label: string; value: string; unit: 'count' | 'percent';
      note: string | null; delta: string | null; delta_unit: 'count' | 'percent' | null;
      delta_note: string | null; tone: W.MetricTone;
    }[]
  >`
    select id, key, label, value, unit, note, delta, delta_unit, delta_note, tone
      from monthly_metrics
     where company_id = ${scope.companyId} and period = ${period}
     order by sort_order
  `;

  return {
    period: period.toISOString().slice(0, 10),
    // numeric arrives as a string from the driver so precision is never lost
    metrics: rows.map((r) => ({
      id: r.id, key: r.key, label: r.label,
      value: Number(r.value), unit: r.unit, note: r.note,
      delta: r.delta === null ? null : Number(r.delta),
      deltaUnit: r.delta_unit, deltaNote: r.delta_note, tone: r.tone,
    })),
  };
}

async function loadTrust(tx: TransactionSql, scope: CompanyScope): Promise<W.WorkspaceDTO['trust']> {
  const [workRows, rightsRows, checkRows, learningRows, costRows] = await Promise.all([
    tx<
      {
        id: string; title: string; meta: string; status: W.WorkStatus;
        reason_tone: W.ReasonTone | null; reason_text: string | null;
        fixes: string[]; owner_name: string | null;
      }[]
    >`select w.id, w.title, w.meta, w.status, w.reason_tone, w.reason_text, w.fixes,
             p.full_name as owner_name
        from work_items w
        left join pod_members p on p.id = w.owner_pod_member_id
       where w.company_id = ${scope.companyId}
       order by w.sort_order, w.created_at desc`,
    tx<{ id: string; title: string; note: string; expires_at: Date }[]>`
      select id, title, note, expires_at from rights_items
       where company_id = ${scope.companyId} order by expires_at`,
    tx<{ id: string; name: string; note: string; state: W.CheckState }[]>`
      select id, name, note, state from compliance_checks
       where company_id = ${scope.companyId} order by sort_order`,
    tx<{ id: string; text: string; effect: string }[]>`
      select id, text, effect from learnings
       where company_id = ${scope.companyId} order by period desc, sort_order`,
    tx<{ id: string; label: string; amount_minor: string; currency: string }[]>`
      select id, label, amount_minor, currency from cost_lines
       where company_id = ${scope.companyId} order by sort_order`,
  ]);

  return {
    work: workRows.map((r) => ({
      id: r.id, title: r.title, meta: r.meta, status: r.status,
      reason: r.reason_tone && r.reason_text ? { tone: r.reason_tone, text: r.reason_text } : null,
      fixes: r.fixes, ownerName: r.owner_name,
    })),
    rights: rightsRows.map((r) => ({
      id: r.id, title: r.title, note: r.note, expiresAt: r.expires_at.toISOString(),
    })),
    checks: checkRows,
    learnings: learningRows,
    cost: {
      currency: costRows[0]?.currency ?? 'INR',
      lines: costRows.map((r) => ({ id: r.id, label: r.label, amountMinor: Number(r.amount_minor) })),
    },
  };
}

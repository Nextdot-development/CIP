import type { Tenant } from '../data/types';
import type { AskMode } from '../context/NavContext';
import type { IconName } from '../components/ui/Icon';

/**
 * A stand-in for the Brand Brain's request understanding.
 *
 * It exists so the Ask flow can be designed, reviewed and tested end to end
 * before the real service is built. Everything it returns is written the way a
 * person would say it — the UI never has to translate a machine response.
 */

export type Deliverable = { id: string; title: string; note: string; icon: IconName };

type Fact = { value: string; note: string };

/** The same request, priced and timed two ways. */
export type PlanFacts = { timeline: Fact; cost: Fact; status: Fact };

export type Understanding = {
  headline: string;
  items: string[];
  basis: string;
  deliverables: Deliverable[];
  plans: Record<AskMode, PlanFacts>;
};

const has = (s: string, ...words: string[]) => words.some((w) => s.includes(w));

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Pulls the occasion out of the request, if the user named one. */
function findOccasion(text: string): string | null {
  const named = [
    'world heart day', 'world asthma day', 'world cancer day', 'world health day',
    'diwali', 'holi', 'christmas', 'new year', 'independence day', 'summer', 'monsoon',
    'valentine', 'mother\'s day', 'father\'s day', 'republic day',
  ];
  const hit = named.find((n) => text.includes(n));
  if (hit) return titleCase(hit);
  if (has(text, 'launch')) return 'Product launch';
  if (has(text, 'awareness')) return 'Awareness push';
  return null;
}

export function interpret(input: string, tenant: Tenant): Understanding {
  const text = input.toLowerCase();
  const occasion = findOccasion(text);

  const channels: string[] = [];
  if (has(text, 'instagram', 'insta', 'reel', 'story')) channels.push('Instagram');
  if (has(text, 'youtube')) channels.push('YouTube');
  if (has(text, 'linkedin')) channels.push('LinkedIn');
  if (has(text, 'facebook')) channels.push('Facebook');
  if (has(text, 'whatsapp')) channels.push('WhatsApp');
  if (has(text, 'print', 'poster', 'brochure', 'outdoor', 'hoarding')) channels.push('Print');
  if (has(text, 'blog', 'article', 'website')) channels.push('Website');
  if (channels.length === 0) channels.push('Instagram');

  const deliverables: Deliverable[] = [];
  const items: string[] = [];

  if (occasion) items.push(`A ${occasion} campaign`);
  items.push(`${channels.join(' and ')} content`);

  const videoMatch = text.match(/(\d{1,3})\s*[- ]?\s*second/);
  const wantsVideo = has(text, 'video', 'film', 'reel', 'explainer', 'ad film');
  const wantsCarousel = has(text, 'carousel');
  const wantsPoster = has(text, 'poster', 'creative', 'post', 'banner');
  const wantsBlog = has(text, 'blog', 'article', 'copy', 'write-up');
  const wantsBrochure = has(text, 'brochure', 'leaflet', 'flyer');

  if (wantsCarousel) {
    items.push('One carousel');
    deliverables.push({ id: 'd-car', title: 'Instagram carousel', note: '5 slides, copy included', icon: 'grid' });
  }
  if (wantsVideo) {
    const secs = videoMatch ? `${videoMatch[1]}-second` : '30-second';
    items.push(`One ${secs} video`);
    const label = secs.charAt(0).toUpperCase() + secs.slice(1);
    deliverables.push({ id: 'd-vid', title: `${label} video`, note: 'Script, edit, captions and a vertical cut', icon: 'video' });
  }
  if (wantsPoster && !wantsCarousel) {
    items.push('A set of social creatives');
    deliverables.push({ id: 'd-soc', title: '6 social creatives', note: 'Sized for feed and stories', icon: 'image' });
  }
  if (wantsBlog) {
    items.push('A written piece');
    deliverables.push({ id: 'd-blog', title: 'Article, ~800 words', note: 'Written in your brand voice', icon: 'doc' });
  }
  if (wantsBrochure) {
    items.push('A brochure');
    deliverables.push({ id: 'd-bro', title: 'Brochure', note: 'Print-ready and digital versions', icon: 'doc' });
  }

  // Nothing specific named — assume the sensible default campaign shape.
  if (deliverables.length === 0) {
    items.push('A campaign concept and a set of creatives');
    deliverables.push(
      { id: 'd-idea', title: 'Campaign concept', note: 'The idea, the line and the look', icon: 'sparkle' },
      { id: 'd-soc', title: '6 social creatives', note: 'Sized for feed and stories', icon: 'image' },
    );
  }

  deliverables.push({
    id: 'd-check',
    title: 'Brand and compliance check',
    note: `Reviewed by ${tenant.pod.members.find((m) => m.craft.includes('Compliance') || m.craft.includes('Medical'))?.name ?? 'your pod'}`,
    icon: 'shield',
  });

  // Timeline and cost scale with the work, not with anything technical.
  const heavy = deliverables.filter((d) => d.icon === 'video').length;
  const days = 2 + deliverables.length + heavy * 2;
  const base = 18000 * (deliverables.length - 1) + heavy * 60000;
  const cost = base < 40000 ? 40000 : base;

  const instantCost = Math.round((cost * 0.3) / 500) * 500;

  return {
    headline: 'Here is what we understood',
    items,
    basis: `Based on your existing brand${tenant.requests.length ? ' and your previous campaigns' : ''}.`,
    deliverables,
    plans: {
      instant: {
        timeline: { value: 'About 2 minutes', note: 'Drafts appear the moment you confirm.' },
        cost: { value: `₹${instantCost.toLocaleString('en-IN')}`, note: 'Drafts only. You pay for finished work when you ask for it.' },
        status: { value: 'Not checked yet', note: 'Send it to your pod before anything is published.' },
      },
      pod: {
        timeline: {
          value: `${days} working days`,
          note: `First drafts reach you in ${Math.max(2, Math.round(days / 2))} days.`,
        },
        cost: { value: `₹${cost.toLocaleString('en-IN')}`, note: 'Estimate. Nothing is charged until you approve.' },
        status: { value: 'Ready to start', note: 'Your pod picks this up as soon as you confirm.' },
      },
    },
  };
}

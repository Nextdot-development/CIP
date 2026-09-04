/**
 * Development seed.
 *
 * The two companies that used to live in src/data/*.ts, restated as rows. The
 * content is unchanged so the migrated UI renders exactly what it did before;
 * what changed is the shape — real timestamps, minor-unit money, and no
 * colours attached to people or requests.
 */

export type SeedCompany = {
  slug: string;
  name: string;
  legalName: string;
  industry: string;
  branding: {
    primaryColor: string;
    deepColor: string;
    navTheme: 'light' | 'dark';
    heroTitle: string;
    heroSubtitle: string;
    heroFrom: string;
    heroTo: string;
    heroGlow: string;
    heroInk: string;
  };
  brand: {
    understandingPct: number;
    paidUnlockPct: number;
    headline: string;
    note: string;
    composerPlaceholder: string;
    promptSuggestions: string[];
    voiceSounds: string[];
    voiceNever: string[];
    unlocks: { label: string; atPct: number }[];
    topics: { key: string; title: string; blurb: string; cta: string; items: { label: string; done: boolean }[] }[];
    confirmations: { question: string; context: string; suggestion: string }[];
    palette: { name: string; hex: string }[];
  };
  pod: { fullName: string; craft: string; bio: string }[];
  requests: {
    title: string;
    summary: string;
    status: 'completed' | 'in_progress' | 'in_review' | 'blocked' | 'scheduled';
    kind: 'image' | 'video' | 'doc' | 'grid';
    submittedDaysAgo: number;
    dueInDays?: number;
    completedDaysAgo?: number;
  }[];
  metrics: {
    key: string;
    label: string;
    value: number;
    unit: 'count' | 'percent';
    note?: string;
    delta?: number;
    deltaUnit?: 'count' | 'percent';
    deltaNote?: string;
    tone: 'brand' | 'ok' | 'warn' | 'stop' | 'neutral';
  }[];
  work: {
    title: string;
    meta: string;
    status: 'completed' | 'in_progress' | 'in_review' | 'blocked' | 'scheduled';
    reasonTone?: 'stop' | 'warn' | 'info';
    reasonText?: string;
    fixes?: string[];
    ownerCraft?: string;
  }[];
  rights: { title: string; note: string; expiresInDays: number }[];
  checks: { name: string; note: string; state: 'pass' | 'attention' | 'fail' }[];
  learnings: { text: string; effect: string }[];
  costLines: { label: string; amountMinor: number }[];
  users: { email: string; fullName: string; role: 'owner' | 'admin' | 'member' | 'viewer' }[];
};

export const magicMoments: SeedCompany = {
  slug: 'magic-moments',
  name: 'Magic Moments',
  legalName: 'Magic Moments Premium Spirits',
  industry: 'Premium spirits',
  branding: {
    primaryColor: '#7C4DFF',
    deepColor: '#4B2FB0',
    navTheme: 'dark',
    heroTitle: 'Bold ideas. Brighter moments.',
    heroSubtitle: 'Your brand, now moving at the speed of the occasion.',
    heroFrom: '#241539',
    heroTo: '#0E0A1A',
    heroGlow: '#8B5CF6',
    heroInk: '#FFFFFF',
  },
  brand: {
    understandingPct: 68,
    paidUnlockPct: 80,
    headline: 'Your brand is 68% understood.',
    note: 'We know your look, your voice and your product range. Tell us how you talk about drinking occasions responsibly and we can start running paid campaigns for you.',
    composerPlaceholder: 'e.g. "Create an Instagram campaign for our new summer collection"',
    promptSuggestions: ['Social media campaign', 'Product launch assets', 'Video with influencer', 'Festival creatives', 'Blog or article'],
    voiceSounds: ['Warm, witty and a little cinematic', 'Talks about the occasion, not the alcohol', 'Confident without shouting'],
    voiceNever: ['Hard-sell or discount-led', 'Anything that encourages drinking to excess', 'Slang that dates quickly'],
    unlocks: [
      { label: 'Organic social and blogs', atPct: 40 },
      { label: 'Campaign concepts and scripts', atPct: 60 },
      { label: 'Paid campaigns', atPct: 80 },
      { label: 'Influencer and celebrity work', atPct: 90 },
    ],
    topics: [
      { key: 'assets', title: 'Brand assets', blurb: 'Logos, bottle shots, fonts and the packs your team reuses every week.', cta: 'Add more assets', items: [
        { label: '38 product and lifestyle images', done: true },
        { label: 'Logo pack, all variants', done: true },
        { label: 'Brand fonts', done: true },
        { label: 'Video b-roll library', done: false }] },
      { key: 'guidelines', title: 'Brand guidelines', blurb: 'The rules your agencies already follow, so we follow them too.', cta: 'Review guidelines', items: [
        { label: 'Visual identity guide 2025', done: true },
        { label: 'Logo clear-space rules', done: true },
        { label: 'Photography direction', done: false }] },
      { key: 'voice', title: 'Brand voice', blurb: 'How Magic Moments sounds — playful, premium, never loud.', cta: 'Refine voice', items: [
        { label: 'Tone examples from past campaigns', done: true },
        { label: 'Words you avoid', done: true },
        { label: 'Voice for regional languages', done: false }] },
      { key: 'products', title: 'Products & range', blurb: 'Every variant, its personality and who it is for.', cta: 'Add a product', items: [
        { label: '6 variants with descriptions', done: true },
        { label: 'Pricing tiers and markets', done: true },
        { label: 'New summer range', done: false }] },
      { key: 'knowledge', title: 'Important knowledge', blurb: 'The things a new team member would need to be told on day one.', cta: 'Add knowledge', items: [
        { label: 'Responsible-drinking position', done: false },
        { label: 'Festival calendar and key occasions', done: true },
        { label: 'Competitor set', done: true }] },
      { key: 'sources', title: 'Connected sources', blurb: 'Where your brand lives already — we read, we never post without you.', cta: 'Connect a source', items: [
        { label: 'Instagram @magicmoments', done: true },
        { label: 'Brand drive folder', done: true },
        { label: 'Website product pages', done: false }] },
    ],
    confirmations: [
      { question: 'Is "Live the moment" still your primary tagline?', context: 'Seen on 14 of your recent posts, but your 2025 guideline uses "Made for the moment".', suggestion: 'Made for the moment' },
      { question: 'Should we treat Diwali as your biggest campaign moment?', context: 'Your last three years of spend peaked in October.', suggestion: 'Yes, Diwali leads the year' },
      { question: 'Can we use the 2023 cocktail photography again?', context: 'Beautiful set, but the licence covers digital only — no print, no outdoor.', suggestion: 'Digital use only' },
    ],
    palette: [
      { name: 'Midnight', hex: '#141018' },
      { name: 'Electric violet', hex: '#7C4DFF' },
      { name: 'Champagne', hex: '#E8D9B5' },
      { name: 'Fog', hex: '#F4F2F8' },
    ],
  },
  pod: [
    { fullName: 'Ritika Sharma', craft: 'Creative Direction', bio: 'Shapes the look and feel of every campaign so it still feels unmistakably Magic Moments.' },
    { fullName: 'Arjun Nair', craft: 'Brand Strategy', bio: 'Turns a one-line brief into a plan — the occasion, the audience, the message.' },
    { fullName: 'Meera Iyer', craft: 'Compliance & Rights', bio: 'Checks every asset against advertising rules and keeps track of what you are licensed to use.' },
    { fullName: 'Dev Patel', craft: 'Performance', bio: 'Watches what actually works and feeds it back so the next campaign starts smarter.' },
  ],
  requests: [
    { title: 'Summer Cocktail Campaign', summary: 'Instagram • 6 creatives', status: 'completed', kind: 'grid', submittedDaysAgo: 9, completedDaysAgo: 2 },
    { title: 'Product Launch Video', summary: '1 video • 30 seconds', status: 'in_progress', kind: 'video', submittedDaysAgo: 6, dueInDays: 2 },
    { title: 'Festival Social Media Kit', summary: '10 creatives • Diwali', status: 'in_review', kind: 'image', submittedDaysAgo: 4, dueInDays: 1 },
    { title: 'Blog: The Art of Celebration', summary: '1 article • 800 words', status: 'completed', kind: 'doc', submittedDaysAgo: 12, completedDaysAgo: 5 },
  ],
  metrics: [
    { key: 'assets_delivered', label: 'Assets delivered', value: 12, unit: 'count', note: 'Ready to publish', delta: 3, deltaUnit: 'count', deltaNote: 'vs March', tone: 'brand' },
    { key: 'campaigns', label: 'Campaigns run', value: 3, unit: 'count', note: 'Across Instagram and blog', delta: 1, deltaUnit: 'count', deltaNote: 'vs March', tone: 'brand' },
    { key: 'blocked', label: 'Blocked items', value: 0, unit: 'count', note: 'Nothing is stuck', tone: 'ok' },
    { key: 'turnaround_gain', label: 'Faster turnaround', value: 28, unit: 'percent', note: 'Average brief to delivery', deltaNote: 'vs March', tone: 'ok' },
  ],
  work: [
    { title: 'Festival Social Media Kit', meta: '10 creatives • Diwali • with Ritika', status: 'in_review', reasonTone: 'warn', reasonText: 'Two creatives show the bottle being poured. Our reading of the current advertising rules says that needs a legal sign-off before it goes out.', fixes: ['Ask Meera to review', 'Swap for the lifestyle cut'], ownerCraft: 'Compliance & Rights' },
    { title: 'Product Launch Video', meta: '30-second cut • with Ritika and Dev', status: 'in_progress', reasonTone: 'info', reasonText: 'Edit is with your pod. First cut lands Thursday morning.', ownerCraft: 'Creative Direction' },
    { title: 'Summer Cocktail Campaign', meta: '6 creatives • published 2 days ago', status: 'completed', reasonTone: 'info', reasonText: 'All six passed brand and compliance checks. Rights cleared until March 2026.' },
    { title: 'Blog: The Art of Celebration', meta: '800 words • published', status: 'completed' },
  ],
  rights: [
    { title: 'Cocktail photography set (2023)', note: 'Digital use only — not cleared for print or outdoor', expiresInDays: 46 },
    { title: 'Music bed: "Golden Hour"', note: 'Licensed for the launch video and social cutdowns', expiresInDays: 118 },
    { title: 'Influencer usage — Ananya R.', note: 'Reels and stories, India only', expiresInDays: 12 },
  ],
  checks: [
    { name: 'Brand voice match', note: 'Every asset this month sounded like you', state: 'pass' },
    { name: 'Logo and colour usage', note: 'Correct across all 12 assets', state: 'pass' },
    { name: 'Advertising rules', note: '2 creatives need a legal sign-off before publishing', state: 'attention' },
    { name: 'Rights and licences', note: '1 licence expires in 12 days', state: 'attention' },
    { name: 'Claims and disclaimers', note: 'Responsible-drinking line present on all creatives', state: 'pass' },
  ],
  learnings: [
    { text: 'Your audience responds to occasions, not products.', effect: 'We now lead every concept with the moment.' },
    { text: 'Carousels outperform single images on Instagram by a wide margin.', effect: 'Carousels are now the default for social.' },
    { text: 'Copy under 12 words gets approved first time.', effect: 'Shorter headlines by default — fewer review rounds.' },
  ],
  costLines: [
    { label: 'Creative production', amountMinor: 15600000 },
    { label: 'Video', amountMinor: 10200000 },
    { label: 'Strategy and review', amountMinor: 5400000 },
    { label: 'Rights and licensing', amountMinor: 2800000 },
  ],
  users: [
    { email: 'sneha@magicmoments.test', fullName: 'Sneha Kapoor', role: 'owner' },
    { email: 'dev@magicmoments.test', fullName: 'Dev Patel', role: 'member' },
  ],
};

export const narayanaHealth: SeedCompany = {
  slug: 'narayana-health',
  name: 'Narayana Health',
  legalName: 'Narayana Health Group',
  industry: 'Healthcare',
  branding: {
    primaryColor: '#1D6FE0',
    deepColor: '#134A96',
    navTheme: 'light',
    heroTitle: 'Healthier lives, brighter tomorrows.',
    heroSubtitle: 'Compassion, technology and care — communicated clearly, every time.',
    heroFrom: '#EAF3FF',
    heroTo: '#CFE2FB',
    heroGlow: '#7FB2F5',
    heroInk: '#0B2C5E',
  },
  brand: {
    understandingPct: 68,
    paidUnlockPct: 80,
    headline: 'Your brand is 68% understood.',
    note: 'We know your identity, your specialties and how your doctors speak. Confirm your patient-consent rules and we can start running paid campaigns for you.',
    composerPlaceholder: 'e.g. "Create a World Heart Day awareness campaign for Instagram"',
    promptSuggestions: ['Heart health campaign', 'Doctor explainer video', 'Hospital awareness posters', 'Patient education carousel', 'Health day social kit'],
    voiceSounds: ['Calm, clear and free of jargon', 'Explains the condition before the service', 'Hopeful without ever promising outcomes'],
    voiceNever: ['Fear-led or alarming', 'Guarantees of cure or success rates', 'Anything that shames a patient'],
    unlocks: [
      { label: 'Awareness posts and articles', atPct: 40 },
      { label: 'Campaign concepts and scripts', atPct: 60 },
      { label: 'Paid campaigns', atPct: 80 },
      { label: 'Doctor and patient-story films', atPct: 90 },
    ],
    topics: [
      { key: 'assets', title: 'Brand assets', blurb: 'Logos, hospital photography, doctor portraits and icon sets.', cta: 'Add more assets', items: [
        { label: '64 hospital and care images', done: true },
        { label: 'Logo pack, all units', done: true },
        { label: 'Doctor portrait library', done: true },
        { label: 'Regional-language templates', done: false }] },
      { key: 'guidelines', title: 'Brand guidelines', blurb: 'How the identity is used across 21 hospitals without drifting.', cta: 'Review guidelines', items: [
        { label: 'Identity guide 2025', done: true },
        { label: 'Co-branding rules for units', done: true },
        { label: 'Photography direction', done: false }] },
      { key: 'voice', title: 'Brand voice', blurb: 'Reassuring, plain-spoken, never alarming.', cta: 'Refine voice', items: [
        { label: 'Tone examples from past campaigns', done: true },
        { label: 'Words you avoid', done: true },
        { label: 'Hindi and Kannada tone', done: false }] },
      { key: 'products', title: 'Specialties & services', blurb: 'Every department, what it treats and who it speaks to.', cta: 'Add a service', items: [
        { label: '18 specialties described', done: true },
        { label: 'Hospital locations and units', done: true },
        { label: 'Health-check packages', done: false }] },
      { key: 'knowledge', title: 'Important knowledge', blurb: 'The rules a new team member would have to be told on day one.', cta: 'Add knowledge', items: [
        { label: 'Patient consent and privacy rules', done: false },
        { label: 'Health-day calendar', done: true },
        { label: 'Claims we never make', done: true }] },
      { key: 'sources', title: 'Connected sources', blurb: 'Where your brand lives already — we read, we never post without you.', cta: 'Connect a source', items: [
        { label: 'Instagram @narayanahealth', done: true },
        { label: 'YouTube channel', done: true },
        { label: 'Website specialty pages', done: false }] },
    ],
    confirmations: [
      { question: 'Can we name a doctor in social creatives?', context: 'Your last campaign credited doctors by name. Advertising rules for healthcare are strict here.', suggestion: 'Only with written consent on file' },
      { question: 'Is "Healthier lives, brighter tomorrows" your line for 2025?', context: 'Two lines are in use across your units right now.', suggestion: 'Yes, use it everywhere' },
      { question: 'Should patient stories always show a real patient?', context: 'Real stories perform better, but every one needs signed consent.', suggestion: 'Real patients, consent required' },
    ],
    palette: [
      { name: 'Narayana blue', hex: '#1D6FE0' },
      { name: 'Care red', hex: '#E2231A' },
      { name: 'Calm sky', hex: '#E7F0FE' },
      { name: 'Slate', hex: '#0B2C5E' },
    ],
  },
  pod: [
    { fullName: 'Dr. Kavya Rao', craft: 'Medical Review', bio: 'Reads every claim before it goes out, so nothing you publish overstates what care can do.' },
    { fullName: 'Rohit Desai', craft: 'Creative Direction', bio: 'Keeps the work warm and human — hospitals should not look like hospitals.' },
    { fullName: 'Ananya Bose', craft: 'Brand Strategy', bio: 'Decides what to say for each health day, each specialty and each city.' },
    { fullName: 'Imran Sheikh', craft: 'Compliance & Rights', bio: 'Handles patient consent, doctor permissions and advertising rules for healthcare.' },
  ],
  requests: [
    { title: 'Heart Health Awareness Campaign', summary: '8 creatives • Instagram, YouTube', status: 'completed', kind: 'grid', submittedDaysAgo: 14, completedDaysAgo: 3 },
    { title: 'Doctor Explainer Video', summary: '1 video • 60 seconds', status: 'in_progress', kind: 'video', submittedDaysAgo: 8, dueInDays: 3 },
    { title: 'World Asthma Day Social Kit', summary: '10 creatives • social media', status: 'in_review', kind: 'image', submittedDaysAgo: 5, dueInDays: 1 },
    { title: 'Hospital Services Brochure', summary: '1 brochure • print and digital', status: 'completed', kind: 'doc', submittedDaysAgo: 20, completedDaysAgo: 9 },
  ],
  metrics: [
    { key: 'assets_delivered', label: 'Assets delivered', value: 24, unit: 'count', note: 'Ready to publish', delta: 20, deltaUnit: 'percent', deltaNote: 'vs March', tone: 'brand' },
    { key: 'campaigns', label: 'Campaigns run', value: 6, unit: 'count', note: 'Across 4 specialties', delta: 50, deltaUnit: 'percent', deltaNote: 'vs March', tone: 'brand' },
    { key: 'blocked', label: 'Blocked item', value: 1, unit: 'count', note: 'Needs patient consent before it can ship', tone: 'stop' },
    { key: 'turnaround_gain', label: 'Faster turnaround', value: 40, unit: 'percent', note: 'Average brief to delivery', deltaNote: 'vs March', tone: 'ok' },
  ],
  work: [
    { title: 'Patient Story Film — Cardiac Care', meta: '1 film • 90 seconds • with Rohit', status: 'blocked', reasonTone: 'stop', reasonText: 'This cannot be published. The patient in the film has not signed a consent form, and healthcare advertising rules require written consent before a real patient appears.', fixes: ['Upload signed consent', 'Recast with an actor'], ownerCraft: 'Compliance & Rights' },
    { title: 'World Asthma Day Social Kit', meta: '10 creatives • with Dr. Kavya', status: 'in_review', reasonTone: 'warn', reasonText: 'Three creatives say treatment "cures" asthma. Dr. Kavya has suggested "helps manage" instead — one word, and it ships.', fixes: ['Accept the suggested wording', 'Discuss with Dr. Kavya'], ownerCraft: 'Medical Review' },
    { title: 'Doctor Explainer Video', meta: '60-second cut • with Rohit', status: 'in_progress', reasonTone: 'info', reasonText: 'Being edited now. First cut reaches you on Thursday.', ownerCraft: 'Creative Direction' },
    { title: 'Heart Health Awareness Campaign', meta: '8 creatives • published', status: 'completed', reasonTone: 'info', reasonText: 'Medically reviewed and cleared. Rights valid until April 2026.' },
    { title: 'Hospital Services Brochure', meta: 'Print and digital • delivered', status: 'completed' },
  ],
  rights: [
    { title: 'Hospital photography (2024 shoot)', note: 'All channels, worldwide', expiresInDays: 214 },
    { title: 'Dr. Suresh Kumar — portrait usage', note: 'Consent covers digital and print, India', expiresInDays: 61 },
    { title: 'Stock footage — operating theatre', note: 'Renew before the next film goes into edit', expiresInDays: 9 },
  ],
  checks: [
    { name: 'Medical accuracy', note: 'Reviewed by Dr. Kavya Rao on all 24 assets', state: 'pass' },
    { name: 'Brand voice match', note: 'Calm, clear, no jargon — consistent this month', state: 'pass' },
    { name: 'Claims and promises', note: '3 creatives use the word "cures" and need rewording', state: 'attention' },
    { name: 'Patient consent', note: '1 film has no signed consent on file', state: 'fail' },
    { name: 'Rights and licences', note: '1 licence expires in 9 days', state: 'attention' },
  ],
  learnings: [
    { text: 'Posts that explain the condition first get twice the saves.', effect: 'We now open with the symptom, not the service.' },
    { text: 'Doctor-led videos are trusted more than voiceover.', effect: 'Doctor-on-camera is now the default format.' },
    { text: 'Regional-language captions lift reach in tier-2 cities.', effect: 'Hindi and Kannada versions are made by default.' },
  ],
  costLines: [
    { label: 'Creative production', amountMinor: 26000000 },
    { label: 'Video', amountMinor: 17400000 },
    { label: 'Medical and compliance review', amountMinor: 12400000 },
    { label: 'Rights and licensing', amountMinor: 6200000 },
  ],
  users: [
    { email: 'rahul@narayanahealth.test', fullName: 'Rahul Verma', role: 'owner' },
    { email: 'kavya@narayanahealth.test', fullName: 'Dr. Kavya Rao', role: 'viewer' },
  ],
};

export const seedCompanies: SeedCompany[] = [narayanaHealth, magicMoments];

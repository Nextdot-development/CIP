import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { semanticSearch } from '../drive/semanticSearch';
import { brain } from './providers';
import type { ChatSource } from './providers/types';
import { readBrandDna } from './brandDna';
import { brandInRequest, companyBrands } from './brands';
import { upcoming } from './calendar';
import { listRules } from './checker';
import { marketSignalsFor } from './market';
import { searchMemory } from './retrieval';

/**
 * Chat with the Brain.
 *
 * A question is answered from what CIP has stored and from nothing else: the
 * brand's DNA, passages from its files, market signals, the calendar and the
 * compliance rules. Each goes to the model with a short ref, the answer cites
 * the refs it used, and a citation to a ref that was never sent is dropped -
 * exactly as the checker drops a flag that cites a rule nobody gave it.
 *
 * An answer that cites nothing is kept and marked as such, so a person can see
 * at a glance that CIP had nothing to go on rather than reading a confident
 * paragraph and assuming it came from their own data.
 *
 * The brand boundary holds here as everywhere: asked about 8PM, CIP is given
 * 8PM's knowledge and the house's, and not Magic Moments'.
 */

export class ChatRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatRejected';
  }
}

export class ChatNotFound extends Error {
  constructor() {
    super('That conversation is not here.');
    this.name = 'ChatNotFound';
  }
}

export type ChatSourceDTO = {
  ref: string;
  kind: ChatSource['kind'];
  label: string;
  href: string | null;
};

export type ChatMessageDTO = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: ChatSourceDTO[];
  followUps: string[];
  grounded: boolean | null;
  createdAt: string;
};

export type ChatThreadDTO = {
  id: string;
  title: string;
  brand: string | null;
  updatedAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUESTION = 2_000;
const HISTORY_TURNS = 8;
const REF = /\[([FPAMCR]\d+)\]/g;

const STOPWORDS = new Set([
  'what', 'which', 'when', 'where', 'there', 'their', 'about', 'have', 'does', 'this', 'that',
  'with', 'from', 'into', 'should', 'would', 'could', 'make', 'give', 'show', 'tell', 'much',
  'many', 'brand', 'brands', 'post', 'posts', 'your', 'ours', 'they', 'them', 'were', 'been',
]);

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const fileHref = (fileId: string) => `/api/drive/files/${fileId}/content?disposition=inline`;

export type Gathered = { forModel: ChatSource; shown: ChatSourceDTO };

function words(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)))];
}

/** Everything the Brain may use to answer, already inside the brand boundary. */
export async function gatherSources(scope: CompanyScope, question: string, brand: string | null): Promise<Gathered[]> {
  const terms = words(question);
  const relevance = (text: string) => {
    const lower = text.toLowerCase();
    return terms.reduce((n, term) => n + (lower.includes(term) ? 1 : 0), 0);
  };

  const [facts, passages, signals, occasions, rules] = await Promise.all([
    // Wide, then narrowed to the question below: the thirty most-evidenced
    // facts about a brand are mostly its palette, and a question about its
    // tagline needs the fact about its tagline.
    readBrandDna(scope, { brand, limit: 200, minEvidence: 1 }),
    semanticSearch(scope, { query: question, limit: 8 }).then((r) => r.hits).catch(() => []),
    marketSignalsFor(scope, { brand, limit: 200 }),
    upcoming(scope, { withinDays: 120, limit: 40 }),
    listRules(scope),
  ]);

  // Files that belong to a sibling brand do not answer a question about this one.
  const fileBrand = async (ids: string[]): Promise<Map<string, string | null>> => {
    if (ids.length === 0) return new Map();
    const rows = await withCompanyScope(scope, (tx) =>
      tx<{ id: string; brand: string | null }[]>`
        select id, brand from drive_files where company_id = ${scope.companyId} and id = any(${ids}::uuid[])
      `,
    );
    return new Map(rows.map((row) => [row.id, row.brand]));
  };
  const inBoundary = (owner: string | null | undefined) => !brand || !owner || owner === brand;

  let assets: { fileId: string; fileName: string; summary: string }[] = [];
  if (passages.length === 0 && terms.length > 0) {
    // No vectors here: fall back to words, longest first, which are the most telling.
    const byLength = [...terms].sort((a, b) => b.length - a.length).slice(0, 3);
    const found = await Promise.all(byLength.map((term) => searchMemory(scope, term, 4)));
    const seen = new Set<string>();
    assets = found.flat().filter((asset) => (seen.has(asset.fileId) ? false : (seen.add(asset.fileId), true))).slice(0, 6);
  }

  const owners = await fileBrand([...passages.map((p) => p.fileId), ...assets.map((a) => a.fileId)]);

  const gathered: Gathered[] = [];
  const push = (prefix: string, kind: ChatSource['kind'], text: string, label: string, href: string | null) => {
    const ref = `${prefix}${gathered.filter((g) => g.forModel.ref.startsWith(prefix)).length + 1}`;
    gathered.push({ forModel: { ref, kind, text }, shown: { ref, kind, label, href } });
  };

  // Most relevant first. The sort is stable, so among facts that match the
  // question equally the brand's own still come before the house's.
  const rankedFacts = [...facts]
    .sort((a, b) => relevance(`${b.attribute} ${b.value}`) - relevance(`${a.attribute} ${a.value}`))
    .slice(0, 30);

  for (const fact of rankedFacts) {
    push(
      'F',
      'fact',
      `${fact.brand ?? 'house-wide'} - ${fact.attribute}: ${fact.value} (seen in ${fact.evidenceCount} asset${fact.evidenceCount === 1 ? '' : 's'})`,
      `${fact.brand ? `${fact.brand} · ` : ''}${fact.attribute}: ${clip(fact.value, 80)}`,
      '/trust',
    );
  }
  for (const hit of passages.filter((p) => inBoundary(owners.get(p.fileId)))) {
    push('P', 'passage', `${hit.fileName}${hit.heading ? ` - ${hit.heading}` : ''}: ${hit.snippet}`, hit.fileName, fileHref(hit.fileId));
  }
  for (const asset of assets.filter((a) => inBoundary(owners.get(a.fileId)))) {
    push('A', 'asset', `${asset.fileName}: ${clip(asset.summary, 600)}`, asset.fileName, fileHref(asset.fileId));
  }
  for (const signal of [...signals].sort((a, b) => relevance(`${b.subject} ${b.market ?? ''} ${b.statement}`) - relevance(`${a.subject} ${a.market ?? ''} ${a.statement}`)).slice(0, 14)) {
    push(
      'M',
      'signal',
      `${signal.statement} (${[signal.subject, signal.market, signal.period].filter(Boolean).join(', ')}; from the report "${signal.fileName}")`,
      clip(signal.statement, 90),
      '/market',
    );
  }
  for (const occasion of occasions.filter((o) => inBoundary(o.brand)).slice(0, 10)) {
    const when = occasion.startsOn === occasion.endsOn ? occasion.startsOn : `${occasion.startsOn} to ${occasion.endsOn}`;
    push(
      'C',
      'occasion',
      `${occasion.occasion}, ${when}, ${occasion.market ?? 'every market'}${occasion.kind === 'restricted' ? ' - a dry day: publish nothing showing alcohol' : ` (${occasion.kind.replace('_', ' ')})`}`,
      `${occasion.occasion} · ${occasion.market ?? 'every market'} · ${occasion.startsOn}`,
      '/calendar',
    );
  }
  for (const rule of rules.filter((r) => r.active && inBoundary(r.brand)).slice(0, 12)) {
    push(
      'R',
      'rule',
      `${rule.requirement === 'required' ? 'Required' : 'Forbidden'} in ${rule.market ?? 'every market'}: ${rule.rule}`,
      `${rule.market ?? 'Every market'} · ${clip(rule.rule, 80)}`,
      '/check',
    );
  }
  return gathered;
}

type MessageRow = {
  id: string; role: 'user' | 'assistant'; content: string; sources: ChatSourceDTO[] | null;
  follow_ups: string[] | null; grounded: boolean | null; created_at: Date;
};

const toMessage = (row: MessageRow): ChatMessageDTO => ({
  id: row.id,
  role: row.role,
  content: row.content,
  sources: Array.isArray(row.sources) ? row.sources : [],
  followUps: row.follow_ups ?? [],
  grounded: row.grounded,
  createdAt: row.created_at.toISOString(),
});

type ThreadRow = { id: string; title: string; brand: string | null; updated_at: Date };
const toThread = (row: ThreadRow): ChatThreadDTO => ({
  id: row.id,
  title: row.title,
  brand: row.brand,
  updatedAt: row.updated_at.toISOString(),
});

/** This person's conversations, newest first. */
export async function listThreads(scope: CompanyScope, limit = 30): Promise<ChatThreadDTO[]> {
  const rows = await withCompanyScope(scope, (tx) =>
    tx<ThreadRow[]>`
      select id, title, brand, updated_at from chat_threads
       where company_id = ${scope.companyId} and user_id = ${scope.userId}
       order by updated_at desc
       limit ${limit}
    `,
  );
  return rows.map(toThread);
}

/** One of this person's conversations, or null. */
export async function getThread(
  scope: CompanyScope,
  threadId: string,
): Promise<{ thread: ChatThreadDTO; messages: ChatMessageDTO[] } | null> {
  if (!UUID.test(threadId)) return null;
  return withCompanyScope(scope, async (tx) => {
    const threads = await tx<ThreadRow[]>`
      select id, title, brand, updated_at from chat_threads
       where id = ${threadId} and company_id = ${scope.companyId} and user_id = ${scope.userId}
    `;
    const thread = threads[0];
    if (!thread) return null;
    const messages = await tx<MessageRow[]>`
      select id, role, content, sources, follow_ups, grounded, created_at from chat_messages
       where company_id = ${scope.companyId} and thread_id = ${threadId}
       order by created_at, role desc
    `;
    return { thread: toThread(thread), messages: messages.map(toMessage) };
  });
}

/** Asks the Brain, and keeps the question and the answer together. */
export async function askBrain(
  scope: CompanyScope,
  input: { threadId: string | null; message: string; activeBrand: string | null },
): Promise<{ thread: ChatThreadDTO; messages: ChatMessageDTO[] }> {
  const question = input.message.trim();
  if (question.length === 0) throw new ChatRejected('Ask something first.');
  if (question.length > MAX_QUESTION) throw new ChatRejected(`Keep a question under ${MAX_QUESTION} characters.`);

  const existing = input.threadId ? await getThread(scope, input.threadId) : null;
  if (input.threadId && !existing) throw new ChatNotFound();

  // A brand named in the question wins over the conversation's and the sidebar's:
  // asking about 8PM while Magic Moments is selected is a question about 8PM.
  const roster = await companyBrands(scope);
  const named = brandInRequest(question, roster.map((b) => b.name));
  const brand = named ?? existing?.thread.brand ?? input.activeBrand ?? null;

  const sources = await gatherSources(scope, question, brand);
  const history = (existing?.messages ?? [])
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: clip(m.content, 1_200) }));

  const provider = brain();
  const answer = await provider.answerQuestion({
    question,
    brand,
    history,
    sources: sources.map((s) => s.forModel),
  });

  const sent = new Map(sources.map((s) => [s.forModel.ref, s.shown]));
  const cited = [...new Set([
    ...(answer.citations ?? []),
    ...[...(answer.answer ?? '').matchAll(REF)].map((m) => m[1]!),
  ])].filter((ref) => sent.has(ref));
  const shown = cited.map((ref) => sent.get(ref)!);
  const content =
    (answer.answer ?? '').replace(REF, (whole, ref: string) => (sent.has(ref) ? whole : '')).replace(/[ \t]+([.,;:])/g, '$1').trim() ||
    'CIP could not put an answer together from what it has stored.';
  const followUps = (answer.followUps ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 3);

  return withCompanyScope(scope, async (tx) => {
    let threadId = existing?.thread.id ?? null;
    if (!threadId) {
      const created = await tx<ThreadRow[]>`
        insert into chat_threads (company_id, user_id, brand, title)
        values (${scope.companyId}, ${scope.userId}, ${brand}, ${clip(question, 80)})
        returning id, title, brand, updated_at
      `;
      threadId = created[0]!.id;
    }

    const asked = await tx<MessageRow[]>`
      insert into chat_messages (company_id, thread_id, role, content)
      values (${scope.companyId}, ${threadId}, 'user', ${question})
      returning id, role, content, sources, follow_ups, grounded, created_at
    `;
    const answered = await tx<MessageRow[]>`
      insert into chat_messages
        (company_id, thread_id, role, content, sources, follow_ups, grounded, provider, model)
      values
        (${scope.companyId}, ${threadId}, 'assistant', ${content}, ${tx.json(shown)}, ${followUps},
         ${shown.length > 0}, ${provider.name}, ${provider.model})
      returning id, role, content, sources, follow_ups, grounded, created_at
    `;
    const threads = await tx<ThreadRow[]>`
      update chat_threads set updated_at = now(), brand = coalesce(brand, ${brand})
       where id = ${threadId} and company_id = ${scope.companyId}
      returning id, title, brand, updated_at
    `;

    return { thread: toThread(threads[0]!), messages: [toMessage(asked[0]!), toMessage(answered[0]!)] };
  });
}

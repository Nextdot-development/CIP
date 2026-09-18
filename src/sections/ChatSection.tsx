'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '../components/ui/Icon';
import { EmptyState } from '../components/ui/Bits';
import { useToast } from '@/context/toast';
import { useWorkspace } from '@/context/workspace';
import { useAskSeed } from '@/context/NavContext';
import type { ChatMessageDTO, ChatSourceDTO, ChatThreadDTO } from '@/server/brain/chat';

/**
 * Chat with the Brain, in the prototype's shape: bubbles, the sources each
 * answer used as chips under it, and follow-up questions to click.
 *
 * An answer that cited nothing says so under it. That line is the difference
 * between "CIP knows this about your brand" and "a model wrote a paragraph",
 * and a person should never have to guess which they are reading.
 */

const REF = /\[([FPAMCR]\d+)\]/g;

const KIND_ICON: Record<ChatSourceDTO['kind'], Parameters<typeof Icon>[0]['name']> = {
  fact: 'graph',
  passage: 'doc',
  asset: 'image',
  signal: 'bars',
  occasion: 'calendar',
  rule: 'shield',
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(data.message ?? 'That did not work. Try again in a moment.');
  return data as T;
}

/** An answer's text, with its [F1]-style refs as small numbered marks. */
function Answer({ text, sources }: { text: string; sources: ChatSourceDTO[] }) {
  const index = new Map(sources.map((s, i) => [s.ref, i + 1]));
  const paragraphs = text.split(/\n{2,}/);

  const inline = (line: string, key: string) => {
    const parts = line.split(REF);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        const n = index.get(part);
        const source = sources.find((s) => s.ref === part);
        return n ? (
          <sup key={`${key}-${i}`} className="refmark" title={source?.label}>
            {n}
          </sup>
        ) : null;
      }
      return <Fragment key={`${key}-${i}`}>{part}</Fragment>;
    });
  };

  return (
    <>
      {paragraphs.map((paragraph, p) => {
        const lines = paragraph.split('\n');
        if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) {
          return (
            <ul key={p}>
              {lines.map((line, l) => (
                <li key={l}>{inline(line.replace(/^\s*[-*•]\s+/, ''), `${p}-${l}`)}</li>
              ))}
            </ul>
          );
        }
        return <p key={p}>{lines.map((line, l) => <Fragment key={l}>{l > 0 && <br />}{inline(line, `${p}-${l}`)}</Fragment>)}</p>;
      })}
    </>
  );
}

export function ChatSection({
  configured,
  brand,
  threads: initialThreads,
  thread: initialThread,
  messages: initialMessages,
  suggestions,
}: {
  configured: boolean;
  brand: string | null;
  threads: ChatThreadDTO[];
  thread: ChatThreadDTO | null;
  messages: ChatMessageDTO[];
  suggestions: string[];
}) {
  const { note } = useToast();
  const workspace = useWorkspace();
  const router = useRouter();
  const { setSeed } = useAskSeed();

  const [threads, setThreads] = useState(initialThreads);
  const [thread, setThread] = useState<ChatThreadDTO | null>(initialThread);
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** Numbers the question shown while its answer is on the way. */
  const pendingCount = useRef(0);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  const remember = (id: string | null) => {
    window.history.replaceState(null, '', id ? `/chat?t=${id}` : '/chat');
  };

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setDraft('');
    setBusy(true);
    pendingCount.current += 1;
    const pending: ChatMessageDTO = {
      id: `pending-${pendingCount.current}`,
      role: 'user',
      content: question,
      sources: [],
      followUps: [],
      grounded: null,
      createdAt: '',
    };
    setMessages((list) => [...list, pending]);
    try {
      const result = await post<{ thread: ChatThreadDTO; messages: ChatMessageDTO[] }>('/api/brain/chat', {
        threadId: thread?.id ?? null,
        message: question,
      });
      setMessages((list) => [...list.filter((m) => m.id !== pending.id), ...result.messages]);
      setThread(result.thread);
      setThreads((list) => [result.thread, ...list.filter((t) => t.id !== result.thread.id)]);
      remember(result.thread.id);
    } catch (error) {
      setMessages((list) => list.filter((m) => m.id !== pending.id));
      setDraft(question);
      note(error instanceof Error ? error.message : 'That could not be asked.');
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const open = async (id: string) => {
    if (busy || id === thread?.id) return;
    try {
      const res = await fetch(`/api/brain/chat?threadId=${encodeURIComponent(id)}`);
      const data = (await res.json()) as { thread?: ChatThreadDTO; messages?: ChatMessageDTO[]; message?: string };
      if (!res.ok || !data.thread) throw new Error(data.message ?? 'That conversation could not be opened.');
      setThread(data.thread);
      setMessages(data.messages ?? []);
      remember(data.thread.id);
    } catch (error) {
      note(error instanceof Error ? error.message : 'That conversation could not be opened.');
    }
  };

  const fresh = () => {
    if (busy) return;
    setThread(null);
    setMessages([]);
    remember(null);
    input.current?.focus();
  };

  const makeVisual = (question: string) => {
    setSeed({ text: question, mode: 'instant' });
    router.push('/ask');
  };

  const subject = thread?.brand ?? brand;
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  const chips = messages.length === 0 ? suggestions : (last?.followUps ?? []);

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Chat with the Brain</p>
        <h1>Chat with the Brain — {subject ?? 'All brands'}</h1>
        <p className="lede">
          Ask anything. Every answer is built from this brand&apos;s DNA, its files, market data, the calendar
          and the compliance rules - and shows which of them it used.
        </p>
      </header>

      {!configured && (
        <p className="chatnotice">
          <Icon name="alert" size={15} /> The Brain is not configured on this server, so questions cannot be answered yet.
        </p>
      )}

      <div className="chatlayout">
        <section className="chatarea" aria-label="Conversation">
          {messages.length === 0 && !busy && (
            <EmptyState
              icon="chat"
              title="Ask the Brain"
              copy="It answers from what CIP has learned, and says when it has nothing stored on something rather than making it up."
            />
          )}

          {messages.map((message, i) => {
            if (message.role === 'user') {
              return (
                <div key={message.id} className="msgrow user">
                  <div className="msgavatar user" aria-hidden="true">{workspace.user.initials}</div>
                  <div className="bubble">{message.content}</div>
                </div>
              );
            }
            const question = [...messages.slice(0, i)].reverse().find((m) => m.role === 'user')?.content ?? '';
            return (
              <div key={message.id} className="msgrow">
                <div className="msgavatar brain" aria-hidden="true">C</div>
                <div className="bubble">
                  <Answer text={message.content} sources={message.sources} />
                  {message.sources.length > 0 && (
                    <div className="refchips">
                      {message.sources.map((source, n) =>
                        source.href ? (
                          <a
                            key={source.ref}
                            className="refchip"
                            href={source.href}
                            target={source.href.startsWith('/api/') ? '_blank' : undefined}
                            rel="noreferrer noopener"
                            title={source.label}
                          >
                            <span className="refnum">{n + 1}</span>
                            <Icon name={KIND_ICON[source.kind]} size={12} />
                            <span className="truncate">{source.label}</span>
                          </a>
                        ) : (
                          <span key={source.ref} className="refchip" title={source.label}>
                            <span className="refnum">{n + 1}</span>
                            <span className="truncate">{source.label}</span>
                          </span>
                        ),
                      )}
                    </div>
                  )}
                  {message.grounded === false && (
                    <p className="ungrounded">
                      <Icon name="alert" size={12} /> Not grounded in anything CIP has stored.
                    </p>
                  )}
                  {question && (
                    <button type="button" className="bubbleaction" onClick={() => makeVisual(question)}>
                      <Icon name="sparkle" size={12} /> Make a visual from this
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {busy && (
            <div className="msgrow">
              <div className="msgavatar brain" aria-hidden="true">C</div>
              <div className="bubble typing" aria-label="The Brain is answering">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          <div ref={end} />

          {chips.length > 0 && (
            <div className="chatchips">
              {chips.map((chip) => (
                <button key={chip} type="button" className="chip" onClick={() => void send(chip)} disabled={busy || !configured}>
                  {chip}
                </button>
              ))}
            </div>
          )}

          <form
            className="chatinputrow"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <label htmlFor="chat-input" className="visually-hidden">Ask the Brain</label>
            <textarea
              id="chat-input"
              ref={input}
              rows={1}
              value={draft}
              placeholder="Ask the brain anything…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              disabled={!configured}
            />
            <button type="submit" className="searchbtn" disabled={busy || !draft.trim() || !configured}>
              {busy ? 'Thinking…' : 'Send'}
            </button>
          </form>
        </section>

        <aside className="threadlist" aria-label="Conversations">
          <button type="button" className="btnghost threadnew" onClick={fresh} disabled={busy}>
            <Icon name="plus" size={14} /> New conversation
          </button>
          {threads.length === 0 ? (
            <p className="tiny muted">Your conversations appear here.</p>
          ) : (
            <ul>
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`threaditem ${t.id === thread?.id ? 'on' : ''}`}
                    aria-current={t.id === thread?.id ? 'true' : undefined}
                    onClick={() => void open(t.id)}
                  >
                    <span className="truncate">{t.title}</span>
                    <span className="tiny muted">{[t.brand, t.updatedAt.slice(0, 10)].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

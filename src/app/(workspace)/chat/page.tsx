import { requireSession } from '@/server/auth/guards';
import { activeBrand } from '@/server/brain/activeBrand';
import { getThread, listThreads } from '@/server/brain/chat';
import { brainStatus } from '@/server/brain/providers';
import { ChatSection } from '@/sections/ChatSection';

export const metadata = { title: 'Chat with the Brain — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Chat with the Brain. ?t= opens one of this person's conversations.
 *
 * The suggested questions are ones CIP can answer from what it stores, for the
 * brand in the sidebar - not questions that would send it to general knowledge.
 */
export default async function ChatPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const session = await requireSession();
  const scope = session.scope;
  const { t } = await searchParams;

  const [{ active }, threads, opened] = await Promise.all([
    activeBrand(scope),
    listThreads(scope),
    t ? getThread(scope, t) : Promise.resolve(null),
  ]);

  const subject = opened?.thread.brand ?? active;
  const suggestions = subject
    ? [
        `What does ${subject} usually look like?`,
        `What is coming up for ${subject} in the next two months?`,
        `What rules does a ${subject} post have to follow in Nigeria?`,
      ]
    : [
        'Which of our brands are whiskies, and how do they differ?',
        'What is on the calendar this month, and which days are dry days?',
        'What do we know about our competitors?',
      ];

  return (
    <ChatSection
      configured={brainStatus().configured}
      brand={active}
      threads={threads}
      thread={opened?.thread ?? null}
      messages={opened?.messages ?? []}
      suggestions={suggestions}
    />
  );
}

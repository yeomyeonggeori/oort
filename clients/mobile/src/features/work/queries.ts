import {fetchThreadReplies, type Message, type WorkSession} from '@momo/core/lib/api';
import {
  parseWorkSessionEvent,
  type WorkSessionEvent,
} from '@momo/core/features/work/workSessionModel';
import {useQuery} from '@tanstack/react-query';

const EVENT_PAGE_LIMIT = 200;
const EVENT_MAX_PAGES = 5;

/**
 * A person's reply in the session thread (N3 #3595): the signed instruction the
 * server writes there (`props["momo.instruction"]`) and anything a teammate said
 * under the session. They are not ACP events, so `parseWorkSessionEvent` drops
 * them; the 대화 mode needs them to interleave 내 지시 and 답 in order.
 */
export interface ThreadReply {
  id: string;
  authorMemberId: string;
  text: string;
  atMs: number;
  /** Channel seq, the same ordering authority the ACP events carry. */
  seq: number;
  /** Set only for a signed instruction. */
  mode?: 'queue' | 'interrupt';
}

export interface SessionEventPage {
  events: WorkSessionEvent[];
  /** Always present from this read on; optional so older cached pages still type. */
  replies?: ThreadReply[];
  /** More replies exist beyond the five bounded pages this phone read. */
  truncated: boolean;
}

/** A person's plain text under the session; null for anything else in the thread. */
export function threadReplyFrom(message: Message): ThreadReply | null {
  if (message.type !== 'text' || message.state === 'deleted') return null;
  const text = message.body?.trim() ?? '';
  if (text === '') return null;
  const instruction = message.props?.['momo.instruction'];
  const mode =
    typeof instruction === 'object' && instruction !== null
      ? (instruction as {mode?: unknown}).mode
      : undefined;
  return {
    id: message.id,
    authorMemberId: message.authorMemberId,
    text,
    atMs: message.createdAtMs,
    seq: message.seq,
    ...(mode === 'queue' || mode === 'interrupt' ? {mode} : {}),
  };
}

async function fetchSessionEvents(
  workspaceId: string,
  channelId: string,
  rootId: string,
): Promise<SessionEventPage> {
  const events: WorkSessionEvent[] = [];
  const replies: ThreadReply[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < EVENT_MAX_PAGES; page += 1) {
    const response = await fetchThreadReplies(
      workspaceId,
      channelId,
      rootId,
      cursor,
      EVENT_PAGE_LIMIT,
    );
    for (const message of response.messages) {
      const event = parseWorkSessionEvent(message);
      if (event !== null) {
        events.push(event);
        continue;
      }
      const reply = threadReplyFrom(message);
      if (reply !== null) replies.push(reply);
    }
    if (response.nextCursor === undefined) {
      return {events, replies, truncated: false};
    }
    // A broken cursor must not turn a read-only detail into an unbounded loop.
    if (response.nextCursor === cursor) return {events, replies, truncated: true};
    cursor = response.nextCursor;
  }
  return {events, replies, truncated: true};
}

export function workSessionEventsKey(
  workspaceId: string,
  channelId: string,
  rootId: string,
) {
  return ['work-session-events', workspaceId, channelId, rootId] as const;
}

/**
 * Durable, typed ACP projection (the source of truth). The live tail of a running
 * session is `useWorkSessionLive`'s job and is merged over this, never instead of it.
 * No attach grant or PTY path.
 */
export function useWorkSessionEvents(
  workspaceId: string,
  session: WorkSession | null,
) {
  return useQuery({
    queryKey: workSessionEventsKey(
      workspaceId,
      session?.channelId ?? '',
      session?.rootMessageId ?? '',
    ),
    queryFn: () =>
      fetchSessionEvents(
        workspaceId,
        session?.channelId ?? '',
        session?.rootMessageId ?? '',
      ),
    enabled: session !== null,
  });
}

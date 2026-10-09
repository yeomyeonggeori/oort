import {fetchThreadReplies, type WorkSession} from '@momo/core/lib/api';
import {
  parseSessionThreadReply,
  parseWorkSessionEvent,
  type SessionThreadReply,
  type WorkSessionEvent,
} from '@momo/core/features/work/workSessionModel';
import {useQuery} from '@tanstack/react-query';

const EVENT_PAGE_LIMIT = 200;
const EVENT_MAX_PAGES = 5;

export interface SessionEventPage {
  events: WorkSessionEvent[];
  /** Always present from this read on; optional so older cached pages still type. */
  replies?: SessionThreadReply[];
  /** More replies exist beyond the five bounded pages this phone read. */
  truncated: boolean;
}

async function fetchSessionEvents(
  workspaceId: string,
  channelId: string,
  rootId: string,
): Promise<SessionEventPage> {
  const events: WorkSessionEvent[] = [];
  const replies: SessionThreadReply[] = [];
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
      const reply = parseSessionThreadReply(message);
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

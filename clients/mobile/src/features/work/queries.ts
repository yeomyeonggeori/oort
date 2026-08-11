import {fetchThreadReplies, type WorkSession} from '@momo/core/lib/api';
import {
  parseWorkSessionEvent,
  type WorkSessionEvent,
} from '@momo/core/features/work/workSessionModel';
import {useQuery} from '@tanstack/react-query';

const EVENT_PAGE_LIMIT = 200;
const EVENT_MAX_PAGES = 5;

export interface SessionEventPage {
  events: WorkSessionEvent[];
  /** More replies exist beyond the five bounded pages this phone read. */
  truncated: boolean;
}

async function fetchSessionEvents(
  workspaceId: string,
  channelId: string,
  rootId: string,
): Promise<SessionEventPage> {
  const events: WorkSessionEvent[] = [];
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
      if (event !== null) events.push(event);
    }
    if (response.nextCursor === undefined) return {events, truncated: false};
    // A broken cursor must not turn a read-only detail into an unbounded loop.
    if (response.nextCursor === cursor) return {events, truncated: true};
    cursor = response.nextCursor;
  }
  return {events, truncated: true};
}

/** Durable, typed ACP projection only. No socket, attach grant, or PTY path. */
export function useWorkSessionEvents(
  workspaceId: string,
  session: WorkSession | null,
) {
  return useQuery({
    queryKey: [
      'work-session-events',
      workspaceId,
      session?.channelId ?? '',
      session?.rootMessageId ?? '',
    ],
    queryFn: () =>
      fetchSessionEvents(
        workspaceId,
        session?.channelId ?? '',
        session?.rootMessageId ?? '',
      ),
    enabled: session !== null,
  });
}

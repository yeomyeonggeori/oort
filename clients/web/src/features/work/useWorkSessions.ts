import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchThreadReplies,
  fetchWorkHosts,
  fetchWorkSessions,
  type WorkSession,
} from "@/lib/api";
import { useSession } from "@/app/session";
import {
  eventFromFrame,
  mergeEvents,
  parseWorkSessionEvent,
  workChannelsToWatch,
  type WorkSessionEvent,
} from "./workSessionModel";

// =============================================================================
// Reads behind the 작업 세션 panel (AX-3 / MOMO-618).
//
// Postgres stays the source of truth: the ledger and the event stream are both
// REST reads, and the realtime rail only ever does two things — append a live
// event to a session that is already on screen, or ask for a refetch. Nothing
// here derives session state from a frame, so a dropped, duplicated or replayed
// publication cannot leave the panel asserting something the server never said.
// =============================================================================

/** How many 200-row pages of a session thread the panel will pull. */
const EVENT_PAGE_LIMIT = 200;
const EVENT_MAX_PAGES = 5;

export function useWorkSessions(workspaceId: string) {
  return useQuery({
    queryKey: ["work-sessions", workspaceId],
    queryFn: () => fetchWorkSessions(workspaceId),
    // The ledger is small and the panel is only mounted while someone is
    // watching it. A slow poll is the floor under the realtime rail: a session
    // started in a channel the cap left unwatched still lands, one minute late,
    // instead of never.
    refetchInterval: 60_000,
  });
}

export function useWorkHosts(workspaceId: string) {
  return useQuery({
    queryKey: ["work-hosts", workspaceId],
    queryFn: () => fetchWorkHosts(workspaceId),
    staleTime: 60_000,
  });
}

export interface SessionEventPage {
  events: WorkSessionEvent[];
  /** The thread is longer than the panel pulled; older rows are the ones held. */
  truncated: boolean;
}

async function fetchSessionEvents(
  workspaceId: string,
  channelId: string,
  rootId: string
): Promise<SessionEventPage> {
  const events: WorkSessionEvent[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < EVENT_MAX_PAGES; page += 1) {
    const res = await fetchThreadReplies(
      workspaceId,
      channelId,
      rootId,
      cursor,
      EVENT_PAGE_LIMIT
    );
    for (const message of res.messages) {
      const event = parseWorkSessionEvent(message);
      if (event) events.push(event);
    }
    if (res.nextCursor === undefined) return { events, truncated: false };
    cursor = res.nextCursor;
  }
  return { events, truncated: true };
}

/**
 * The durable event stream of one session, merged with whatever the rail has
 * delivered since. `live` is passed in rather than read here so the panel keeps
 * ONE subscription for every session it is watching, instead of one per open
 * detail view.
 */
export function useSessionEvents(
  workspaceId: string,
  session: WorkSession | null,
  live: readonly WorkSessionEvent[]
) {
  const query = useQuery({
    queryKey: [
      "work-session-events",
      workspaceId,
      session?.channelId ?? "",
      session?.rootMessageId ?? "",
    ],
    queryFn: () =>
      fetchSessionEvents(
        workspaceId,
        session?.channelId ?? "",
        session?.rootMessageId ?? ""
      ),
    enabled: session !== null,
  });

  const events = useMemo(
    () => mergeEvents(query.data?.events ?? [], live),
    [query.data, live]
  );

  return { ...query, events, truncated: query.data?.truncated ?? false };
}

export interface WorkSessionRail {
  /** Live events for every watched channel, newest appended. */
  liveEvents: WorkSessionEvent[];
  /** Channels with running sessions the subscription cap could not watch. */
  uncovered: string[];
}

/**
 * Subscribe the channels worth watching and keep the ledger fresh.
 *
 * Every lifecycle frame invalidates the session list rather than patching it:
 * `work.session.started` and `work.session.ended` carry enough to draw a row,
 * and drawing it from the frame is exactly how a client ends up one dropped
 * publication away from a permanently running session.
 */
export function useWorkSessionRail(
  workspaceId: string,
  sessions: readonly WorkSession[],
  openChannelId: string | null
): WorkSessionRail {
  const { realtime } = useSession();
  const queryClient = useQueryClient();
  const [liveEvents, setLiveEvents] = useState<WorkSessionEvent[]>([]);
  const liveRef = useRef<WorkSessionEvent[]>([]);

  const { watched, uncovered } = useMemo(
    () => workChannelsToWatch(sessions, openChannelId),
    [sessions, openChannelId]
  );
  // The effect depends on the KEY, not the array: a refetch that returns the
  // same channels builds a new array every time, and resubscribing on each one
  // would drop the frames in between (same rule as AgentWorkingRail).
  const watchKey = watched.join(",");

  const resync = useCallback(() => {
    // Every (re)subscribe heals from Postgres, including the first one. It is not
    // possible to tell a first subscribe from a reconnect here: `attach` shares
    // one Centrifugo subscription with the message rail, so the first
    // `subscribed` this panel sees may well be the timeline's reconnect. The
    // cost of being wrong the other way is a stale panel, so it always re-reads.
    //
    // The live buffer is dropped in the same breath: those events are already in
    // the thread the refetch is about to read, and keeping them would double
    // every row that arrived before the drop.
    if (liveRef.current.length > 0) {
      liveRef.current = [];
      setLiveEvents(liveRef.current);
    }
    void queryClient.invalidateQueries({ queryKey: ["work-sessions", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["work-session-events"] });
  }, [queryClient, workspaceId]);

  useEffect(() => {
    if (!realtime) return;
    const channels = watchKey === "" ? [] : watchKey.split(",");
    const stops = channels.map((channelId) =>
      realtime.subscribeWorkSession(workspaceId, channelId, {
        onLifecycle: () => {
          void queryClient.invalidateQueries({
            queryKey: ["work-sessions", workspaceId],
          });
        },
        onAcpEvent: (frame) => {
          const event = eventFromFrame(frame);
          const folded = event.eventId.toLowerCase();
          if (liveRef.current.some((e) => e.eventId.toLowerCase() === folded)) {
            return;
          }
          liveRef.current = [...liveRef.current, event];
          setLiveEvents(liveRef.current);
        },
        onResync: resync,
      })
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [realtime, workspaceId, watchKey, queryClient, resync]);

  return { liveEvents, uncovered };
}

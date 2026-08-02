import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchThreadReplies,
  fetchWorkHosts,
  fetchWorkSessions,
  uuidEq,
  type WorkSession,
} from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import {
  eventFromFrame,
  mergeEvents,
  parseWorkSessionEvent,
  workChannelsToWatch,
  type WorkSessionEvent,
} from "@momo/core/features/work/workSessionModel";

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

/**
 * Bound on the live tail (agentWorkingSignal's IDLE_CUTOFF/ZOMBIE_CLEAR sweep,
 * ported to a buffer that has no clock of its own).
 *
 * This panel is built to be left open, it watches up to
 * MAX_WORK_CHANNEL_SUBSCRIPTIONS channels at once, and a single answer can
 * publish 200 `agent.partial` frames (codex_workbench MAX_PARTIAL_EVENTS). An
 * unbounded array is therefore not a slow leak but the normal case, and the
 * dedupe used to be a linear scan of it on every frame, so the cost was
 * quadratic in the length of a watch.
 *
 * Dropping the oldest entries is safe in a way it would not be for a timeline:
 * every one of them is already durable in the session thread the panel reads
 * over REST, and `mergeEvents` prefers that durable row anyway. What is trimmed
 * is re-read, never lost. Trimming in one bite down to KEEP (rather than one
 * entry per frame) is what keeps the rebuild amortised.
 */
const LIVE_EVENT_CAP = 400;
const LIVE_EVENT_KEEP = 300;

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
  /** Folded event ids currently in the buffer: O(1) dedupe, rebuilt on trim. */
  const seenRef = useRef<Set<string>>(new Set());

  const publish = useCallback((next: WorkSessionEvent[]) => {
    liveRef.current = next;
    seenRef.current = new Set(next.map((e) => e.eventId.toLowerCase()));
    setLiveEvents(next);
  }, []);

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
    if (liveRef.current.length > 0) publish([]);
    void queryClient.invalidateQueries({ queryKey: ["work-sessions", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["work-session-events"] });
  }, [publish, queryClient, workspaceId]);

  const refetchSessionsAfterTransition = useCallback(() => {
    const queryKey = ["work-sessions", workspaceId];
    // A transition can beat the first list response. Cancelling the in-flight
    // query before invalidating makes React Query discard that stale response
    // and start one read whose snapshot is after the transition.
    void queryClient
      .cancelQueries({ queryKey })
      .then(() => queryClient.invalidateQueries({ queryKey }));
  }, [queryClient, workspaceId]);

  useEffect(() => {
    if (!realtime) return;
    const channels = watchKey === "" ? [] : watchKey.split(",");
    const stops = channels.map((channelId) =>
      realtime.subscribeWorkSession(workspaceId, channelId, {
        onLifecycle: (frame) => {
          // A session that ended keeps nothing in the live tail: its whole
          // stream is in the thread the invalidation below is about to re-read,
          // and holding it would mean a long watch accumulates every finished
          // session's frames until the next resync.
          if (frame.type === "work.session.ended") {
            const id = frame.payload.session_id;
            const kept = liveRef.current.filter((e) => !uuidEq(e.sessionId, id));
            if (kept.length !== liveRef.current.length) publish(kept);
          }
          refetchSessionsAfterTransition();
        },
        onToolTransition: (frame) => {
          // idle keeps the session alive but closes the current tool stream.
          // Drop only that session's transient tail; REST remains the state SoT.
          if (frame.type === "work.session.idle") {
            const id = frame.payload.session_id;
            const kept = liveRef.current.filter((e) => !uuidEq(e.sessionId, id));
            if (kept.length !== liveRef.current.length) publish(kept);
          }
          refetchSessionsAfterTransition();
        },
        // The observer count is read from Postgres, never from the frame that
        // announced it (MOMO-619). The frame says a capability was issued; the
        // number a reader sees has to survive a dropped or duplicated
        // publication, and the list projection is the only place that can
        // answer "how many are unexpired right now". Same rule as the lifecycle
        // frames above, for the same reason.
        onObserver: () => {
          void queryClient.invalidateQueries({
            queryKey: ["work-sessions", workspaceId],
          });
        },
        onAcpEvent: (frame) => {
          const event = eventFromFrame(frame);
          const folded = event.eventId.toLowerCase();
          if (seenRef.current.has(folded)) return;
          const next = [...liveRef.current, event];
          if (next.length > LIVE_EVENT_CAP) {
            publish(next.slice(next.length - LIVE_EVENT_KEEP));
            return;
          }
          liveRef.current = next;
          seenRef.current.add(folded);
          setLiveEvents(next);
        },
        onResync: resync,
      })
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [
    realtime,
    workspaceId,
    watchKey,
    queryClient,
    publish,
    resync,
    refetchSessionsAfterTransition,
  ]);

  return { liveEvents, uncovered };
}

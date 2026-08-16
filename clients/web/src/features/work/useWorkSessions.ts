import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import {
  latestSessionVerification,
  sessionCompletionReport,
  type SessionCompletionReport,
  type SessionVerification,
} from "@momo/core/features/work/sessionVerification";
import type { WorkSessionControlFrame } from "@momo/core/lib/realtimeEvents";

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

/**
 * The ledger is small and this used to be mounted only while someone was
 * watching the panel. A slow poll is the floor under the realtime rail: a
 * session started in a channel the cap left unwatched still lands, one minute
 * late, instead of never.
 */
const LEDGER_POLL_MS = 60_000;

/**
 * @param refetchIntervalMs How stale this observer is willing to let the ledger
 *   get. React Query keeps ONE query per key and uses the SHORTEST interval
 *   among its observers, so a second surface asking for fresher data costs no
 *   extra request.
 *
 *   It is a parameter rather than a second `useQuery` beside this one because
 *   two hooks on one key would carry two `queryFn`s, and which one the query
 *   actually runs would depend on mount order (ADE 관제 줄, 이슈 1135).
 */
export function useWorkSessions(
  workspaceId: string,
  refetchIntervalMs: number = LEDGER_POLL_MS
) {
  return useQuery({
    queryKey: ["work-sessions", workspaceId],
    queryFn: () => fetchWorkSessions(workspaceId),
    refetchInterval: refetchIntervalMs,
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
  /**
   * 완료 리포트들이 이 스레드에 남긴 것 (UXC-C).
   *
   * 두 번째 읽기가 아니라 **같은 페이지의 두 번째 질문**이다: 세션 원장 스레드는
   * 이미 여기서 통째로 읽히고, 지금까지는 ACP 이벤트만 건져내고 나머지를 버렸다.
   * 검증 칩의 원천이 그 버려지던 쪽에 있다(코어 `sessionVerification` 머리말).
   */
  reports: SessionCompletionReport[];
}

async function fetchSessionEvents(
  workspaceId: string,
  channelId: string,
  rootId: string
): Promise<SessionEventPage> {
  const events: WorkSessionEvent[] = [];
  const reports: SessionCompletionReport[] = [];
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
      if (event) {
        events.push(event);
        continue;
      }
      const report = sessionCompletionReport(message);
      if (report) reports.push(report);
    }
    if (res.nextCursor === undefined) {
      return { events, truncated: false, reports };
    }
    cursor = res.nextCursor;
  }
  return { events, truncated: true, reports };
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

  /**
   * 이 세션의 검증 상태, 또는 없음 (UXC-C).
   *
   * 절단된 읽기에서는 판정하지 않는다. 이 스레드는 오래된 쪽부터 페이지되므로
   * 절단이 잘라낸 것은 **가장 최근 리포트**이고, 그때 접힌 판정은 지난 이야기다
   * (`foldSessionEvents` 가 절단에서 「지금 이것이 실행 중」 승격을 전부 끄는 것과
   * 같은 규율). 실시간 레일은 이 자리에 아무것도 보태지 않는다 — 레일이 나르는
   * 것은 ACP 프레임뿐이고, 리포트는 Postgres 가 정본이다.
   */
  const verification: SessionVerification | null = useMemo(() => {
    const page = query.data;
    if (page === undefined || page.truncated) return null;
    return latestSessionVerification(page.reports);
  }, [query.data]);

  return {
    ...query,
    events,
    truncated: query.data?.truncated ?? false,
    verification,
  };
}

/**
 * 세션 스레드 읽기의 쿼리 키 접두 (`useSessionEvents` 의 키가 이것으로 시작한다).
 * 무효화는 이 접두 하나로 걸린다 — 화면에 열려 있는 스레드는 많아야 둘(미리보기와
 * 상세)이고, 프레임이 나른 `session_id` 에서 그 세션의 `rootMessageId` 로 가려면
 * 이 훅이 세션 목록의 **최신** 스냅샷을 콜백 안에서 들고 있어야 하는데, 그 배열은
 * 매 refetch 마다 새로 만들어지므로 여기서 붙잡으면 낡은 사본이 된다.
 */
const WORK_SESSION_EVENTS_KEY = ["work-session-events"];

/**
 * 살아 있는 꼬리를 버린 자리에서 스레드를 **다시 읽는다** (리뷰어 C G-H1).
 *
 * 순수 함수로 빼 둔 이유는 이것이 회귀 테스트가 붙잡을 수 있는 유일한 손잡이이기
 * 때문이다: 이 클라이언트에는 훅을 렌더할 DOM 이 없고, 「끝남 프레임이 스레드를
 * 다시 읽게 하는가」는 문자열 대조가 아니라 실제 QueryClient 에 물어야 하는 질문이다
 * (`sessionThreadInvalidation.test.ts`).
 */
export function invalidateSessionThreads(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: WORK_SESSION_EVENTS_KEY });
}

export interface WorkSessionRail {
  /** Live events for every watched channel, newest appended. */
  liveEvents: WorkSessionEvent[];
  /**
   * Control-window boundary events heard since this rail subscribed (LIVE-4).
   *
   * An empty array means **this client has heard nothing**, not that no window
   * exists: these are transport, the ledger is the SoT, and the surface that
   * draws them says which of the two it is holding.
   */
  controlFrames: WorkSessionControlFrame[];
  /** Channels with running sessions the subscription cap could not watch. */
  uncovered: string[];
}

/**
 * How many boundary frames the rail keeps.
 *
 * Small on purpose: the fold reads the newest frame per session, and a window
 * is a rare event (a person taking a keyboard), so anything larger would be
 * memory held for a history nothing reads.
 */
const CONTROL_FRAME_CAP = 32;

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
  /**
   * Boundary events, kept **as frames** rather than folded into a per-session
   * map here (LIVE-4).
   *
   * The fold is a judgement (`latestControlNotice`) and it lives in the core so
   * both clients answer "which window is the current one" the same way. Folding
   * here would put the second copy of that rule in a hook.
   *
   * Capped for the same reason the ACP buffer is: a long watch on a busy
   * channel must not grow without bound. The cap is small because the fold only
   * ever reads the newest frame per session.
   */
  const [controlFrames, setControlFrames] = useState<WorkSessionControlFrame[]>(
    []
  );
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
    // Boundary events are dropped on resync as well, and for a sharper reason
    // than the ACP tail: replayed frames are suppressed by the replay gate, so
    // what this buffer holds after a reconnect is a window whose close this
    // client may simply have missed. A stale 「조작 중」 is the one lie this
    // surface must not tell, and an empty buffer renders as 「아직 들은 것이
    // 없다」 rather than as an assertion.
    setControlFrames((held) => (held.length > 0 ? [] : held));
    void queryClient.invalidateQueries({ queryKey: ["work-sessions", workspaceId] });
    void invalidateSessionThreads(queryClient);
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
          // stream is in the thread `invalidateSessionThreads` re-reads, and
          // holding it would mean a long watch accumulates every finished
          // session's frames until the next resync.
          //
          // 그 re-read 가 **실제로 여기서 일어나야 한다**(리뷰어 C G-H1). 이
          // 주석은 앞 판에서도 같은 말을 했지만 아래 호출은 세션 **목록**만
          // 무효화했고, 스레드 무효화는 resync 콜백에만 있었다. 그 사이의 결함이
          // 정확히 이 티켓의 자리다: 미리보기·상세를 연 채 세션이 끝나고
          // 에이전트가 리포트를 스레드에 남기면, 목록 재읽기로 경과는 성과
          // 서술이 되는데 검증 칩은 부재로 남는다 — 화면이 「보고 없음」을 그리는
          // 동안 실패 리포트가 원장에 존재한다. 꼬리를 버리는 두 자리 모두에서
          // 스레드를 다시 읽는다.
          if (frame.type === "work.session.ended") {
            const id = frame.payload.session_id;
            const kept = liveRef.current.filter((e) => !uuidEq(e.sessionId, id));
            if (kept.length !== liveRef.current.length) publish(kept);
            void invalidateSessionThreads(queryClient);
          }
          refetchSessionsAfterTransition();
        },
        onToolTransition: (frame) => {
          // idle keeps the session alive but closes the current tool stream.
          // Drop only that session's transient tail; REST remains the state SoT
          // — and the same G-H1 rule applies, because this branch drops the tail
          // for the same reason and the durable rows behind it are only in the
          // thread. `idle` is also when a completion report lands most often
          // (the run finished, the host kept the terminal open).
          if (frame.type === "work.session.idle") {
            const id = frame.payload.session_id;
            const kept = liveRef.current.filter((e) => !uuidEq(e.sessionId, id));
            if (kept.length !== liveRef.current.length) publish(kept);
            void invalidateSessionThreads(queryClient);
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
        // LIVE-4 / 증보 3 D3. Unlike `onObserver` this frame is NOT a signal to
        // re-read Postgres: 정지 시각 and 재개 시각 have no column on the
        // session projection, so a refetch would answer with the same silence
        // this frame just broke. The envelope's own numbers are the fact.
        onControl: (frame) => {
          setControlFrames((held) => {
            const next = [...held, frame];
            return next.length > CONTROL_FRAME_CAP
              ? next.slice(next.length - CONTROL_FRAME_CAP)
              : next;
          });
          // A window opening parks the runs driving the session, and a close
          // resumes them. Neither moves `work_session.status` (증보 3 D6), but
          // both move what the agent rail should be saying, so the list is
          // re-read for the same reason a lifecycle frame re-reads it.
          refetchSessionsAfterTransition();
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

  return { liveEvents, controlFrames, uncovered };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  fetchMessages,
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
  reportForRoot,
  sessionCompletionReport,
  threadCompletionReports,
  type SessionCompletionReport,
  type SessionVerification,
  type ThreadCompletionReport,
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
   *
   * #1463 이후 이것은 검증 칩의 **두 번째** 원천이다. 첫째는 채널 히스토리를
   * 최신부터 훑는 스캔이고(`useSessionVerification`), 이쪽은 `truncated` 가 아닐
   * 때만 발언권을 갖는다 — 이 읽기는 오래된 쪽부터 페이지되므로 절단이 잘라내는
   * 것이 정확히 가장 최근 리포트다.
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

  return {
    ...query,
    events,
    truncated: query.data?.truncated ?? false,
  };
}

// =============================================================================
// 검증 칩의 read-model (#1463) — 세션 스레드가 아니라 **채널을 최신부터** 읽는다.
//
// 설계 근거 전문은 코어 `sessionVerification` 머리말 「그 스레드를 어느 방향으로
// 읽는가」에 있다. 여기 있는 것은 그 결정의 왕복 예산이다:
//
//   원천    `GET …/channels/{ch}/messages` (기본 DESC). 스레드 답글은 채널
//           메시지이고 서버가 히스토리에서 그것을 걸러내지 않으므로, 완료 리포트가
//           이 페이지에 실려 오고 행의 `rootId` 가 소속을 증명한다.
//   왕복    **채널당 최대 2페이지(×200)**, 세션 수와 무관. 목록에 세션이 40개여도
//           채널이 하나면 읽기는 하나다 — React Query 가 키(워크스페이스·채널)로
//           묶어 주므로 행마다 이 훅을 불러도 요청은 채널당 하나다.
//   절단    최신부터 읽으므로 예산이 잘라내는 것은 **가장 오래된** 쪽이다. 어떤
//           스레드에 대해 이 스캔이 찾은 리포트는 그 스레드의 최신 리포트이고,
//           못 찾았으면 칩이 서지 않는다(「미검증」이 아니라 부재).
//
// 세션당 5×200 스레드 읽기(`fetchSessionEvents`)는 그대로 있고 이 판정과 분리돼
// 있다. 그쪽은 진행 내역을 그리기 위한 읽기이고, 오래된 쪽부터 페이지되므로 검증에
// 대해서는 절단되지 않았을 때만 발언권이 있다(`useSessionVerification`).
// =============================================================================

const REPORT_PAGE_LIMIT = 200;

/**
 * 한 채널에서 최신부터 훑을 페이지 수.
 *
 * 2인 이유는 이것이 **부재를 정직하게 낼 수 있는** 읽기이기 때문이다: 예산을 키우면
 * 조용한 채널에서도 없는 리포트를 찾느라 왕복만 늘고(첫 페이지가 짧으면 어차피 거기서
 * 멈춘다), 줄이면 세션 하나가 끝난 직후 다른 세션이 쏟아내는 ACP 이벤트에 리포트가
 * 밀려난 채널에서 칩이 사라진다. 밀려나서 못 찾은 세션은 칩이 서지 않을 뿐이고,
 * 그것은 이 표면이 이미 하고 있는 말(부재≠미검증)과 같은 말이다.
 */
const REPORT_MAX_PAGES = 2;

/**
 * 이 채널의 세션 스레드별 최신 완료 리포트.
 *
 * 페이지가 `limit` 보다 짧으면 채널의 처음까지 간 것이므로 더 읽지 않는다.
 * `nextBefore` 로는 이 질문에 답할 수 없다 — 서버는 그것을 「이 페이지의 가장 작은
 * seq」로 채우므로 마지막 페이지에도 값이 있다(routes::messages::history).
 *
 * 훅 밖으로 내보내 두는 이유는 `invalidateSessionThreads` 와 같다: 이 클라이언트에는
 * 훅을 렌더할 DOM 이 없고, 「왕복이 정말 채널당 2회인가」·「두 번째 페이지가 정말 더
 * 오래된 쪽인가」는 문자열 대조가 아니라 실제로 불러 봐야 하는 질문이다
 * (`sessionReportScan.test.ts`).
 */
export async function fetchChannelSessionReports(
  workspaceId: string,
  channelId: string
): Promise<ThreadCompletionReport[]> {
  const found = new Map<string, ThreadCompletionReport>();
  let before: number | undefined;
  for (let page = 0; page < REPORT_MAX_PAGES; page += 1) {
    const res = await fetchMessages(workspaceId, channelId, {
      limit: REPORT_PAGE_LIMIT,
      ...(before === undefined ? {} : { before }),
    });
    // 나중 페이지는 더 오래된 쪽이므로, 이미 담긴 스레드는 덮지 않는다. 접기 자체는
    // 코어가 `seq` 로 다시 재므로 순서 사고가 나도 답이 뒤집히지 않는다.
    for (const report of threadCompletionReports(res.messages)) {
      if (!found.has(report.rootId)) found.set(report.rootId, report);
    }
    if (res.messages.length < REPORT_PAGE_LIMIT) break;
    // 다음 커서는 **이 페이지의 가장 작은 seq** 다. 서버가 이미 그 값을 계산해
    // `nextBefore` 로 싣고 있으므로 그것을 쓴다(routes::messages::history). 마지막
    // 행에서 읽는 것은 그 키가 없을 때의 대비이고, 정렬을 계약으로 삼지 않으려고
    // 위치가 아니라 최솟값으로 잰다.
    const oldest =
      res.nextBefore ?? Math.min(...res.messages.map((row) => row.seq));
    if (!Number.isFinite(oldest)) break;
    before = oldest;
  }
  return [...found.values()];
}

/**
 * 이 스캔의 쿼리 키 접두. 세션이 끝나거나(리포트가 막 떨어진다) 살아 있는 꼬리를
 * 버릴 때 스레드 읽기와 **함께** 무효화된다 — 두 읽기가 같은 순간의 원장을 말하지
 * 않으면 한 화면에서 경과는 성과 서술인데 칩만 부재인 상태가 다시 생긴다.
 */
const SESSION_REPORTS_KEY = ["work-session-reports"];

export function invalidateSessionReports(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: SESSION_REPORTS_KEY });
}

/**
 * 채널 하나의 리포트 스캔. 같은 채널의 행이 몇 개든 요청은 하나다(키가 같다).
 *
 * `retry: false` 인 이유: 이 읽기가 실패하는 가장 흔한 방법은 채널 비멤버(403)이고,
 * 그 답은 재시도로 바뀌지 않는다. 실패는 칩 부재로 끝난다 — 이 표면은 읽지 못한 것을
 * 배너로 승격하지 않는다(목록의 사실 원장은 세션 목록 쪽이다).
 *
 * 느린 폴링은 원장 폴링과 같은 자리에 있다(`LEDGER_POLL_MS` 머리말): 무효화는 레일이
 * 나른 전이에 걸리므로, 레일이 닿지 못한 채널에서 막 떨어진 리포트는 폴링이 없으면
 * 영영 오지 않는다. 관찰자가 몇이든 간격은 하나이고(같은 키), 패널이 닫히면 멈춘다.
 */
function useChannelSessionReports(workspaceId: string, channelId: string) {
  return useQuery({
    queryKey: [...SESSION_REPORTS_KEY, workspaceId, channelId.toLowerCase()],
    queryFn: () => fetchChannelSessionReports(workspaceId, channelId),
    enabled: channelId !== "",
    retry: false,
    staleTime: 30_000,
    // 실패한 채널은 폴링에서도 뺀다. 여기 실패의 대표가 비멤버(403)이고, 그 답은
    // 60초 뒤에도 같다 — 재시도를 끄고 폴링을 켜 두면 끈 재시도가 분당 한 번으로
    // 돌아올 뿐이다.
    refetchInterval: (query) =>
      query.state.error === null ? LEDGER_POLL_MS : false,
  });
}

/**
 * 이 세션의 검증 상태, 또는 없음 (UXC-C · #1463).
 *
 * 두 원천을 합쳐 코어의 한 판정에 넣는다:
 *
 *   1. 채널 히스토리 스캔이 이 스레드에 대해 찾은 리포트 — 최신부터 읽으므로
 *      찾았다면 그것이 최신이다. 목록 행이 가진 유일한 원천이기도 하다.
 *   2. 이 표면이 스레드를 **절단 없이** 통째로 읽었다면 그 페이지의 리포트들.
 *      절단된 페이지는 넣지 않는다 — 그때 없는 것이 정확히 가장 최근 리포트다.
 *
 * 실시간 레일은 이 자리에 아무것도 보태지 않는다: 레일이 나르는 것은 ACP 프레임뿐이고
 * 리포트는 Postgres 가 정본이다.
 *
 * 순수 함수인 이유는 아래 훅의 그것과 같다 — 「절단된 스레드가 판정에 끼어들지
 * 않는가」는 이 클라이언트에 DOM 이 없는 한 여기서만 물을 수 있다.
 */
export function sessionVerificationFrom(
  scanned: readonly ThreadCompletionReport[] | undefined,
  rootMessageId: string,
  threadPage?: SessionEventPage | undefined
): SessionVerification | null {
  const candidates: SessionCompletionReport[] = [];
  const hit = reportForRoot(scanned, rootMessageId);
  if (hit !== null) candidates.push(hit);
  if (threadPage !== undefined && !threadPage.truncated) {
    candidates.push(...threadPage.reports);
  }
  return latestSessionVerification(candidates);
}

/**
 * 위 판정을 이 세션의 채널 스캔에 붙인 훅.
 *
 * @param threadPage 스레드를 이미 읽은 표면(미리보기·상세)이 그 페이지를 함께 낸다.
 *   목록 행은 넘기지 않으므로 추가 왕복이 0이다.
 */
export function useSessionVerification(
  workspaceId: string,
  session: WorkSession,
  threadPage?: SessionEventPage | undefined
): SessionVerification | null {
  const scan = useChannelSessionReports(workspaceId, session.channelId);
  const scanned = scan.data;
  const rootMessageId = session.rootMessageId;
  return useMemo(
    () => sessionVerificationFrom(scanned, rootMessageId, threadPage),
    [scanned, rootMessageId, threadPage]
  );
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
    void invalidateSessionReports(queryClient);
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
            // 리포트는 세션이 끝나는 바로 그때 떨어지고, 이제 그것을 나르는 읽기는
            // 채널 히스토리 스캔이다(#1463). 스레드만 다시 읽으면 G-H1 이 고친 그
            // 결함이 원천만 바뀐 채 그대로 돌아온다.
            void invalidateSessionReports(queryClient);
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
            void invalidateSessionReports(queryClient);
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

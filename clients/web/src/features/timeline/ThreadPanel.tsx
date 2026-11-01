import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, usePresence, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import {
  fetchThreadReplies,
  markThreadRead,
  type Channel,
  type Message,
  type ThreadReadState,
} from "@momo/core/lib/api";
import type { Directory } from "@/features/workspace/useWorkspace";
import type { OpenWorkSession } from "@/features/work/openWorkSession";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { startsAuthorGroup } from "@momo/core/features/timeline/model";
import { createThreadReadSender } from "@momo/core/features/timeline/threadRead";
import { readSignalSeq } from "@momo/core/features/timeline/threadSummary";
import { MessageRow, type MessageRowActions } from "./MessageRow";
import { TimelineLiveRegionProvider } from "./timelineLiveRegion";
import { ThreadSurfaceRoot } from "./commandSuggestSlot";
import { ThreadComposer } from "./ThreadComposer";
import { chipsFor, type ReactionMap } from "@momo/core/features/timeline/reactions";
import { isPinned, type PinMap } from "@momo/core/features/timeline/pins";
import { overlayOwnsEscape } from "@/design/ui/escapeLayer";
import { PANEL_MOTION } from "@/design/motion";
import { cn } from "@/design/lib/cn";
import { Tooltip } from "@/design/ui/tooltip";
import { channelHeaderControlClass } from "@/features/chat/channelHeaderControl";
import { documentForeground } from "@/features/chat/useChannelViewingBeat";
import { THREAD_REPLIES_LEAD_CLASS } from "./spacing";
import { shouldFoldBundleLine } from "@momo/core/features/timeline/requestBundle";
import { runsByTriggerMessage } from "@momo/core/features/agents/runStatusLine";
import { useChannelRuns } from "@/features/agents/agentRunProgressStore";
import { runStatusForMessage } from "./runStatus";
import type { RequestThreadLanding } from "./useRequestThreadLanding";
import { watchForMessageId } from "@/features/inbox/anchor";
import { viewThread } from "@/features/notifications/viewedThread";
import type { RealtimeHandle } from "@/lib/realtime";
import { ThreadFollowButton } from "./ThreadFollowButton";
import { useThreadFollow } from "./useThreadFollow";

const NO_REPLIES: Message[] = [];

// =============================================================================
// Thread panel (R-1 §3 "스레드 진입 자리", P12: replies live outside the channel
// so the main view stays readable). A right-hand panel rather than an inline
// expansion, sharing the exact MessageRow anatomy of the channel timeline.
// =============================================================================

type ThreadPanelProps = {
  workspaceId: string;
  channelId: string;
  /**
   * Parent-owned presence. `null` plays the visual exit; a new root reuses
   * the presence slot (`key="thread-panel"`) and **interrupts** that exit.
   * `onClose` runs on user intent, immediately — the exit must not own the
   * parent's `thread` state (#1997 B-1).
   */
  root: Message | null;
  directory: Directory;
  /** 답글 컴포저의 `#` 후보 (#1930). 채널 컴포저와 같은 목록을 내려 준다. */
  channels: Channel[];
  /**
   * B11 — the same actions the channel row offers, so a reply is edited,
   * deleted and reacted to exactly where it is read. Omitted by the work
   * session panel, whose rows are an event log.
   */
  actions?: Omit<MessageRowActions, "chips" | "pinned">;
  reactions?: ReactionMap;
  /** 이슈 #1112 — a reply is pinned from where it is read, like every other action. */
  pins?: PinMap;
  onOpenWorkSession?: OpenWorkSession;
  onClose: () => void;
  isPlayEntrance?: (messageId: string) => boolean;
  onEntranceConsumed?: (messageId: string) => void;
  requestLanding?: RequestThreadLanding | null;
  realtime?: RealtimeHandle | null;
  /**
   * 「여기까지 읽었어요」 신호의 응답(#4878, #4889 2단계). 패널은 신호를 보내고(`createThreadReadSender`) 응답을 여기로
   * 넘긴다 — 채널 목록의 루트 요약(「새 답글 M」 칩)이 **타임라인 상태의 루트**에서 그려지므로 그 상태를 고치는 것은 호스트의
   * 일이다. 없으면(작업 세션 패널) 신호도 보내지 않는다.
   */
  onThreadRead?: (rootId: string, state: ThreadReadState) => void;
  /**
   * 머리에 「따라가기」를 둘 수 있는 곳인가(#4890). DM 채널의 스레드는 따라가지 않는다(모든 메시지가 이미 알림이다 — 서버도
   * 400 `thread_follow_not_applicable`). 호스트가 채널 종류를 안다. 생략하면 둘 수 있다. 대화 표면(`actions` 가 있는 곳)만
   * 서고, 작업 세션 패널은 사건 기록이라 따라갈 대화가 아니다.
   */
  followable?: boolean;
};

const CLOSE_LABEL = "스레드 닫기";

/** 사람이 이 창을 보고 있는가 — 「보고 있음」 신호가 쓰는 어댑터 그대로(탭이 보이고 창이 포커스를 가졌다). */
function useForeground(): boolean {
  return useSyncExternalStore(
    (notify) => documentForeground.subscribe(() => notify()),
    () => documentForeground.isForeground(),
    () => true
  );
}

export function ThreadPanel(props: ThreadPanelProps) {
  const { root, onClose } = props;
  const openerRef = useRef<HTMLElement | null>(null);
  const capturedForRoot = useRef<string | null>(null);

  // Capture the opener at open time (root change), not first render, so a
  // close during a later thread returns the caret to that later anchor.
  if (root && capturedForRoot.current !== root.id) {
    capturedForRoot.current = root.id;
    if (typeof document !== "undefined") {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
    }
  }
  if (!root) {
    capturedForRoot.current = null;
  }

  const closePanel = useCallback(() => {
    const opener = openerRef.current;
    onClose();
    if (opener?.isConnected) opener.focus();
  }, [onClose]);

  return (
    <AnimatePresence>
      {root ? (
        <ThreadPanelFrame
          key="thread-panel"
          {...props}
          root={root}
          onClose={closePanel}
        />
      ) : null}
    </AnimatePresence>
  );
}

function ThreadPanelFrame({
  workspaceId,
  channelId,
  root,
  directory,
  channels,
  actions,
  reactions,
  pins,
  onOpenWorkSession,
  onClose: closePanel,
  isPlayEntrance,
  onEntranceConsumed,
  requestLanding,
  realtime,
  onThreadRead,
  followable = true,
}: ThreadPanelProps & { root: Message }) {
  const [isPresent, safeToRemove] = usePresence();
  const reduceMotion = useReducedMotion();
  const asideRef = useRef<HTMLElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isPresent) return;
    if (reduceMotion) {
      safeToRemove();
      return;
    }
    const node = slideRef.current;
    if (!node) {
      safeToRemove();
      return;
    }
    const durationMs = Number.parseFloat(getComputedStyle(node).animationDuration);
    const duration =
      Number.isFinite(durationMs) && durationMs > 0
        ? getComputedStyle(node).animationDuration.includes("ms")
          ? durationMs
          : durationMs * 1000
        : 0;
    const onEnd = (event: AnimationEvent) => {
      if (event.target !== node) return;
      safeToRemove();
    };
    node.addEventListener("animationend", onEnd);
    const fallback = window.setTimeout(() => safeToRemove(), duration);
    return () => {
      node.removeEventListener("animationend", onEnd);
      window.clearTimeout(fallback);
    };
  }, [isPresent, reduceMotion, safeToRemove]);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["thread", workspaceId, channelId, root.id], [workspaceId, channelId, root.id]);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      let page = await fetchThreadReplies(workspaceId, channelId, root.id);
      if (!requestLanding || requestLanding.rootId.toLowerCase() !== root.id.toLowerCase()) return page;
      const messages = [...page.messages];
      const cursors = new Set<number>();
      for (let index = 1; index < 8 && !messages.some((message) => message.id.toLowerCase() === requestLanding.messageId.toLowerCase()); index += 1) {
        if (page.nextCursor === undefined || cursors.has(page.nextCursor)) break;
        cursors.add(page.nextCursor);
        page = await fetchThreadReplies(workspaceId, channelId, root.id, page.nextCursor, 200);
        for (const message of page.messages) if (!messages.some((known) => known.id === message.id)) messages.push(message);
      }
      return { ...page, messages };
    },
  });
  // 따라가기(#4890): 스레드 열기 응답의 `following` 이 처음 값이고, 누르면 낙관적으로 바뀐다(코어 `threadFollow` 가 규칙).
  const follow = useThreadFollow({
    workspaceId,
    channelId,
    rootId: root.id,
    queryKey,
    serverFollowing: query.data === undefined ? undefined : query.data.following === true,
  });
  const refetchReplies = query.refetch;
  const refreshQueue = useMemo(() => ({ key: queryKey, active: true, running: false, dirty: false }), [queryKey]);
  useEffect(() => { refreshQueue.active = true; return () => { refreshQueue.active = false; }; }, [refreshQueue]);
  const refreshReplies = useCallback(() => {
    refreshQueue.dirty = true;
    if (refreshQueue.running) return;
    refreshQueue.running = true;
    void (async () => {
      try {
        // 진행 중 GET의 옛 snapshot에 뒤늦은 프레임이 흡수되지 않게 해요.
        if (queryClient.getQueryState(refreshQueue.key)?.fetchStatus === "fetching") await refetchReplies({ cancelRefetch: false });
        while (refreshQueue.active && refreshQueue.dirty) {
          refreshQueue.dirty = false;
          await refetchReplies({ cancelRefetch: false });
        }
      } finally { refreshQueue.running = false; }
    })();
  }, [refreshQueue, queryClient, refetchReplies]);
  const channelRuns = useChannelRuns(actions ? channelId : null);
  const runsByMessage = useMemo(() => runsByTriggerMessage(channelRuns), [channelRuns]);
  const runStatusFor = (message: Message) => runStatusForMessage({ message, directory, myMemberId: actions?.myMemberId, runsByMessage });

  const allReplies = query.data?.messages ?? NO_REPLIES;

  // 읽음 신호 (#4878, #4889 2단계): 스레드를 열어 둔 동안 화면에 든 답글의 최대 seq가 오르면 한 번 보낸다(열 때 첫 읽기,
  // 새 답글이 그려질 때마다). 사람이 이 창을 보고 있을 때만이다 — 창이 뒤에 있는 동안 온 답글을 읽은 것으로 치지 않는다.
  // 대화 표면(`actions`가 있는 곳)만: 작업 세션 패널의 행은 사건 기록이고 읽는 대화가 아니다. 보내는 이는 이 프레임이
  // 사는 동안 하나이고(루트가 바뀌어도 루트별로 센다), 호출 인자는 ref로 읽어 호스트가 바뀌어도 새로 만들지 않는다.
  const readTarget = useRef({ workspaceId, channelId, onThreadRead });
  readTarget.current = { workspaceId, channelId, onThreadRead };
  const readSender = useMemo(
    () =>
      createThreadReadSender({
        send: (rootId, seq) =>
          markThreadRead(readTarget.current.workspaceId, readTarget.current.channelId, rootId, seq),
        onState: (rootId, state) => readTarget.current.onThreadRead?.(rootId, state),
      }),
    []
  );
  const foreground = useForeground();
  const readsThread = actions !== undefined;
  useEffect(() => {
    if (!readsThread || !foreground) return;
    readSender.note(root.id, readSignalSeq(allReplies));
  }, [readsThread, foreground, readSender, root.id, allReplies]);
  // 이 패널이 열려 있는 동안 어느 스레드를 보여 주는지 데스크탑 알림 판정에 알린다(#4890: 「그 스레드를 보고 있으면 안 띄움」).
  // 닫히는 중(`isPresent` 가 거짓)은 이미 닫은 것이다. 읽음 신호와 같은 이유로 대화 표면만이다.
  useEffect(() => {
    if (!readsThread || !isPresent) return;
    return viewThread(channelId, root.id);
  }, [readsThread, isPresent, channelId, root.id]);
  const showFollow = readsThread && followable && query.data !== undefined && !follow.view.unavailable;

  const replyIds = useRef(new Set<string>());
  replyIds.current = new Set(allReplies.map((message) => message.id.toLowerCase()));
  const replies = allReplies.filter((message) => !shouldFoldBundleLine(message, allReplies));
  // 생각 줄(#4761)의 24px 자리는 **이 스레드에 run이 하나라도 있을 때만** 선다. run이 없는 평범한 스레드에서도 자리가 늘
  // 서면 내 루트 아래에 빈 줄이 생긴다(#4878, owner 10-31 「루트 아래 빈 공간이 크다」). 요청 스레드·에이전트가 답한
  // 스레드는 run이 있으므로 예전과 같다. 스레드에서 처음 에이전트를 부르는 답글은 run이 생기는 순간 줄이 서고 그때
  // 자리가 한 번 생긴다(예약은 두 번째 요청부터).
  const threadHasRuns = [root, ...replies].some((message) => (runStatusFor(message)?.length ?? 0) > 0);
  const [landingMissed, setLandingMissed] = useState(false);
  const landedTarget = useRef<number | null>(null);
  useEffect(() => {
    if (!requestLanding || requestLanding.rootId.toLowerCase() !== root.id.toLowerCase()) return;
    if (landedTarget.current === requestLanding.token) return;
    setLandingMissed(false);
    refreshReplies();
  }, [requestLanding, root.id, refreshReplies]);
  useEffect(() => {
    if (!realtime) return;
    const refresh = refreshReplies;
    return realtime.subscribeChannel(workspaceId, channelId, {
      onSubscribed: refresh,
      onMessage: (event) => {
        if (event.payload.root_id?.toLowerCase() === root.id.toLowerCase() || replyIds.current.has(event.payload.id.toLowerCase())) refresh();
      },
      onMessageDeleted: refresh,
    });
  }, [realtime, workspaceId, channelId, root.id, refreshReplies]);
  useEffect(() => {
    if (!requestLanding || requestLanding.rootId.toLowerCase() !== root.id.toLowerCase()) return;
    if (landedTarget.current === requestLanding.token) return;
    if (!allReplies.some((message) => message.id.toLowerCase() === requestLanding.messageId.toLowerCase())) return;
    const row = Array.from(asideRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []).find((node) => node.dataset.messageId?.toLowerCase() === requestLanding.messageId.toLowerCase());
    return watchForMessageId(requestLanding.messageId, {
      nudge: () => row?.scrollIntoView({ block: "center" }),
      onLand: () => { landedTarget.current = requestLanding.token; },
      onExpire: () => setLandingMissed(true),
    });
  }, [requestLanding, root.id, allReplies]);
  const targetMissing = requestLanding?.rootId.toLowerCase() === root.id.toLowerCase() && !query.isLoading && !query.isFetching && !query.error && !allReplies.some((message) => message.id.toLowerCase() === requestLanding.messageId.toLowerCase());

  /** Per-row actions, with this row's chips and pin state folded in. */
  const rowActions = (message: Message): MessageRowActions | undefined =>
    actions && {
      ...actions,
      chips: chipsFor(reactions ?? {}, message.id, actions.myMemberId),
      pinned: isPinned(pins ?? {}, message.id),
    };

  return (
    // `thread-pane` (goal B6): 900px 위에서는 그대로 320px 열이고, 그 아래에서는
    // 채널 표면 전체를 덮는 서랍이 된다 (tokens.css). 320px 패널이 390px 화면에서
    // 채널에 70px만 남기던 자리이고, 그 문턱이 폰(600px)이 아니라 900px인 이유는
    // 같은 산술이 700px 창에서도 참이기 때문이다 — 채널에 140px, 컴포저에 36px가
    // 남았다 (#1421 실측).
    //
    // `shrink-0`은 `thread-pane`이 flex 기준선을 갖게 되면서 빠졌다 (#1418):
    // 이 pane과 작업 세션 pane은 채널 열과 같은 행을 나눠 갖고, 그 행의 바닥은
    // 채널 열이 든다(`chat-region`). 한쪽만 양보하지 못하면 바닥이 넘침이 된다.
    //
    // The layout box (this aside) keeps the 320px column and clips; the inner
    // surface is what slides. Transform on the layout box itself left a bare
    // strip between the timeline and the arriving paint (#1997 N-1).
    <aside
      ref={asideRef}
      aria-label="스레드"
      data-testid="thread-panel"
      data-state={isPresent ? "open" : "closed"}
      data-root-id={root.id}
      onKeyDown={(event) => {
        // 작업 서랍과 동형: Escape로 서랍을 닫는다 (#1431 · WorkPanel.tsx:839-852).
        // 이 서랍은 작업 서랍의 상세/엿보기 같은 중간 단계가 없어 한 단계뿐이므로,
        // stopPropagation 없이 곧장 닫는 WorkPanel의 마지막 분기(`closePanel()`)와
        // 같다. 답글 컴포저의 멘션 목록은 공용 useEscapeLayer가 먼저 한 단계만
        // 물러나며 전파를 막는다. 목록이 닫힌 뒤의 Escape만 여기로 올라온다.
        //
        // 이모지 피커는 Radix 포탈이라 DOM 경로에는 이 aside가 없지만, React는
        // 포탈을 트리 부모로 버블시킨다. 같은 Escape가 피커를 닫은 뒤 이
        // 리스너에 닿으면 overlayOwnsEscape(event)가 그 키를 삼킨다. Presence
        // 닫힘 동안의 *다음* Escape는 새 이벤트라 서랍이 받는다 (#1996 M-1).
        if (event.key !== "Escape") return;
        if (event.defaultPrevented) return;
        if (overlayOwnsEscape(undefined, event.nativeEvent)) return;
        closePanel();
      }}
      className="thread-pane flex h-full flex-col overflow-hidden border-l border-line bg-pane data-[state=closed]:pointer-events-none"
    >
      <div
        ref={slideRef}
        className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col", PANEL_MOTION)}
        data-state={isPresent ? "open" : "closed"}
      >
      {/* 머리의 닫기는 채널 머리의 아이콘 단추와 같은 문법이다(#4878: 24px 맨 아이콘이던 것을 `.a-ibtn` 34px 둥근 사각 +
          아주 연한 선으로, 툴팁은 아래 — 머리 단추는 전부 공유 `Tooltip`을 입는다). */}
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-body font-semibold">스레드</h2>
        <div className="flex items-center gap-2">
          {showFollow && (
            <ThreadFollowButton view={follow.view} copy={follow.copy} onToggle={follow.toggle} />
          )}
          <Tooltip label={CLOSE_LABEL} side="bottom">
            <button
              type="button"
              onClick={closePanel}
              aria-label={CLOSE_LABEL}
              data-testid="thread-close"
              className={channelHeaderControlClass()}
            >
              <X className="size-4" />
            </button>
          </Tooltip>
        </div>
      </header>
      {showFollow && follow.view.failed && (
        <InlineBanner
          message={follow.copy.failed}
          actionLabel={follow.copy.dismiss}
          onAction={follow.dismissError}
          testId="thread-follow-failed"
        />
      )}

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-message-scroll-container=""
      >
        <TimelineLiveRegionProvider>
        <ThreadSurfaceRoot.Provider value={root.id}>
        {/* 루트에 「답글 N개」를 적지 않는다 (goal RN-U2).

            성재(iOS 실기기): "답글에서 개수 업데이트는 굳이 왜 해? 목록에 나오면
            몇 개의 reply가 있는지는 자연스러운데, 답글에서 '답글 1개' 이런 식으로
            보이는 건 자연스럽지 않은 거 같아."

            같은 제품 판단이므로 웹도 같이 고친다. 롤업은 **채널 목록에서 "여기
            스레드가 있다"를 알리는 장치**이고, 이미 그 스레드를 열어 둔 사람에게는
            자기가 서 있는 곳의 이름을 다시 읽어 주는 것에 불과하다 — 게다가 답글을
            달 때마다 숫자가 오른다.

            goal P3 1-1 이 이 자리를 <button>에서 <span>으로 내린 것이 절반이었고
            (죽은 컨트롤을 없앴다), 나머지 절반이 이것이다: 글이어도 여기서는 할 말이
            없다. */}
        <MessageRow
          message={root}
          startsGroup
          directory={directory}
          actions={rowActions(root)}
          onOpenWorkSession={onOpenWorkSession}
          showRollup={false}
          runStatus={runStatusFor(root)}
          showThought={threadHasRuns}
          playEntrance={isPlayEntrance?.(root.id) ?? false}
          onEntranceConsumed={
            onEntranceConsumed
              ? () => onEntranceConsumed(root.id)
              : undefined
          }
        />
        {/* 루트와 답글 사이에는 선을 긋지 않는다 (#1753). 빈 상태일 때만 그 상태 자체의 조용한 점선 상자가 영역을
            말한다. 이 칸은 **뒤집힌 루트 툴바가 걸치는 띠**다: 높이와 이유는 `THREAD_REPLIES_LEAD_CLASS`(spacing.ts)가
            적고, 실제 엔진에서 잰다(`threadSurface.browser.test.ts`). */}
        <div className={THREAD_REPLIES_LEAD_CLASS} data-testid="thread-replies">
          {(landingMissed || targetMissing) && <InlineBanner message="알림의 카드를 찾지 못했어요. 답글을 다시 불러와 주세요." actionLabel="다시 불러오기" onAction={() => void query.refetch()} testId="thread-landing-missing" />}
          <Skeleton ready={!query.isLoading} rows={3} className="p-4">
            {query.error && (
              <InlineBanner
                message="답글을 불러오지 못했습니다."
                actionLabel="다시 시도"
                onAction={() => void query.refetch()}
                testId="thread-error"
              />
            )}
            {!query.isLoading && !query.error && replies.length === 0 && (
              <EmptyInvite
                headline="첫 답글을 남겨 이 대화를 이어가세요."
                className="mx-4 rounded-md border border-dashed border-line"
                testId="thread-empty"
              />
            )}
            {replies.map((reply, index) => (
              <MessageRow
                key={reply.seq}
                message={reply}
                startsGroup={startsAuthorGroup(replies[index - 1], reply)}
                directory={directory}
                actions={rowActions(reply)}
                onOpenWorkSession={onOpenWorkSession}
                // 답글은 애초에 롤업을 갖지 않는다(서버 투영이 `root_id IS NULL` 로
                // 거른다 — 스레드는 한 단계다). 명시해 두는 것은 그 불변식이 깨져
                // 답글에 `thread` 가 실려 오는 날에도 이 화면이 답글 밑에 답글이 있다고
                // 말하지 않게 하기 위해서다.
                showRollup={false}
                runStatus={runStatusFor(reply)}
                showThought={threadHasRuns}
                playEntrance={isPlayEntrance?.(reply.id) ?? false}
                onEntranceConsumed={
                  onEntranceConsumed
                    ? () => onEntranceConsumed(reply.id)
                    : undefined
                }
              />
            ))}
          </Skeleton>
        </div>
        </ThreadSurfaceRoot.Provider>
        </TimelineLiveRegionProvider>
      </div>

      {/* B11 — the half that was missing. Reading a thread and not being able
          to answer in it made 답글 a link to a transcript. Offered only where
          the surface is a conversation: the work session panel passes no
          `actions`, and its event log stays read-only. */}
      {actions && (
        <ThreadComposer
          workspaceId={workspaceId}
          channelId={channelId}
          rootId={root.id}
          directory={directory}
          channels={channels}
          onSent={() => void query.refetch()}
        />
      )}
      </div>
    </aside>
  );
}

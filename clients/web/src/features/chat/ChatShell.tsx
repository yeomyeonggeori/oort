import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Hash, Lock, MessageSquare, SquareTerminal } from "lucide-react";
import {
  fetchMessages,
  updateReadState,
  uuidEq,
  type Message,
  type WorkSession,
} from "@/lib/api";
import { useSession } from "@/app/session";
import {
  channelLabel,
  channelLabelParts,
  dmPeer,
  makeDirectory,
  memberFor,
  unreadFor,
  useChannels,
  useDirectory,
  useInvalidateReadStates,
  useReadStates,
} from "@/features/workspace/useWorkspace";
import { watchForMessage, watchForMessageId } from "@/features/inbox/anchor";
import { Timeline } from "@/features/timeline/Timeline";
import { CascadeProvider } from "@/features/timeline/cascadeRail";
import { ThreadPanel } from "@/features/timeline/ThreadPanel";
import { WorkPanel } from "@/features/work/WorkPanel";
import type { WorkScope } from "@/features/work/workSessionModel";
import { useTimeline } from "@/features/timeline/useTimeline";
import {
  makeStressRoster,
  makeSyntheticMessages,
} from "@/features/timeline/stress";
import { Composer } from "@/features/chat/Composer";
import { canCreateChannelNow } from "@/features/channels/model";
import { useOpenCreateChannel } from "@/features/channels/useCreateChannel";
import {
  HuddleHeaderBanner,
  HuddleHeaderControl,
  HuddleHeaderState,
} from "@/features/huddles/HuddleHeaderControl";
import type { HuddleController } from "@/features/huddles/useHuddle";
import {
  EmptyInvite,
  InlineBanner,
  SkeletonRows,
} from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";

// =============================================================================
// Channel surface (R-1 §3): header, offline banner, timeline, composer, thread
// panel. The realtime rail and the sidebar live in the shell above, so moving
// between channels never drops the connection.
// =============================================================================

// A missing/deleted root must not turn one click into an unbounded walk through
// channel history. Twenty-five full pages still cover 5,000 messages; after
// that the existing not-found result is the honest answer this client has.
const WORK_THREAD_ROOT_PAGE_LIMIT = 25;

export function ChatShell() {
  const { session, workspaceId, realtime, connStatus } = useSession();
  const isOffline = useOffline();
  const params = useParams();
  const navigate = useNavigate();

  // ── 1k-scroll gate: ?stress=N renders synthetic rows, no network ───────────
  const stressCount = useMemo(() => {
    const n = Number(new URLSearchParams(location.search).get("stress"));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }, []);
  const stressMessages = useMemo(
    () => (stressCount > 0 ? makeSyntheticMessages(stressCount) : []),
    [stressCount]
  );

  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const readStates = useReadStates(workspaceId);
  const invalidateReadStates = useInvalidateReadStates(workspaceId);

  // The stress path never hits /roster, so it carries its own members: without
  // them every row would render a uuid stub and the dense capture would review
  // a surface nobody ships.
  const stressDirectory = useMemo(
    () => makeDirectory(stressCount > 0 ? makeStressRoster() : []),
    [stressCount]
  );
  const directory =
    stressCount > 0 ? stressDirectory : directoryQuery.directory;

  // The index route lands on the first channel the server actually returned.
  // Nothing is hardcoded: a workspace with no channels renders the empty state
  // instead of pointing at an id that may not exist here.
  const channelId =
    params.channelId ??
    channelsQuery.groups.channels[0]?.id ??
    channelsQuery.groups.dms[0]?.id ??
    null;

  const channel = useMemo(
    () =>
      channelId === null
        ? null
        : [...channelsQuery.groups.channels, ...channelsQuery.groups.dms].find(
            (c) => uuidEq(c.id, channelId)
          ) ?? null,
    [channelsQuery.groups, channelId]
  );
  // Two labels, one rule (channelLabelParts): the header renders the name and
  // the disambiguating handle as separate spans, and everything that can only
  // take a string (the composer placeholder, its sr-only label) gets them
  // joined. A DM in this workspace can be one of two 김인턴.
  const labelParts = channel
    ? channelLabelParts(channel, directory, session.member.id)
    : null;
  const label = channel
    ? channelLabel(channel, directory, session.member.id)
    : "채널";
  const peer = channel ? dmPeer(channel, directory, session.member.id) : null;

  const timeline = useTimeline(
    realtime,
    workspaceId,
    stressCount > 0 ? null : channelId,
    session.member.id
  );
  const messages = stressCount > 0 ? stressMessages : timeline.state.messages;

  // Unread boundary is the cursor as it stood when the channel was OPENED:
  // advancing the cursor below must not erase the divider under the reader.
  const [openedWith, setOpenedWith] = useState<{
    channelId: string;
    lastReadSeq: number | null;
    unreadCount: number;
  } | null>(null);
  const markedRef = useRef<string | null>(null);

  useEffect(() => {
    if (channelId === null) return;
    const read = unreadFor(readStates.byChannel, channelId);
    setOpenedWith((current) => {
      if (current && uuidEq(current.channelId, channelId)) return current;
      if (!read) return { channelId, lastReadSeq: null, unreadCount: 0 };
      return {
        channelId,
        lastReadSeq: read.lastReadSeq,
        unreadCount: read.unreadCount,
      };
    });
  }, [channelId, readStates.byChannel]);

  // Advance the server read cursor once history is on screen (P7: the server
  // owns unread, so the client reports a position instead of counting).
  const newestSeq = timeline.state.newestSeq;
  useEffect(() => {
    if (stressCount > 0 || newestSeq === null || channelId === null) return;
    const key = `${channelId}:${newestSeq}`;
    if (markedRef.current === key) return;
    markedRef.current = key;
    updateReadState(workspaceId, channelId, newestSeq)
      .then(() => invalidateReadStates())
      .catch(() => {
        /* the cursor is advisory; the next open retries it */
      });
  }, [workspaceId, channelId, newestSeq, stressCount, invalidateReadStates]);

  const [thread, setThread] = useState<Message | null>(null);
  useEffect(() => setThread(null), [channelId]);

  // 작업 세션 패널 (AX-3 / MOMO-618). One secondary pane at a time: a thread and
  // a work session are both "the thing you stepped aside to read", and stacking
  // two 320px panes on a 1280px window leaves the channel narrower than either.
  //
  // What the panel is SHOWING lives here rather than inside it, because closing
  // it unmounts it: held locally, the chosen range and the session being read
  // were thrown away on every close, and reopening dropped an all-workspace
  // view back to the current channel (frequently an empty list).
  const [workOpen, setWorkOpen] = useState(false);
  const [workScope, setWorkScope] = useState<WorkScope>("channel");
  const [workSessionId, setWorkSessionId] = useState<string | null>(null);
  const [openingWorkThreadId, setOpeningWorkThreadId] = useState<string | null>(
    null
  );
  const [workThreadOpenError, setWorkThreadOpenError] = useState<string | null>(
    null
  );
  const [pendingWorkThread, setPendingWorkThread] = useState<{
    channelId: string;
    root: Message;
  } | null>(null);
  const workThreadRequestRef = useRef(0);

  const openWorkSession = useCallback((sessionId: string) => {
    setThread(null);
    setWorkScope("channel");
    setWorkSessionId(sessionId);
    setWorkOpen(true);
  }, []);

  // A scope chip means "show me that list". The panel keeps its selected
  // session across close/reopen (returning to where you were), so while a
  // detail is open the chips would otherwise change state with no visible
  // effect — a live-looking control that does nothing. Clearing the selection
  // makes the chip's promise and the screen agree.
  const changeWorkScope = useCallback((scope: WorkScope) => {
    setWorkSessionId(null);
    setWorkScope(scope);
  }, []);

  const openWorkSessionThread = useCallback(
    async (workSession: WorkSession) => {
      const request = workThreadRequestRef.current + 1;
      workThreadRequestRef.current = request;
      setOpeningWorkThreadId(workSession.id);
      setWorkThreadOpenError(null);

      try {
        let before: number | undefined;
        let root: Message | undefined;
        for (
          let pageIndex = 0;
          pageIndex < WORK_THREAD_ROOT_PAGE_LIMIT;
          pageIndex += 1
        ) {
          const page = await fetchMessages(
            workspaceId,
            workSession.channelId,
            before === undefined ? { limit: 200 } : { before, limit: 200 }
          );
          root = page.messages.find((message) =>
            uuidEq(message.id, workSession.rootMessageId)
          );
          if (
            root ||
            page.nextBefore === undefined ||
            page.nextBefore === before ||
            page.messages.length === 0 ||
            workThreadRequestRef.current !== request
          ) {
            break;
          }
          before = page.nextBefore;
        }
        if (workThreadRequestRef.current !== request) return;
        if (!root) {
          setWorkThreadOpenError(
            "세션 스레드의 시작 메시지를 찾지 못했습니다. 채널 기록을 새로고침한 뒤 다시 시도하세요."
          );
          return;
        }
        setPendingWorkThread({ channelId: workSession.channelId, root });
        if (!uuidEq(channelId ?? undefined, workSession.channelId)) {
          navigate(`/c/${workSession.channelId}`);
        }
      } catch {
        if (workThreadRequestRef.current === request) {
          setWorkThreadOpenError(
            "세션 스레드를 불러오지 못했습니다. 다시 시도하세요."
          );
        }
      } finally {
        if (workThreadRequestRef.current === request) {
          setOpeningWorkThreadId(null);
        }
      }
    },
    [workspaceId, channelId, navigate]
  );

  useEffect(() => {
    if (
      pendingWorkThread === null ||
      !uuidEq(channelId ?? undefined, pendingWorkThread.channelId)
    ) {
      return;
    }
    setThread(pendingWorkThread.root);
    setPendingWorkThread(null);
    setWorkOpen(false);
  }, [channelId, pendingWorkThread]);

  // ── URL이 데리고 온 자리 (MOMO-679) ────────────────────────────────────────
  //
  // 세 파라미터가 같은 성질이다: 다른 표면이 이 채널 안의 한 지점을 가리키며
  // 보낸 것. `?seq=`와 `?msg=`는 v1부터 링크에 실려 다녔지만 아무도 읽지
  // 않았다 — 점프는 인박스·활동 행의 onClick이 직접 워처를 돌려서만 일어났고,
  // 그래서 그 주소를 복사해 새 탭에 붙여넣으면 채널만 열렸다(PR 918 R1 Low가
  // `?msg=`에서 지적하고 `?seq=`도 같은 성질이라고 적어둔 그것). 둘은 같은
  // 성질이므로 한 곳에서 함께 읽는다. onClick 경로는 그대로 둔다: 같은 주소를
  // 두 번 누르면 파라미터가 바뀌지 않아 이 효과는 다시 돌지 않는다.
  //
  // `?work=`는 작업 흐름 상세의 실행 이력이 쓰는 새 열쇠다. 작업 세션은 라우트가
  // 아니라 이 채널 표면 안의 패널이라, 링크가 채널과 세션을 함께 말한다.
  const [searchParams, setSearchParams] = useSearchParams();
  const anchorWork = searchParams.get("work");
  const anchorMsg = searchParams.get("msg");
  const anchorSeq = searchParams.get("seq");

  useEffect(() => {
    if (anchorWork === null) return;
    openWorkSession(anchorWork);
    // 읽고 나면 주소에서 지운다. 패널의 열림/닫힘은 이 컴포넌트의 상태이므로,
    // 파라미터가 남으면 사람이 패널을 닫은 뒤에도 주소는 열려 있다고 말한다.
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("work");
        return next;
      },
      { replace: true }
    );
  }, [anchorWork, openWorkSession, setSearchParams]);

  // 워처는 행이 실제로 마운트된 뒤에만 찾을 것이 있다. 가상 목록이라 첫 페이지가
  // 도착하기 전에는 DOM에 행이 하나도 없고, 워처의 3초 창은 그 사이에 지나간다.
  const anchorReady = messages.length > 0;
  useEffect(() => {
    if (!anchorReady) return undefined;
    if (anchorMsg !== null) return watchForMessageId(anchorMsg);
    if (anchorSeq !== null) {
      const seq = Number(anchorSeq);
      if (Number.isFinite(seq)) return watchForMessage(seq);
    }
    return undefined;
  }, [anchorReady, anchorMsg, anchorSeq, channelId]);

  // Under 900px the 작업 세션 pane stops being a column beside the channel and
  // becomes a drawer over it (tokens.css `work-pane`: position absolute, inset
  // 0, z-index 20). A surface that is covered has to leave the tab order with
  // it. Without that, Tab walked straight through the drawer into controls that
  // were not on screen: from the sidebar it took three stops to reach
  // `composer-input`, buried under the drawer with elementFromPoint returning
  // the drawer at every one of them, and typing there filled a composer nobody
  // could see. `inert` is the platform's own answer (it removes focusability
  // AND hides the subtree from assistive tech), so it is what this uses, driven
  // from the same 900px breakpoint the stylesheet uses so the two cannot drift.
  const coveredRef = useRef<HTMLDivElement>(null);
  const [drawerWidth, setDrawerWidth] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(width < 900px)");
    const sync = () => setDrawerWidth(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const covered = workOpen && !thread && stressCount === 0 && drawerWidth;
  useEffect(() => {
    const node = coveredRef.current;
    if (!node) return;
    if (covered) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  }, [covered]);

  // The composer owns its own ref for the mention popover, so this reaches it
  // by the id it already publishes (its sr-only <label htmlFor> points at the
  // same one). Focus, not scroll or fake typing: the empty DM state's action is
  // "start writing", and writing happens in the composer that is already there.
  const focusComposer = useCallback(() => {
    const input = document.getElementById("composer-input");
    if (input instanceof HTMLTextAreaElement) input.focus();
  }, []);

  // Re-send a row the SERVER stored as `failed`. That message is durable and
  // will not change, so this is a genuinely new send with a fresh idempotency
  // key, not a retry of the old one: it goes through the same send path as the
  // composer and appears as a local echo until its own seq arrives. (The retry
  // on an unconfirmed echo is the opposite case and reuses its key; see
  // model.ts retryPending.)
  const timelineSend = timeline.send;
  const onResend = useCallback(
    (message: Message) => {
      if (channelId === null || !message.body) return;
      return timelineSend(message.body);
    },
    [channelId, timelineSend]
  );

  // Read-only probe for the browser gate runner (DOM stays the primary source
  // of truth; this just avoids scraping when convenient).
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__spike = {
      count: messages.length,
      newestSeq: timeline.state.newestSeq,
      oldestSeq: timeline.state.oldestSeq,
      connStatus,
      resume: timeline.resume,
      recoveryMarkers: timeline.recoveryMarkers.length,
      // Local echoes still awaiting a seq. A gate that sees this fall back to 0
      // has watched the optimistic row reconcile into the confirmed stream.
      pending: timeline.pending.length,
      stress: stressCount,
    };
  }, [
    messages.length,
    timeline.state,
    timeline.resume,
    timeline.recoveryMarkers,
    timeline.pending,
    connStatus,
    stressCount,
  ]);

  const memberSummary = useMemo(() => {
    // A DM's participants are the title and me. Repeating "데모 사용자, 김인턴"
    // beside a title that already says 김인턴 @intern-kim adds a second, less
    // precise copy of the same fact.
    if (!channel || channel.kind === "dm") return "";
    const ids = directory.members
      .filter((m) => m.channelIds.some((id) => uuidEq(id, channel.id)))
      .map((m) => m.id);
    const names = ids
      .map((id) => memberFor(directory, id)?.displayName)
      .filter((name): name is string => Boolean(name));
    if (names.length === 0) return "";
    if (names.length <= 3) return names.join(", ");
    return `${names.slice(0, 3).join(", ")} 외 ${names.length - 3}`;
  }, [channel, directory]);

  const offline = stressCount === 0 && isOffline;
  const hasChannel = stressCount > 0 || channelId !== null;

  const renderChannelHeader = (huddle: HuddleController | null) => (
    <>
      <header className="flex min-h-control-lg items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span aria-hidden="true" className="shrink-0 text-ink-muted">
            {channel?.kind === "dm" ? (
              <MessageSquare className="size-4" />
            ) : channel?.kind === "private" ? (
              <Lock className="size-4" />
            ) : (
              <Hash className="size-4" />
            )}
          </span>
          <h1
            className={cn(
              "min-w-0 truncate text-body font-semibold",
              labelParts?.isAgent && stressCount === 0 && "text-agent"
            )}
          >
            {stressCount > 0
              ? `스크롤 측정 (${stressCount})`
              : labelParts?.text ?? label}
          </h1>
          {stressCount === 0 && labelParts?.handle && (
            <span
              className="shrink-0 text-meta text-ink-muted"
              data-testid="channel-handle"
            >
              {labelParts.handle}
            </span>
          )}
          {memberSummary && (
            <span className="min-w-0 truncate text-meta text-ink-muted">
              {memberSummary}
            </span>
          )}
          <span className="sr-only" data-testid="message-count">
            메시지 {messages.length}개
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {timeline.resume.resubscribeCount > 0 && (
            <span
              className="text-timestamp text-ink-muted"
              data-numeric
              data-testid="resume-info"
            >
              재연결 {timeline.resume.resubscribeCount}회
            </span>
          )}
          {huddle && (
            <HuddleHeaderControl
              huddle={huddle}
              offline={offline}
            />
          )}
          {/* The tooltip and the accessible name are the same string: two
              names for one control is two controls to a reader who hears one
              and sees the other. */}
          {stressCount === 0 && (
            <button
              type="button"
              onClick={() => {
                setThread(null);
                setWorkOpen((open) => !open);
              }}
              aria-pressed={workOpen}
              aria-label="작업 세션 패널"
              title="작업 세션 패널"
              data-testid="open-work-panel"
              className={cn(
                "flex size-control-sm shrink-0 items-center justify-center rounded-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                workOpen
                  ? "bg-accent-soft text-accent"
                  : "text-ink-muted hover:bg-surface-hover"
              )}
            >
              <SquareTerminal className="size-4" />
            </button>
          )}
        </div>
      </header>
      {huddle && <HuddleHeaderBanner huddle={huddle} offline={offline} />}
    </>
  );

  // 빈 워크스페이스에서 가장 큰 행동. 이 버튼은 /settings로 보내는 막다른
  // 골목이었고 (설정에는 그런 폼이 없다), 이제 같은 자리에서 채널 만들기
  // 다이얼로그를 연다 (MOMO-614). 만들 수 없는 멤버에게는 버튼 대신 누가 만들 수
  // 있는지 말한다. 명부가 도착하기 전에는 아무 말도 하지 않는다: 늦게 오는
  // 버튼보다 왔다가 사라지는 버튼이 나쁘다 (R2 M5).
  const openCreateChannel = useOpenCreateChannel();
  const canCreate = canCreateChannelNow(
    !directoryQuery.isPending,
    memberFor(directory, session.member.id)?.role
  );

  return (
    // 프로바이더 캐스캐이드 전환 (ADR-0135 D1) is channel-scoped and read by both
    // the timeline and the thread panel, so the subscription lives once here
    // rather than in each row.
    <CascadeProvider
      realtime={stressCount > 0 ? null : realtime}
      workspaceId={workspaceId}
      channelId={stressCount > 0 ? null : channelId}
    >
    {/* `relative` is the anchor the 작업 세션 pane needs on a narrow window,
        where it stops being a column beside the channel and becomes a drawer
        over it (tokens.css `work-pane`). */}
    <div className="relative flex min-w-0 flex-1">
      <div ref={coveredRef} className="flex min-w-0 flex-1 flex-col">
        {stressCount === 0 && channelId !== null ? (
          <HuddleHeaderState
            workspaceId={workspaceId}
            channelId={channelId}
            realtime={realtime}
            offline={offline}
          >
            {(huddle) => renderChannelHeader(huddle)}
          </HuddleHeaderState>
        ) : (
          renderChannelHeader(null)
        )}

        {offline && (
          <InlineBanner
            tone="neutral"
            message="연결 끊김, 재연결 중입니다. 지금 보이는 내용은 마지막으로 확인된 상태입니다."
            testId="offline-banner"
          />
        )}

        <div className="min-h-0 flex-1">
          {hasChannel ? (
            <Timeline
              messages={messages}
              directory={directory}
              status={stressCount > 0 ? "ready" : timeline.status}
              lastReadSeq={openedWith?.lastReadSeq ?? null}
              unreadCount={openedWith?.unreadCount ?? 0}
              recoveryMarkers={timeline.recoveryMarkers}
              pending={stressCount > 0 ? undefined : timeline.pending}
              onStartReached={stressCount > 0 ? undefined : timeline.loadOlder}
              onRetry={timeline.reload}
              onOpenThread={(message) => {
                setWorkOpen(false);
                setThread(message);
              }}
              onOpenWorkSession={openWorkSession}
              onResend={stressCount > 0 ? undefined : onResend}
              onResendPending={stressCount > 0 ? undefined : timeline.resend}
              channelKind={channel?.kind}
              peer={peer}
              onInviteMember={() => navigate("/settings?section=members")}
              onStartWriting={focusComposer}
            />
          ) : channelsQuery.isLoading ? (
            <SkeletonRows rows={6} className="p-4" />
          ) : channelsQuery.error ? (
            <InlineBanner
              message="채널을 불러오지 못했습니다."
              actionLabel="다시 시도"
              onAction={() => void channelsQuery.refetch()}
              testId="chat-channels-error"
            />
          ) : canCreate ? (
            <EmptyInvite
              headline="아직 채널이 없습니다. 첫 채널을 만들어 팀을 시작하세요."
              actions={
                <Button
                  size="sm"
                  onClick={openCreateChannel}
                  data-testid="chat-create-channel"
                >
                  채널 만들기
                </Button>
              }
              testId="chat-no-channel"
            />
          ) : (
            <EmptyInvite
              headline="아직 채널이 없습니다."
              detail="채널은 워크스페이스 오너나 관리자가 만들 수 있습니다. 관리자에게 요청하세요."
              testId="chat-no-channel"
            />
          )}
        </div>

        {stressCount === 0 && channelId !== null && (
          <Composer
            channelId={channelId}
            directory={directory}
            channelLabel={label}
            onSend={timeline.send}
          />
        )}
      </div>

      {thread && channelId !== null && (
        <ThreadPanel
          workspaceId={workspaceId}
          channelId={channelId}
          root={thread}
          directory={directory}
          onOpenWorkSession={openWorkSession}
          onClose={() => setThread(null)}
        />
      )}

      {workOpen && !thread && stressCount === 0 && (
        <WorkPanel
          channelId={channelId}
          scope={workScope}
          onScopeChange={changeWorkScope}
          selectedId={workSessionId}
          onSelectedIdChange={setWorkSessionId}
          openingThreadId={openingWorkThreadId}
          threadOpenError={workThreadOpenError}
          onOpenThread={(workSession) => void openWorkSessionThread(workSession)}
          onClose={() => {
            // The panel hands the caret back to the toggle that opened it, and
            // that toggle lives in the surface this drawer just made `inert`.
            // React would not drop the attribute until the commit that unmounts
            // the panel, i.e. after that focus() call, so it comes off here
            // first. The effect above re-syncs and finds nothing to do.
            coveredRef.current?.removeAttribute("inert");
            workThreadRequestRef.current += 1;
            setOpeningWorkThreadId(null);
            setWorkThreadOpenError(null);
            setWorkOpen(false);
          }}
        />
      )}
    </div>
    </CascadeProvider>
  );
}

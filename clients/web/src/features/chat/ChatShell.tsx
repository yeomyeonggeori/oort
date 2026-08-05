import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Hash, Lock, MessageSquare, SquareTerminal } from "lucide-react";
import {
  fetchMessages,
  updateReadState,
  uuidEq,
  type Message,
  type WorkSession,
} from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { useIsMobileShell } from "@/app/shellNav";
import {
  channelLabel,
  channelLabelParts,
  dmAutoReplyAgent,
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
import {
  quoteDraftFor,
  quoteDraftStillValid,
  type QuoteDraft,
} from "@momo/core/features/timeline/quote";
import { Timeline } from "@/features/timeline/Timeline";
import { CascadeProvider } from "@/features/timeline/cascadeRail";
import { ThreadPanel } from "@/features/timeline/ThreadPanel";
import { LongPressHint } from "@/features/timeline/LongPressHint";
import { WorkPanel } from "@/features/work/WorkPanel";
import { useWorkPanelTarget } from "@/features/agents/workLogStore";
import type { WorkScope } from "@momo/core/features/work/workSessionModel";
import { useTimeline } from "@/features/timeline/useTimeline";
import { useTypingReceive } from "@/features/chat/useTyping";
import {
  makeStressRoster,
  makeSyntheticMessages,
} from "@momo/core/features/timeline/stress";
import { Composer } from "@/features/chat/Composer";
import { canCreateChannelNow } from "@momo/core/features/channels/model";
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
  // goal B13 (QA H7): 이 채널이 멘션 없이도 답하는 방인가. `peer`와 따로 묻는다
  // — `peer`는 "상대가 누구냐"이고 이쪽은 "서버가 자동으로 부르느냐"라서, 그룹
  // DM이나 사람끼리의 DM에서 둘의 답이 갈린다.
  const dmAgent = channel
    ? dmAutoReplyAgent(channel, directory, session.member.id)
    : null;

  const timeline = useTimeline(
    realtime,
    workspaceId,
    stressCount > 0 ? null : channelId,
    session.member.id
  );
  const messages = stressCount > 0 ? stressMessages : timeline.state.messages;

  // 「작성 중」 수신 (ADR-0149). **보이는 채널만** 구독한다 - 그것이 이 레일의 유일한
  // 폭 제어다. 스트레스 픽스처에는 서버가 없으므로 걸지 않는다.
  useTypingReceive(
    stressCount > 0 ? null : realtime,
    workspaceId,
    stressCount > 0 ? null : channelId
  );

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
  //
  // goal B8 H10: the failure branch used to keep `markedRef` pointing at the
  // seq whose PUT had just failed, so this effect refused to try that seq
  // again. One dropped request and the channel you are reading kept its unread
  // badge until a LATER message happened to arrive. Clearing the mark on
  // failure is what makes the retry the comment already promised real: the next
  // run of this effect (a new message, a remount, a channel round trip) sends
  // it again.
  const newestSeq = timeline.state.newestSeq;
  useEffect(() => {
    if (stressCount > 0 || newestSeq === null || channelId === null) return;
    const key = `${channelId}:${newestSeq}`;
    if (markedRef.current === key) return;
    markedRef.current = key;
    updateReadState(workspaceId, channelId, newestSeq)
      .then(() => invalidateReadStates())
      .catch(() => {
        if (markedRef.current === key) markedRef.current = null;
      });
  }, [workspaceId, channelId, newestSeq, stressCount, invalidateReadStates]);

  const [thread, setThread] = useState<Message | null>(null);
  useEffect(() => setThread(null), [channelId]);

  // ── 걸어 둔 인용 (ADR-0148) ────────────────────────────────────────────────
  //
  // `thread`와 같은 자리에 산다. 둘 다 「이 표면이 지금 무엇을 가리키고 있나」이고,
  // 둘 다 채널을 옮기면 뜻을 잃는다. 컴포저 안에 두지 않는 이유는 컴포저가
  // 마운트/언마운트되기 때문이다 — 스레드를 열었다 닫는 사이에 걸어 둔 인용이
  // 사라지면, 사람은 자기가 무엇을 눌렀는지 의심하게 된다.
  const [quote, setQuote] = useState<QuoteDraft | null>(null);
  useEffect(() => setQuote(null), [channelId]);

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

  // 걸어 둔 원본이 지워졌다. 인용은 서버가 받아 주지만(같은 채널이면 tombstone도
  // 유효한 대상이다) 그렇게 보낸 글은 태어날 때부터 「삭제된 메시지」를 가리킨다.
  // 조용히 떼는 것이 맞다: 걸어 둔 사람은 그 삭제를 이미 화면에서 봤다.
  useEffect(() => {
    if (quote === null) return;
    const lookup = (messageId: string) =>
      messages.find((message) => uuidEq(message.id, messageId));
    if (!quoteDraftStillValid(quote, lookup)) setQuote(null);
  }, [quote, messages]);

  const onQuoteMessage = useCallback((message: Message) => {
    setQuote(quoteDraftFor(message));
    // 인용을 건 사람의 다음 동작은 100% 글쓰기다. 캐럿을 옮겨 주지 않으면 칩이
    // 떴는데 손은 아직 타임라인에 있다.
    const input = document.getElementById("composer-input");
    if (input instanceof HTMLTextAreaElement) input.focus();
  }, []);

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

  // 앵커를 끝내 못 찾았다 (goal B12 R1 High-3).
  //
  // 예전에는 이 실패가 아무 자국도 남기지 않았다. 인박스에서는 대개 맞는
  // 절충이었지만 검색에서는 가정이 뒤집힌다: 검색은 정의상 로드된 머리에 없는
  // 것을 찾아 주는 표면이라, 사용자는 방금 화면에서 읽은 문장을 누르고 전혀
  // 다른 메시지가 있는 채널 바닥에 도착한다. 표식도, 문장도, 재시도도 없이.
  //
  // 백필까지 가지 않고 **신호**로 갚는다. 다만 신호는 참이어야 하므로, 무슨 일이
  // 일어났는지 아는 만큼만 말한다.
  const [anchorMissed, setAnchorMissed] = useState<"older" | "unknown" | null>(null);

  // 주소가 가리키는 자리가 바뀌면 앞선 실패는 이 화면의 사실이 아니다.
  useEffect(() => {
    setAnchorMissed(null);
  }, [anchorMsg, anchorSeq, channelId]);

  /**
   * 인용 블록을 눌렀다 → 원본으로 점프 (ADR-0148 · goal B3 W1).
   *
   * **기존 앵커 기계 그대로**다. 새 메커니즘을 만들지 않는 이유는 이 자리가 이미
   * 인박스·활동·검색·작업흐름이 쓰는 그 자리이기 때문이고, 못 찾았을 때 할 말도
   * 이미 위에 있다(`anchorMissed`). 라우트를 건드리지 않는 이유는 인용 대상이 같은
   * 채널 안에 있어야 하기 때문이다(규칙 2) — `?msg=`로 우회하면 주소가 「여기를
   * 보고 있다」고 계속 말하는데 사람은 이미 다른 곳을 읽고 있게 된다.
   *
   * `seq`를 함께 받는 이유: 못 찾았을 때 「더 위쪽에 있어 아직 안 불러왔다」를
   * 추측이 아니라 사실로 말할 수 있다. 서버가 인용에 원본의 seq를 실어 준다
   * (`replyTo.seq`), 라이브 프레임으로 온 인용은 실어 주지 않으므로 null이 온다.
   */
  const quoteJumpRef = useRef<(() => void) | null>(null);
  const onJumpToMessage = useCallback(
    (messageId: string, seq: number | null) => {
      // 앞선 점프가 아직 행을 기다리고 있으면 접는다. 두 워처가 동시에 돌면 나중에
      // 만료되는 쪽이 이미 도착한 점프에 대해 「못 찾았다」를 띄운다.
      quoteJumpRef.current?.();
      setAnchorMissed(null);
      quoteJumpRef.current = watchForMessageId(messageId, {
        onExpire: () => {
          if (seq === null) {
            setAnchorMissed("unknown");
            return;
          }
          const oldestLoaded = messages.reduce(
            (min, message) => Math.min(min, message.seq),
            Number.POSITIVE_INFINITY
          );
          setAnchorMissed(seq < oldestLoaded ? "older" : "unknown");
        },
      });
    },
    [messages]
  );
  useEffect(() => () => quoteJumpRef.current?.(), []);

  useEffect(() => {
    if (!anchorReady) return undefined;

    /**
     * 목표가 지금 로드된 창보다 **위쪽**인가. seq는 채널의 순서값이므로, 목표가
     * 가장 오래된 로드분보다 작으면 그것은 추측이 아니라 사실이다. seq를 모르면
     * (`?seq=` 없이 온 링크) 모른다고 답하고, 화면도 모르는 채로 말한다.
     */
    const missKind = (): "older" | "unknown" => {
      const target = anchorSeq === null ? Number.NaN : Number(anchorSeq);
      if (!Number.isFinite(target)) return "unknown";
      const oldestLoaded = messages.reduce(
        (min, message) => Math.min(min, message.seq),
        Number.POSITIVE_INFINITY
      );
      return target < oldestLoaded ? "older" : "unknown";
    };
    const onExpire = () => setAnchorMissed(missKind());

    if (anchorMsg !== null) return watchForMessageId(anchorMsg, { onExpire });
    if (anchorSeq !== null) {
      const seq = Number(anchorSeq);
      if (Number.isFinite(seq)) return watchForMessage(seq, { onExpire });
    }
    return undefined;
    // `messages`는 의도적으로 빼 둔다: 새 메시지가 도착할 때마다 워처를 다시
    // 돌리면 3초 창이 영원히 갱신된다. 만료 시점의 창은 `missKind`가 클로저로
    // 잡은 그 목록이면 충분하다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // 폰에서는 스레드 패널도 같은 성질이 된다 (goal B6): 320px 열이 390px 화면에서
  // 채널에 70px만 남기므로, 그 폭에서는 스레드가 채널 표면 전체를 받는다
  // (tokens.css `thread-pane`). 덮은 표면은 위와 같은 이유로 탭 순서에서 빠진다.
  const isMobile = useIsMobileShell();
  // 「작업 패널」(goal WEB-WP1)은 이 표면 **바깥**, 셸의 라우트 상자 옆에 산다.
  // 그래서 이 파일이 이미 지키던 "부차 표면은 한 번에 하나" 규칙의 사각지대에
  // 있었다: 사이드바 240 + 스레드 320 + 작업 패널 320 = 880이라, 900px 창에서
  // 채팅에 20px가 남는다. 산술이 아니라 실렌더로 쟀고 컴포저가 26px였다
  // (gate-work-panel의 co-open-900 시나리오).
  //
  // 그래서 규칙을 그대로 한 칸 넓힌다. 스레드가 작업 세션 패널을 가리고 있다가
  // 닫히면 되돌아오는 것과 **같은 방식으로**(닫는 것이 아니라 가리는 것이다),
  // 작업 패널이 열려 있는 동안은 이 표면의 부차 패널이 물러난다. 상태는 그대로
  // 남아 있으므로 작업 패널을 닫으면 읽던 스레드가 그 자리에 돌아온다.
  const workPanelOpen = useWorkPanelTarget() !== null;
  const covered =
    !workPanelOpen &&
    ((workOpen && !thread && stressCount === 0 && drawerWidth) ||
      (thread !== null && channelId !== null && isMobile));
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
          {/* 폰에서 채널 목록으로 돌아가는 길 (goal B6). 사이드바가 열이 아니라
              서랍이므로, 목록은 이 컨트롤로만 다시 열린다. */}
          <SidebarDrawerToggle />
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
            /* 폰에서는 접는다 (goal B6): 390px 헤더에서 이 요약이 제목보다 먼저
               폭을 가져가 채널 이름이 두 글자로 줄었다. 같은 사실은 멤버 목록에
               온전히 있다. */
            <span className="wide-only min-w-0 truncate text-meta text-ink-muted">
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

        {/* 연결 배너는 셸로 올라갔다 (goal B8 B2, AppShell.ConnectionBanner):
            같은 사실을 채널에서만 말하면 인박스·활동·설정에서는 갱신이 멈춘 줄
            모른 채 조용한 화면을 읽게 된다. `offline`은 여전히 여기 남는다 —
            허들 컨트롤처럼 지금 쓸 수 있는지를 물어야 하는 것들이 읽는다. */}

        {/* 가리켜진 메시지를 끝내 못 찾았다 (goal B12 R1 High-3).
            tone="neutral": 고장이 아니라 아직 안 불러온 것이라 --danger도
            role="alert"도 맞지 않는다. 닫기가 있는 이유는 이 줄이 사람의 다음
            행동을 막지 않아야 하기 때문이다. */}
        {anchorMissed !== null && (
          <InlineBanner
            tone="neutral"
            message={
              anchorMissed === "older"
                ? "찾던 메시지는 이 대화의 더 위쪽에 있어 아직 불러오지 않았습니다. 위로 올려 이어서 불러오세요."
                : "찾던 메시지를 이 화면에서 찾지 못했습니다. 위로 올려 이전 대화를 더 불러오세요."
            }
            actionLabel="닫기"
            onAction={() => setAnchorMissed(null)}
            testId="chat-anchor-missed"
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
              // B11 — the stress fixture renders synthetic rows with no server
              // row behind them, so the actions are withheld there rather than
              // offered and then failing on every click.
              reactions={stressCount > 0 ? undefined : timeline.reactions}
              actions={
                stressCount > 0
                  ? undefined
                  : {
                      myMemberId: session.member.id,
                      onToggleReaction: timeline.toggleReaction,
                      onEditMessage: timeline.editMessage,
                      onDeleteMessage: timeline.deleteMessage,
                    }
              }
              onStartReached={stressCount > 0 ? undefined : timeline.loadOlder}
              onRetry={timeline.reload}
              onOpenThread={(message) => {
                setWorkOpen(false);
                setThread(message);
              }}
              onQuoteMessage={stressCount > 0 ? undefined : onQuoteMessage}
              onJumpToMessage={onJumpToMessage}
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

        {/* 폰에는 액션이 있다는 것을 말해 주는 것이 화면에 하나도 없었다
            (R2 H4). 손가락 기기에서만, 한 번만, 컴포저 바로 위에서. */}
        {stressCount === 0 && channelId !== null && <LongPressHint />}
        {stressCount === 0 && channelId !== null && (
          <Composer
            workspaceId={workspaceId}
            channelId={channelId}
            directory={directory}
            channelLabel={label}
            dmAgent={dmAgent}
            quote={quote}
            onCancelQuote={() => setQuote(null)}
            onSend={timeline.send}
          />
        )}
      </div>

      {thread && channelId !== null && !workPanelOpen && (
        <ThreadPanel
          workspaceId={workspaceId}
          channelId={channelId}
          root={thread}
          directory={directory}
          reactions={timeline.reactions}
          actions={{
            myMemberId: session.member.id,
            onToggleReaction: timeline.toggleReaction,
            onEditMessage: timeline.editMessage,
            onDeleteMessage: timeline.deleteMessage,
          }}
          onOpenWorkSession={openWorkSession}
          onClose={() => setThread(null)}
        />
      )}

      {workOpen && !thread && stressCount === 0 && !workPanelOpen && (
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

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
import {
  anchorMissKind,
  oldestLoadedSeq,
  watchForMessage,
  watchForMessageId,
} from "@/features/inbox/anchor";
import {
  quoteDraftFor,
  quoteDraftStillValid,
  type QuoteDraft,
} from "@momo/core/features/timeline/quote";
import { Timeline, type TimelineJump } from "@/features/timeline/Timeline";
import { PinListMenu } from "@/features/timeline/PinListMenu";
import { ChannelHeaderMenu } from "@/features/chat/ChannelHeaderMenu";
import { CascadeProvider } from "@/features/timeline/cascadeRail";
import { ThreadPanel } from "@/features/timeline/ThreadPanel";
import { LongPressHint } from "@/features/timeline/LongPressHint";
import { WorkPanel } from "@/features/work/WorkPanel";
import type { OpenWorkSession } from "@/features/work/openWorkSession";
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
import { useOpenAddChannelMember } from "@/features/channels/useAddChannelMember";
import {
  ChannelMemberPanel,
  ChannelTopicControl,
  type ChannelMemberListStatus,
} from "@/features/channels/ChannelContextControls";
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
import { FirstMentionOnboarding } from "@/features/hostedAgents/FirstMentionOnboarding";
import { useOpenMemberProfile } from "@/features/directory/memberProfileContext";

// =============================================================================
// Channel surface (R-1 §3): header, offline banner, timeline, composer, thread
// panel. The realtime rail and the sidebar live in the shell above, so moving
// between channels never drops the connection.
// =============================================================================

// A missing/deleted root must not turn one click into an unbounded walk through
// channel history. Twenty-five full pages still cover 5,000 messages; after
// that the existing not-found result is the honest answer this client has.
const WORK_THREAD_ROOT_PAGE_LIMIT = 25;

// 서랍이 채널 표면 **옆 열**에서 표면 **위 오버레이**로 바뀌는 문턱 (#1421). 이
// 값은 tokens.css의 `work-pane`/`thread-pane`가 절대 배치로 넘어가는 폭과 **같아야**
// 한다 — 스타일시트가 덮개로 만든 폭과 스크립트가 탭 순서에서 빼는(`inert`) 폭이
// 어긋나면 화면에 없는 컨트롤로 Tab이 걸어 들어간다. 한 곳에만 적어 다음 사람이
// 한쪽만 옮기지 못하게 한다 (#1421 N1).
const DRAWER_OVERLAY_QUERY = "(width < 900px)";

export function ChatShell() {
  const { session, workspaceId, realtime, connStatus } = useSession();
  const isOffline = useOffline();
  const params = useParams();
  const navigate = useNavigate();
  const openMemberProfile = useOpenMemberProfile();

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

  /**
   * 직접 조작 동선을 달고 온 딥링크인가 (LIVE-5b).
   *
   * 세션 id 와 함께 들고 다니는 이유는 이것이 **그 세션에 대한** 의도이기
   * 때문이다. 사람이 패널 안에서 다른 세션으로 옮겨 가면 이 의도는 따라가지
   * 않아야 하고, 세션 id 옆에 붙어 있으면 그 규칙을 따로 적을 필요가 없다.
   */
  const [workControlIntent, setWorkControlIntent] = useState<string | null>(
    null
  );

  const openWorkSession = useCallback<OpenWorkSession>(
    (sessionId, intent) => {
      setThread(null);
      setWorkScope("channel");
      setWorkSessionId(sessionId);
      setWorkControlIntent(intent?.control === true ? sessionId : null);
      setWorkOpen(true);
    },
    []
  );

  // A scope chip means "show me that list". The panel keeps its selected
  // session across close/reopen (returning to where you were), so while a
  // detail is open the chips would otherwise change state with no visible
  // effect — a live-looking control that does nothing. Clearing the selection
  // makes the chip's promise and the screen agree.
  const changeWorkScope = useCallback((scope: WorkScope) => {
    setWorkSessionId(null);
    setWorkControlIntent(null);
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
  const anchorFirstMention = searchParams.get("firstMention");

  // `?control=1`은 `?work=`의 부사다 — 혼자서는 아무 데도 가리키지 않는다
  // (LIVE-5b). 도착지에서 확인 단계를 무장할 뿐 창을 열지 않으므로, 주소를
  // 복사해 붙여넣은 사람이 그 한 번으로 남의 에이전트를 멈추는 일은 없다.
  const anchorControl = searchParams.get("control");

  // 위저드 「채널 열고 테스트 멘션」이 싣는 힌트. 읽고 나면 지운다 — 주소에
  // 남으면 새로고침마다 초대 직후인 것처럼 다시 무장한다. 왕복 판정 자체는
  // 채널 메시지가 하므로, 힌트는 목록이 늦을 때의 뱃지/로딩용이다.
  // 채널에 키잉한다: A 채널에서 무장한 힌트가 B 채널 타임라인에 따라가면 안 된다.
  const [firstMentionHints, setFirstMentionHints] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    if (anchorFirstMention === null || anchorFirstMention.trim() === "") return;
    if (channelId === null) return;
    const hinted = anchorFirstMention.trim();
    setFirstMentionHints((current) => ({
      ...current,
      [channelId.toLowerCase()]: hinted,
    }));
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("firstMention");
        return next;
      },
      { replace: true }
    );
  }, [anchorFirstMention, channelId, setSearchParams]);

  useEffect(() => {
    if (anchorWork === null) return;
    openWorkSession(
      anchorWork,
      anchorControl === "1" ? { control: true } : undefined
    );
    // 읽고 나면 주소에서 지운다. 패널의 열림/닫힘은 이 컴포넌트의 상태이므로,
    // 파라미터가 남으면 사람이 패널을 닫은 뒤에도 주소는 열려 있다고 말한다.
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("work");
        next.delete("control");
        return next;
      },
      { replace: true }
    );
  }, [anchorControl, anchorWork, openWorkSession, setSearchParams]);

  /**
   * 주소가 가리킨 자리를 **읽고 나면 지운다** (리뷰 B2, #1193).
   *
   * `?work=` 는 이미 그렇게 한다(바로 위). `?msg=`/`?seq=` 만 남아 있었고, 그
   * 결과 같은 「대화로」를 두 번 누르면 두 번째 주소가 첫 번째와 **글자 단위로
   * 같아** 아래 효과가 다시 돌지 않았다 — 서랍은 닫히고 아무 일도 일어나지
   * 않는다. 리뷰 실측: `1st press -> seq 4102` / `2nd press -> seq null`.
   *
   * 지우는 것은 「패널을 닫은 뒤에도 주소는 열려 있다고 말한다」와 같은 이유이기도
   * 하다: 착지한 뒤 아래로 읽어 내려가면 주소는 여전히 「여기를 보고 있다」고
   * 말한다.
   *
   * 그래서 파라미터를 **상태로 옮겨 받는다.** 효과 안에서 지우면 그 삭제가 같은
   * 효과를 다시 돌려 방금 건 워처를 자기 정리 함수로 취소한다. 토큰은 「같은 곳을
   * 두 번 가리켰다」를 두 번의 요청으로 만드는 자리이고, 폰의 `jumpTarget` 이
   * 같은 이유로 같은 값을 든다.
   */
  const [urlAnchor, setUrlAnchor] = useState<{
    msg: string | null;
    seq: string | null;
    token: number;
  } | null>(null);
  useEffect(() => {
    if (anchorMsg === null && anchorSeq === null) return;
    setUrlAnchor((previous) => ({
      msg: anchorMsg,
      seq: anchorSeq,
      token: (previous?.token ?? 0) + 1,
    }));
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("msg");
        next.delete("seq");
        return next;
      },
      { replace: true }
    );
  }, [anchorMsg, anchorSeq, setSearchParams]);
  // 방을 옮기면 앞선 주소가 가리키던 자리는 이 화면의 사실이 아니다.
  useEffect(() => setUrlAnchor(null), [channelId]);

  // 워처는 행이 실제로 마운트된 뒤에만 찾을 것이 있다. 가상 목록이라 첫 페이지가
  // 도착하기 전에는 DOM에 행이 하나도 없고, 워처의 3초 창은 그 사이에 지나간다.
  const anchorReady = messages.length > 0;

  /**
   * 목록에게 「이 줄을 존재하게 하라」고 시키는 손잡이 (리뷰 B1).
   *
   * 워처 혼자서는 **가상 창 밖의 행**을 영원히 기다린다. 그 행은 로드돼 있는데도
   * DOM 에 없기 때문이고, 그 침묵은 화면에서 「위로 올려 더 불러오세요」라는
   * 거짓 지시가 된다. 목록만 아는 것(무엇이 로드돼 있나)을 목록에게 묻고, 답이
   * 「없다」일 때만 그 문장을 말한다.
   */
  const timelineJump = useRef<TimelineJump | null>(null);

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
  }, [urlAnchor?.token, channelId]);

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
      const missKind = (): "older" | "unknown" =>
        anchorMissKind(seq, oldestLoadedSeq(messages));
      // 목록에게 먼저 묻는다 (리뷰 B1). 「없다」면 기다릴 것이 없으므로 3초를
      // 흘려보내지 않고 그 자리에서 사실을 말한다.
      if (timelineJump.current?.bringIntoView({ messageId }) === false) {
        setAnchorMissed(missKind());
        return;
      }
      quoteJumpRef.current = watchForMessageId(messageId, {
        onExpire: () => setAnchorMissed(missKind()),
      });
    },
    [messages]
  );
  useEffect(() => () => quoteJumpRef.current?.(), []);

  useEffect(() => {
    if (!anchorReady || urlAnchor === null) return undefined;
    const { msg, seq: rawSeq } = urlAnchor;

    /**
     * 목표가 지금 로드된 창보다 **위쪽**인가. seq는 채널의 순서값이므로, 목표가
     * 가장 오래된 로드분보다 작으면 그것은 추측이 아니라 사실이다. seq를 모르면
     * (`?seq=` 없이 온 링크) 모른다고 답하고, 화면도 모르는 채로 말한다.
     */
    const missKind = (): "older" | "unknown" =>
      anchorMissKind(
        rawSeq === null ? null : Number(rawSeq),
        oldestLoadedSeq(messages)
      );
    const onExpire = () => setAnchorMissed(missKind());

    // 목록에게 먼저 묻는다 (리뷰 B1). 가상 창 밖의 행은 로드돼 있어도 DOM 에
    // 없으므로, 워처만 돌리면 「이미 들고 있는 줄」에 대고 「더 불러오세요」라고
    // 말하게 된다. 여기서 답이 갈린다: 옮겨 놓았거나, 정말로 없거나.
    if (msg !== null) {
      if (timelineJump.current?.bringIntoView({ messageId: msg }) === false) {
        setAnchorMissed(missKind());
        return undefined;
      }
      return watchForMessageId(msg, { onExpire });
    }
    if (rawSeq !== null) {
      const seq = Number(rawSeq);
      if (!Number.isFinite(seq)) return undefined;
      if (timelineJump.current?.bringIntoView({ seq }) === false) {
        setAnchorMissed(missKind());
        return undefined;
      }
      return watchForMessage(seq, { onExpire });
    }
    return undefined;
    // `messages`는 의도적으로 빼 둔다: 새 메시지가 도착할 때마다 워처를 다시
    // 돌리면 3초 창이 영원히 갱신된다. 만료 시점의 창은 `missKind`가 클로저로
    // 잡은 그 목록이면 충분하다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorReady, urlAnchor, channelId]);

  // Under 900px the two panes that share this row — the 작업 세션 pane and the
  // 스레드 패널 — stop being a column beside the channel and become a drawer over
  // it (tokens.css `work-pane` / `thread-pane`: position absolute, inset
  // 0, z-index 20). A surface that is covered has to leave the tab order with
  // it. Without that, Tab walked straight through the drawer into controls that
  // were not on screen: from the sidebar it took three stops to reach
  // `composer-input`, buried under the drawer with elementFromPoint returning
  // the drawer at every one of them, and typing there filled a composer nobody
  // could see. `inert` is the platform's own answer (it removes focusability
  // AND hides the subtree from assistive tech), so it is what this uses, driven
  // from the same 900px breakpoint the stylesheet uses so the two cannot drift.
  const coveredRef = useRef<HTMLDivElement>(null);
  // 첫 렌더에서 이미 답을 알고 시작한다 (`useIsMobileShell`과 같은 이유): `false`로
  // 시작해 효과에서 고치면 서랍이 이미 표면을 덮은 한 프레임 동안 덮인 컨트롤이
  // 탭 순서에 남는다. 그 한 프레임이 바로 이 장치가 막으려는 것이다.
  const [drawerWidth, setDrawerWidth] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(DRAWER_OVERLAY_QUERY).matches
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(DRAWER_OVERLAY_QUERY);
    const sync = () => setDrawerWidth(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
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
  // 스레드 패널도 같은 문턱에서 같은 성질이 된다 (#1421). 앞 판은 이 절만 폰
  // 문턱(`useIsMobileShell`, 600px)을 읽었고, 그래서 600~899px에서 스레드는 채널
  // 옆에 320px 열로 서서 컴포저를 36px(700px 창)까지 밀었다. tokens.css
  // `thread-pane`이 그 문턱을 work-pane과 같은 900px로 옮겼으므로 여기도 같은 값을
  // 읽는다 — 스타일시트가 덮개로 만든 폭과 스크립트가 탭 순서에서 빼는 폭이
  // 어긋나면, 화면에 없는 컨트롤로 Tab이 걸어 들어간다.
  //
  // `drawerWidth`가 두 절 **밖**에 있는 것이 그 사실의 모양이다: 무엇이 덮느냐는
  // 절마다 다르지만 덮는 폭은 하나다. 절 안에 두 번 적으면 다음 사람이 한쪽만
  // 옮길 수 있고, 그것이 이 티켓이 고친 결함이다.
  const covered =
    !workPanelOpen &&
    drawerWidth &&
    ((workOpen && !thread && stressCount === 0) ||
      (thread !== null && channelId !== null));
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

  // 검수 피드백 #3 ①과 #1680: 인원수와 목록은 같은 배열에서 나온다. 둘을 따로
  // 필터링하면 헤더가 「3명」이라고 말하는 동안 패널에는 2행이 서는 드리프트가
  // 생긴다. 서버 count 필드가 없으므로 roster의 channelIds를 한 번만 읽고,
  // 사람·에이전트를 함께 센다. DM은 상대가 제목에 이미 있으므로 이 패널을 내지
  // 않는다.
  const channelMembers = useMemo(() => {
    if (!channel || channel.kind === "dm") return [];
    return directory.members.filter((member) =>
      member.channelIds.some((id) => uuidEq(id, channel.id))
    );
  }, [channel, directory]);
  const channelMemberListStatus: ChannelMemberListStatus = directoryQuery.isFetching
    ? "loading"
    : directoryQuery.error !== null
      ? "failed"
      : "ready";

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
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              {/* 검수 피드백 #3 ②: 채널 이름을 누르면 채널을 다루는 메뉴가 선다.
                  진짜 채널(공개/비공개)에서만 — DM은 이름을 바꾸거나 나갈 대상이
                  아니고, 스트레스 픽스처는 뒤에 서버 행이 없다. h1은 그대로 제목의
                  지표(landmark)로 남고, 트리거 버튼이 그 안에 산다. DM 헤더의 이름은
                  상대 프로필 카드를 여는 트리거다(#1679). */}
              {stressCount === 0 && channel && channel.kind !== "dm" ? (
                <h1 className="flex min-w-0 items-center text-body font-semibold">
                  <ChannelHeaderMenu
                    workspaceId={workspaceId}
                    channel={channel}
                    title={labelParts?.text ?? label}
                    selfMemberId={session.member.id}
                    selfRole={memberFor(directory, session.member.id)?.role}
                  />
                </h1>
              ) : stressCount === 0 && channel?.kind === "dm" && peer ? (
                <h1 className="flex min-w-0 items-center text-body font-semibold">
                  <button
                    type="button"
                    data-testid="dm-profile-trigger"
                    aria-label={`${label} 프로필 열기`}
                    onClick={(event) =>
                      openMemberProfile(peer.id, event.currentTarget)
                    }
                    className={cn(
                      "min-w-0 truncate rounded-sm hover:text-ink focus-visible:focus-ring",
                      labelParts?.isAgent ? "text-agent" : "text-ink"
                    )}
                  >
                    {labelParts?.text ?? label}
                  </button>
                </h1>
              ) : (
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
              )}
              {stressCount === 0 && labelParts?.handle && (
                <span
                  className="shrink-0 text-meta text-ink-muted"
                  data-testid="channel-handle"
                >
                  {labelParts.handle}
                </span>
              )}
            </div>
            {stressCount === 0 && channel && channel.kind !== "dm" && (
              <ChannelTopicControl topic={channel.topic} />
            )}
          </div>
          <span className="sr-only" data-testid="message-count">
            메시지 {messages.length}개
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {stressCount === 0 && channel && channel.kind !== "dm" && (
            <ChannelMemberPanel
              channelName={channel.name ?? label}
              members={channelMembers}
              status={channelMemberListStatus}
              offline={offline}
              onRetry={() => void directoryQuery.refetch()}
              onAddMember={() =>
                openAddMember({ id: channel.id, name: channel.name ?? label })
              }
            />
          )}
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
          {/* 이슈 #1112 — 고정 목록. 작업 세션 토글 왼쪽에 두는 이유: 이것은
              대화를 읽는 도구고 저것은 대화 밖의 일을 여는 문이다. 스트레스
              픽스처에서는 뒤에 서버 행이 없으므로 내놓지 않는다 — 반응·액션과
              같은 규칙. */}
          {stressCount === 0 && channelId !== null && (
            <PinListMenu
              pins={timeline.pins}
              status={timeline.pinsStatus}
              directory={directory}
              onJump={(messageId, seq) => onJumpToMessage(messageId, seq)}
              onRetry={timeline.reloadPins}
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
                "flex size-control-sm shrink-0 items-center justify-center rounded-sm transition-colors focus-visible:focus-ring",
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
  // 빈 채널의 멤버 추가(옛 이름 "멤버 초대하기")는 /settings의 워크스페이스
  // 초대 링크 생성기로 보내던 막다른 길이었다(검수 #2). 이제 같은 자리에서 이
  // 채널에 워크스페이스 멤버를 넣는 다이얼로그를 열고, 이름도 그 다이얼로그의
  // 동사(추가)를 따른다(#1573). 워크스페이스 초대(새 사람 부르기)는 별개라
  // 설정에 그대로 있다.
  const openAddMember = useOpenAddChannelMember();
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
      {/* `chat-region`은 `min-w-0`을 대신한다(tokens.css): 이 열은 위쪽 상한
          (긴 코드 블록에 밀리지 않는다)과 아래쪽 바닥(옆에 선 pane이 컴포저를
          바닥 아래로 밀지 못한다, #1418)이 함께 필요하고, 같은 축을 두 곳에서
          적으면 순서가 이긴다. 라우트 상자의 `route-region`(#1413)과 같은
          장치이고, 그쪽이 못 보던 판(pane이 이 상자 **안쪽**에 설 때)을 든다. */}
      <div ref={coveredRef} className="chat-region flex flex-1 flex-col">
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

        {stressCount === 0 && channelId !== null && (
          <FirstMentionOnboarding
            workspaceId={workspaceId}
            channelId={channelId}
            members={directory.members}
            selfMemberId={session.member.id}
            selfKind={session.member.kind}
            selfRole={memberFor(directory, session.member.id)?.role}
            rosterSettled={!directoryQuery.isPending}
            messages={messages}
            pending={timeline.pending}
            messagesStatus={timeline.status}
            hintedAgentMemberId={
              firstMentionHints[channelId.toLowerCase()] ?? null
            }
            onRetryMessages={timeline.reload}
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
              pins={stressCount > 0 ? undefined : timeline.pins}
              unfurls={stressCount > 0 ? undefined : timeline.unfurls}
              actions={
                stressCount > 0
                  ? undefined
                  : {
                      myMemberId: session.member.id,
                      onToggleReaction: timeline.toggleReaction,
                      onTogglePin: timeline.togglePin,
                      onEditMessage: timeline.editMessage,
                      onDeleteMessage: timeline.deleteMessage,
                      onRemoveUnfurls: timeline.removeUnfurls,
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
              jumpHandleRef={timelineJump}
              onOpenWorkSession={openWorkSession}
              onResend={stressCount > 0 ? undefined : onResend}
              onResendPending={stressCount > 0 ? undefined : timeline.resend}
              channelKind={channel?.kind}
              peer={peer}
              onAddMember={() => {
                if (channelId && channel)
                  openAddMember({ id: channelId, name: channel.name ?? label });
              }}
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
            // 조사를 정하는 사실 (#1384): DM 의 label 은 방 이름이 아니라 상대
            // 이름이라 「hermes에」가 아니라 「hermes에게」여야 한다. `peer` 로
            // 묻는 이유는 로스터가 아직 안 온 DM 의 label 이 사람 이름이 아니라
            // "다이렉트 메시지"이고(`channelLabelParts`), 그때는 에가 맞아서다.
            recipient={peer ? "person" : "place"}
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
          pins={timeline.pins}
          actions={{
            myMemberId: session.member.id,
            onToggleReaction: timeline.toggleReaction,
            onTogglePin: timeline.togglePin,
            onEditMessage: timeline.editMessage,
            onDeleteMessage: timeline.deleteMessage,
          }}
          onOpenWorkSession={openWorkSession}
          onClose={() => {
            // 작업 패널의 onClose와 같은 이유 (#1431 · 아래 993-1004 주석): 이 서랍이
            // 덮어 `inert`로 만든 표면(chat-region) 안에 opener(답글 앵커)가 산다.
            // ThreadPanel.closePanel은 onClose() 뒤에 opener.focus()를 부르는데,
            // React는 언마운트 커밋 전까지 속성을 떼지 않으므로 그 focus()보다 먼저
            // 여기서 뗀다. `covered` 효과가 다시 맞춘다(뗄 게 없으면 no-op).
            coveredRef.current?.removeAttribute("inert");
            setThread(null);
          }}
        />
      )}

      {workOpen && !thread && stressCount === 0 && !workPanelOpen && (
        <WorkPanel
          channelId={channelId}
          scope={workScope}
          onScopeChange={changeWorkScope}
          selectedId={workSessionId}
          onSelectedIdChange={setWorkSessionId}
          controlIntentSessionId={workControlIntent}
          onControlIntentConsumed={() => setWorkControlIntent(null)}
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

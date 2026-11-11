import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

/**
 * 타임라인 꼬리 행 (#2944 GC-3, brief §3.2 · Q1).
 *
 * 채팅의 로컬 연결 카드처럼 **메시지가 아닌** 것이 타임라인 맨 아래(컴포저 바로
 * 위)에 붙는 자리다. 목록 데이터(`items`)에 들어가지 않으므로 seq·안읽음·폴딩을
 * 건드리지 않고, virtuoso의 Footer라 스크롤과 함께 움직이며 새 메시지가 와도 늘
 * 가장 아래에 남는다. `components`는 모듈 상수여야 한다(바뀌면 virtuoso가 목록을
 * 다시 세운다), 그래서 내용은 컨텍스트로 건넨다.
 */
const TimelineTailContext = createContext<ReactNode>(null);

function TimelineTail() {
  const tail = useContext(TimelineTailContext);
  if (tail === null || tail === undefined || tail === false) return null;
  return <div data-testid="timeline-tail">{tail}</div>;
}

const TIMELINE_COMPONENTS = { Footer: TimelineTail };
import {
  type AgentRunProgress,
  type Channel,
  type Message,
  type RosterMember,
} from "@momo/core/lib/api";
import { prefersReducedMotion } from "@/app/sidebarPane";
import type { Directory } from "@/features/workspace/useWorkspace";
import type { DmGroupFacts } from "@momo/core/features/workspace/directory";
import type { OpenWorkSession } from "@/features/work/openWorkSession";
import { Skeleton } from "@/features/common/States";
import {
  buildTimelineItems,
  type EchoPins,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineItem,
} from "@momo/core/features/timeline/model";
import {
  CHANNEL_INTRO_ITEM,
  buildChannelIntro,
  shouldShowChannelIntro,
  type ChannelIntroItem,
} from "./channelIntro";
import { ChannelIntroBlock } from "./ChannelIntroBlock";
import type { WelcomeKickoffPhase } from "@/features/welcome/welcomeKickoff";
import {
  foldDeletedRuns,
  type DeletedFoldFields,
} from "@momo/core/features/timeline/deletedFold";
import { isStreamRunEnded } from "@momo/core/features/timeline/streamStop";
import { groupRepliesByRoot, liveThreadRollup } from "@momo/core/features/timeline/threadSummary";
import { mainFlowMessages } from "@momo/core/features/timeline/threadHome";
import { messageAboveIds } from "@momo/core/features/timeline/quote";
import { useEndedRuns } from "@/features/agents/endedRuns";
import { useChannelRuns } from "@/features/agents/agentRunProgressStore";
import { runsByTriggerMessage } from "@momo/core/features/agents/runStatusLine";
import { presentableRows } from "@momo/core/features/timeline/toolCallSettle";
import { runStatusForMessage } from "./runStatus";

import {
  DayDivider,
  MessageRow,
  RecoveryDivider,
  UnreadDivider,
  type MessageRowActions,
} from "./MessageRow";
import { TimelineLiveRegionProvider } from "./timelineLiveRegion";
import { PendingRow } from "./PendingRow";
import { isFailedRow, type SendFailureKind } from "@momo/core/features/connection/sendFailure";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import type { ConnectionCause } from "@momo/core/features/connection/model";
import { LoadFailureBox, LoadFailureLine } from "@/features/common/LoadFailureBox";
import { SystemLine } from "./SystemLine";
import { isSystemLineMessage, startGroupAfterSystemLine } from "./systemLineRows";
import { holdScrollPosition, type ScrollHold } from "./scrollHold";
import { JUMP_LATEST_SHOW_DELAY_MS } from "@/design/motion";
import { chipsFor, type ReactionMap } from "@momo/core/features/timeline/reactions";
import { isPinned, type PinMap } from "@momo/core/features/timeline/pins";
import {
  unfurlsFor,
  type UnfurlMap,
} from "@momo/core/features/timeline/unfurl";
import {
  AT_BOTTOM_SLACK_PX,
  countNewerThan,
  countUnreadJump,
  dataIndexFromVirtuoso,
  firstUnreadMessageSeq,
  hasFreshSelfSend,
  reconcileDividerRelation,
  relationFromIntersection,
  shouldLatchUnreadJump,
  shouldShowJumpUnread,
  timelineScrollBehavior,
  unreadDividerIndexOf,
  newestSeqOf,
  type DividerViewportRelation,
} from "./navigation";
import { scheduleFocusRowStationBySeq } from "./rowFocus";
import {
  UnreadPill,
  UnreadPillDock,
  jumpLatestAriaLabel,
  jumpLatestLabel,
  jumpUnreadAriaLabel,
  jumpUnreadLabel,
} from "./UnreadPill";

// =============================================================================
// Timeline (R-1 §3). Virtualised by react-virtuoso, ordered by seq only, with
// the derived render stream (day / unread / recovery markers) folded in by
// buildTimelineItems. The four states live here so the surface is never a bare
// blank area; offline is one banner above, owned by the shell.
// =============================================================================

// ---- virtualisation contract (R-1 §3: "firstItemIndex 조정으로 스크롤 점프 없이
// prepend") -------------------------------------------------------------------
//
// react-virtuoso only holds the row under the reader when `firstItemIndex`
// DECREASES by exactly the number of items inserted at the head, in the SAME
// commit that hands it the longer `data` array. Without that it treats the
// prepend as new content and the viewport jumps forward by a page.
//
// The shift cannot be "page size": `items` is the derived stream, so a 50
// message page can insert 51 items (a day separator moves in with it). So the
// shift is measured against the anchor row itself, the oldest message that was
// already on screen, by how far it moved.
const START_INDEX = 1_000_000;
/** 맨 위 닿음 확인을 미루는 시간(#5662). 가상 목록의 `startReached` 조절(200ms)과 같아 진입 수렴의 첫 몇 프레임을 맨 위로 읽지 않는다. */
const TOP_REACH_SETTLE_MS = 200;

/** 답글이 없는 루트가 부르는 빈 배열 — 렌더마다 새 배열을 만들지 않는다. */
const NO_REPLIES: readonly Message[] = [];

/**
 * 이 목록이 그리는 항목. 코어 스트림에 삭제 접기의 두 필드가 얹힌 것이다
 * (`deletedFold.ts`) — 접기는 그리는 순간에만 일어나고 메시지 배열도 seq도
 * 커서도 그것을 모른다.
 */
type FoldedItem =
  | (TimelineItem & DeletedFoldFields)
  | ChannelIntroItem;

/** Oldest message currently in the stream, with its position. */
function anchorOf(
  items: FoldedItem[]
): { seq: number; index: number } | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "message") return { seq: item.message.seq, index: i };
  }
  return null;
}

function indexOfSeq(items: FoldedItem[], seq: number): number {
  return items.findIndex(
    (item) => item.kind === "message" && item.message.seq === seq
  );
}

/**
 * 이 목록에게 **한 줄을 존재하게 하라**고 시키는 손잡이 (리뷰 B1, #1193).
 *
 * ## 왜 DOM 워처만으로는 안 되는가 (실측)
 *
 * `inbox/anchor.watchForRow` 는 `document.querySelector` 를 폴링한다. 그 계약은
 * 「행은 곧 마운트된다」에 기대는데, 가상 목록에서 그 말은 **창 안에 있을 때만**
 * 참이다. 리뷰가 잰 표: 20·30줄 방에서는 찾았고 45줄부터는 창이 36줄로 잘려
 * 목표가 DOM 에 아예 없었다. 그러면 화면은 「위로 올려 이전 대화를 더
 * 불러오세요」라고 말하는데 그 메시지는 **이미 로드돼 있다**. 작업 세션의 발원
 * 메시지는 정의상 그 스레드에서 가장 오래된 줄이라, 이것은 가장자리가 아니라
 * 이 컨트롤의 상시 경로였다.
 *
 * 폰에는 이 결함이 없다 — 그쪽 `Timeline` 은 **데이터 배열**에서 찾아
 * (`items.findIndex`) 리스트에 스크롤을 명령한다. 그래서 이 손잡이는 새 기계가
 * 아니라 이미 있던 계약의 웹 쪽 짝이다.
 *
 * ## 답이 두 갈래인 것이 이 손잡이의 값이다
 *
 * `false` 는 「이 목록이 그것을 들고 있지 않다」이고, **그때만** 「더
 * 불러오세요」가 참이다. `true` 는 「들고 있고, 지금 그리로 옮겨 놓았다」다.
 * 워처는 그 뒤에 마운트된 행을 찾아 표식을 건다 — 두 층이 각자 아는 것만 한다.
 */
export interface TimelineJump {
  bringIntoView(target: { messageId?: string; seq?: number }): boolean;
}

/**
 * 목록에서 이 메시지의 자리. 자기 행이 먼저이고, 없으면 **그것을 대신해 서 있는
 * 행**(연속 묘비 접기)이다 — `watchForMessageId` 가 선택자 둘을 그 순서로 보는
 * 것과 같은 규칙이고, 근거도 그쪽 주석에 있다.
 */
function indexOfMessageId(items: FoldedItem[], messageId: string): number {
  const wanted = messageId.toLowerCase();
  const own = items.findIndex(
    (item) => item.kind === "message" && item.message.id.toLowerCase() === wanted
  );
  if (own >= 0) return own;
  return items.findIndex(
    (item) =>
      item.kind === "message" &&
      (item.deletedFoldedIds ?? []).some((id) => id.toLowerCase() === wanted)
  );
}

interface AnchorState {
  /** Identity of the stream this index was computed for. */
  items: FoldedItem[];
  firstItemIndex: number;
  /** Bumped when the stream is replaced, to remount instead of shifting. */
  epoch: number;
}

// ---- 항법 (U4-j · 진단 M-9 · BF-A2) -----------------------------------------
//
// 진단이 실측한 것: `ref`는 선언되고 전달만 될 뿐 **한 번도 역참조되지 않았다**.
// 위로 올라가 읽다가 현재로 돌아오려면 손으로 끝까지 밀어야 했다.
//
// 아래 필은 **한 컨트롤의 두 문장**이다. 자리도 같고 하는 일도 같다 (맨 아래로
// 간다). 다른 것은 그 사이에 새 메시지가 왔는가뿐이고, 그것을 아는 사람에게 두
// 개의 버튼을 세우면 같은 자리에서 두 번 고르게 만드는 일이 된다.
//
// 위 필은 다른 목적지다: 읽음 구분선(가장 오래된 안읽음). 오래 비운 뒤 바닥에
// 떨어진 사람에게 그 줄로 되돌아가는 문이다. 아래 필과 동시에 떠도 역할이
// 갈라진다 (위=과거, 아래=최신).
//
// `followOutput`와의 계약: 바닥에 있으면 virtuoso가 스스로 따라가므로
// 아래 컨트롤은 아예 뜨지 않는다. 같은 틱 대량 추가는 배치 *전* 바닥 여부를
// 쓴다 — virtuoso가 append 중에 잠깐 "바닥이 아님"을 보고해도 따라간다.
// 읽던 중(바닥이 아닌 상태)에는 화면이
// **움직이지 않아야** 하고 — 읽던 줄이 밀려나는 것은 새 메시지가 저지를 수 있는
// 가장 나쁜 일이다 — 대신 아래에 몇 개가 쌓였는지를 이 줄이 말한다. 그 산수는
// 조용히 틀릴 수 있어서 따로 산다: `navigation.ts`.

export function Timeline({
  messages,
  directory,
  status,
  channelKind,
  viewingThreadId,
  peer,
  dmGroup,
  lastReadSeq,
  unreadCount,
  recoveryMarkers,
  pending,
  echoPins,
  serverOffsetMs,
  actions,
  reactions,
  pins,
  unfurls,
  onStartReached,
  olderFailed = false,
  onRetryOlder,
  onRetry,
  onOpenThread,
  onQuoteMessage,
  onJumpToMessage,
  jumpHandleRef,
  onOpenWorkSession,
  onResend,
  onResendPending,
  onDiscardPending,
  failureKinds,
  onResendAllPending,
  loadCause = null,
  onAddMember,
  canConnectAgent = false,
  onConnectAgent,
  onStartWriting,
  isPlayEntrance,
  onEntranceConsumed,
  capUnmountedArrivals,
  welcomePhase = "hidden",
  welcomeHoldWriteAction = false,
  tail = null,
  reachedStart = false,
  canAddMember = false,
  channelName,
  channelTopic,
}: {
  messages: Message[];
  directory: Directory;
  status: "loading" | "ready" | "error";
  /** Decides what "empty" means here: a channel gains members, a DM cannot. */
  channelKind?: Channel["kind"];
  /**
   * 지금 이 화면이 **보고 있는** 스레드의 루트 id — 스레드 패널이 열려 있고 창이 앞일 때만 준다(아니면 `null`/생략). 그 루트의 요약
   * 줄은 남의 새 답글에도 안 읽은 수를 0으로 읽는다: 사람이 그 답글들을 지금 읽고 있고, 읽음 신호(`PUT …/read`)가 왕복하는 동안
   * 칩이 깜빡 +1 되지 않게 한다(코어 `liveThreadRollup`의 `viewing`, #5032). 패널이 읽음 신호를 보내는 조건과 같은 값이어야 한다
   * (`useDocumentForeground`).
   */
  viewingThreadId?: string | null;
  /** Visible channel / DM name. The intro titles itself from this. */
  channelName?: string;
  /** Channel topic, quoted as the intro body when present. */
  channelTopic?: string;
  /**
   * Older history is exhausted. The intro is a leading row only at the start
   * of the channel, never mid-window while a previous page is still loading.
   */
  reachedStart?: boolean;
  /** Owner/admin (same helper as channel create). Hidden for everyone else. */
  canAddMember?: boolean;
  /** The other participant, for a DM. */
  peer?: RosterMember | null;
  /** 셋 이상 DM의 참여자 사실(ADR-0217). 소개 문구가 「둘만 봅니다」라 말하지 않게 한다. 1:1이면 비운다. */
  dmGroup?: DmGroupFacts | null;
  lastReadSeq?: number | null;
  unreadCount?: number;
  recoveryMarkers?: RecoveryMarker[];
  /** Local echoes awaiting their seq; folded in at the tail (M10). */
  pending?: PendingMessage[];
  /**
   * #5624 — 에코였던 확정본이 이 화면에서 이어 쓰는 에코의 시각(`useTimeline`의 `echoPins`). 있으면 에코가 확정본으로 바뀌어도
   * 머리/이어짐이 그대로다. 없는 표면(작업 기록 등)은 서버 시각으로 묶는다.
   */
  echoPins?: EchoPins;
  /** #5624 — 서버 시계와 이 기기 시계의 차이(ms, `useTimeline`의 `serverOffsetMs`). 에코의 묶음과 시각 글자가 쓴다. */
  serverOffsetMs?: number;
  /**
   * B11 — what a row may do to its message. Omitted where the surface is a
   * transcript rather than a conversation (the work session event log), and the
   * rows there then render exactly as before.
   *
   * `chips` is filled per row from `reactions` below, so the caller hands over
   * the map once instead of deriving a list for every message in the channel.
   */
  actions?: Omit<MessageRowActions, "chips" | "pinned">;
  reactions?: ReactionMap;
  /**
   * 이슈 #1112 — the channel's pins, handed over once. `pinned` is derived per
   * row here for the same reason `chips` is: a row that held the whole map
   * would re-render every time anything anywhere in the channel was pinned.
   */
  pins?: PinMap;
  /** ADR-0170 server projection, keyed by case-folded message id. */
  unfurls?: UnfurlMap;
  onStartReached?: () => void;
  /** 마지막 옛 쪽 읽기가 실패했다(#5662). 목록 위에 한 줄과 「다시 시도」를 건다. */
  olderFailed?: boolean;
  /** 그 줄의 「다시 시도」. */
  onRetryOlder?: () => void;
  onRetry?: () => void;
  onOpenThread?: (message: Message) => void;
  /** ADR-0148 - pin a row to the composer as a quote. */
  onQuoteMessage?: (message: Message) => void;
  /** Jump to a quoted original (the channel surface's existing anchor watcher). */
  onJumpToMessage?: (messageId: string, seq: number | null) => void;
  /**
   * 채널 표면이 「이 줄을 존재하게 하라」고 부를 손잡이 (리뷰 B1). 목록만 아는
   * 것을 목록에게 묻는다 — 무엇이 로드돼 있고 그중 무엇이 지금 창 밖인지.
   */
  jumpHandleRef?: MutableRefObject<TimelineJump | null>;
  onOpenWorkSession?: OpenWorkSession;
  onResend?: (message: Message) => Promise<void> | void;
  onResendPending?: (clientMsgId: string) => Promise<void> | void;
  /** 보내지 못한 echo 행을 이 기기에서 지운다(#5210). 없으면 행이 X 를 그리지 않는다. */
  onDiscardPending?: (clientMsgId: string) => void;
  /** 실패한 행마다 원인 한 줄의 종류(#5221). 항목이 없으면 원인 없이 「전송 실패」만 말한다. */
  failureKinds?: ReadonlyMap<string, SendFailureKind>;
  /** 실패한 행이 둘 이상일 때 마지막 실패 행 아래 「모두 다시 보내기」가 부른다(#5221). 없으면 단추를 그리지 않는다. */
  onResendAllPending?: () => Promise<void> | void;
  /** `status` 가 `error` 일 때 그 실패가 말하는 원인(#5221). 연결 쪽 원인이 아니면 `null`. */
  loadCause?: ConnectionCause | null;
  /**
   * 이 채널에 워크스페이스 멤버를 넣는다. 빈 채널의 보조 행동 (#1536). 이름이
   * 초대가 아니라 추가인 이유는 코어 라벨 상수의 머리말 (#1573): 이 손잡이가
   * 여는 것은 「멤버 추가」 다이얼로그이고, 초대는 워크스페이스의 낱말이다.
   */
  onAddMember?: () => void;
  /**
   * 에이전트가 한 명도 없는 워크스페이스의 관리자에게만 true(#3697). 빈 채널에
   * 「에이전트 연결」을 세운다. 누르면 AI 연결 화면(재진입)이 열린다.
   */
  canConnectAgent?: boolean;
  onConnectAgent?: () => void;
  /**
   * Put the caret in the composer. 빈 채널·빈 DM 양쪽의 **첫** 행동이다 —
   * 두 표면이 다른 이유로 비어 있어도 다음에 하는 일은 같다 (#1536).
   */
  onStartWriting?: () => void;
  /**
   * ADR-0179 D3. Live-arrival ids that have not yet mounted. The hook owns
   * the set; this surface only reads it at render.
   */
  isPlayEntrance?: (messageId: string) => boolean;
  onEntranceConsumed?: (messageId: string) => void;
  /**
   * Sweep grants whose rows were never offered a mount (reader scrolled
   * up). Live batches use at-bottom captured before the batch is applied
   * so a transient during append is not a scroll-up.
   */
  capUnmountedArrivals?: () => void;
  /**
   * Welcome kickoff phase. The band itself lives above the composer (#2817,
   * `WelcomeKickoffStage` in ChatShell); the list only reads the phase to keep
   * the empty-channel write CTA down while the band speaks.
   */
  welcomePhase?: WelcomeKickoffPhase;
  /** Hide the empty-channel write CTA while the band is up or the mount is pending. */
  welcomeHoldWriteAction?: boolean;
  /** 타임라인 꼬리 행(메시지가 아닌 로컬 카드, #2944). */
  tail?: ReactNode;
}) {
  const ref = useRef<VirtuosoHandle>(null);

  // ADR-0148 - 라이브로 도착한 인용 답글의 원본을 화면에 이미 있는 행에서 푼다.
  //
  // Map을 한 번 만들고 행들이 공유한다: 행마다 `messages.find`를 돌면 화면에 50개
  // 행이 있을 때 조회가 2500번이 되고, 그 값은 스크롤마다 다시 계산된다. 키는
  // 소문자 id다 - 와이어가 대소문자를 섞어 보낸다(Swift `uuidString`은 대문자,
  // 페이지 행은 소문자).
  const byId = useMemo(() => {
    const index = new Map<string, Message>();
    for (const message of messages) index.set(message.id.toLowerCase(), message);
    return index;
  }, [messages]);
  const quoteLookup = useMemo(
    () => (messageId: string) => byId.get(messageId.toLowerCase()),
    [byId]
  );

  // 접기 판정이 `actions` 객체 전체가 아니라 이 문자열 하나에만 매달리게 한다:
  // 부모가 매 렌더 새 객체를 넘기므로(ChatShell의 인라인 리터럴) `actions`를
  // 의존성에 넣으면 스트림이 매 렌더 새로 만들어지고, 그 동일성은 이 목록의
  // 앵커 보정이 기대는 것이다.
  const myMemberIdForFold = actions?.myMemberId;
  // 본류에는 root 없는 메시지만 서요(ADR-0148 증보 2026-11-05 — 코어 `isMainFlowRow` 한 곳, 폰과 같은 규칙). 서버가 소속 root를 준 답글은 모두
  // 스레드에만 보여요: 옛날에 「대화에도 보내기」로 보낸 답글(서버 필드 `alsoInChannel`)도 본류의 행이나 한 줄 요약 없이 스레드에서만 읽혀요.
  // root 없는 카드는 그대로예요.
  const mainMessages = useMemo(() => mainFlowMessages(messages), [messages]);

  // 루트 아래 요약 줄(#5008): 서버가 페이지에서 준 요약은 읽은 때의 스냅샷이라, 그 뒤 실시간으로 온 답글의 수·얼굴·안 읽은 수는
  // 이 목록이 이미 든 답글(`messages`에는 답글 프레임도 들어 있다 — 본류에서만 `mainMessages`가 뺀다)로 그 위에 얹는다.
  // 규칙은 코어 `liveThreadRollup` 한 곳이다. 든 배열에서 파생하므로 되쏘기에도 같은 답이다.
  const repliesByRoot = useMemo(() => groupRepliesByRoot(messages), [messages]);
  // `viewing`은 그리는 쪽만 켠다(아래 행 렌더): 열린 스레드가 바뀌어도 이 함수의 동일성은 그대로여야 삭제 접기(`items`)의 스트림이
  // 다시 지어지지 않는다 — 접기가 묻는 것은 「요약이 있는가」뿐이고 그것은 `viewing`과 상관없다.
  const viewingKey = viewingThreadId == null ? null : viewingThreadId.toLowerCase();
  const rollupFor = useCallback(
    (message: Message, viewing = false) =>
      liveThreadRollup(message, repliesByRoot.get(message.id.toLowerCase()) ?? NO_REPLIES, myMemberIdForFold, viewing),
    [repliesByRoot, myMemberIdForFold]
  );

  // 연달아 지워진 메시지는 한 줄로 접힌다 (감사 M-1). 폰이 먼저 고쳤고, 코어 승격과
  // 함께 실측한 결과 **웹도 같은 결함을 갖고 있었다**: 이 스트림은
  // `buildTimelineItems` 하나로 끝났고 그 안에 삭제 접기가 없다 — 연속 묘비 네 개는
  // 네 줄로 섰다(게이트 `gate-composer.mjs`의 `[deleted]` 절이 그 수를 인쇄한다).
  //
  // 접기가 아래 앵커 산수보다 **먼저** 도는 것이 load-bearing이다. `firstItemIndex`
  // 보정은 「머리에 삽입된 항목 수」를 세는데 그 수는 화면에 실제로 서는 항목의
  // 수여야 하고, 접기가 뒤에 오면 세는 배열과 그리는 배열이 달라진다.
  //
  // `factsFor`가 여기 있는 이유: 접지 않을 조건(답글·반응)은 **목록만 안다.**
  // 롤업은 메시지가 들고 있고, 반응은 이 컴포넌트가 받은 표에서 온다.
  const showIntro = shouldShowChannelIntro({
    status,
    reachedStart,
    messageCount: mainMessages.length,
  });
  // A local echo counts as content: it must appear under the intro the moment
  // it is sent, not after the server round trip, and it must not remount the
  // list (that remount was the empty-state layout shift).
  const empty =
    mainMessages.length === 0 && (pending === undefined || pending.length === 0);
  const showWelcome =
    welcomePhase === "stage" ||
    welcomePhase === "exiting" ||
    welcomePhase === "backstop";
  // 값(수)으로 의존한다: 부모가 렌더마다 새 객체를 줘도 소개 행이 다시 만들어지지 않는다.
  const groupCount = dmGroup?.count;
  const groupAgents = dmGroup?.agentCount;
  const intro = useMemo(
    () =>
      buildChannelIntro({
        kind: channelKind,
        name: channelName ?? "",
        topic: channelTopic,
        peer: peer ?? null,
        dmGroup:
          groupCount === undefined
            ? null
            : { count: groupCount, agentCount: groupAgents ?? 0 },
        canAddMember: Boolean(canAddMember) && channelKind !== "dm",
        canConnectAgent: Boolean(canConnectAgent) && channelKind !== "dm",
        empty,
      }),
    [
      channelKind,
      channelName,
      channelTopic,
      peer,
      groupCount,
      groupAgents,
      canAddMember,
      canConnectAgent,
      empty,
    ]
  );

  // 「모두 다시 보내기」는 실패한 행이 둘 이상일 때 **마지막** 실패 행 아래에 한 번만 선다(#5221).
  const failedPendingIds = useMemo(
    () => (pending ?? []).filter(isFailedRow).map((p) => p.clientMsgId),
    [pending]
  );
  const items = useMemo(() => {
    const folded = foldDeletedRuns(
      buildTimelineItems(presentableRows(mainMessages), {
        lastReadSeq,
        unreadCount,
        recoveryMarkers,
        pending,
        echoPins,
        serverOffsetMs,
      }),
      (item) => ({
        hasRollup: rollupFor(item.message) !== null,
        hasReactions:
          chipsFor(reactions ?? {}, item.message.id, myMemberIdForFold)
            .length > 0,
      })
    );
    // 중단 시스템 줄(`SystemLine`) 바로 다음 행은 작성자가 같아도 새 묶음이다(#5079) — 이유는 `startGroupAfterSystemLine`.
    // 접기 뒤에 건다: 시스템 줄은 살아 있는 메시지라 묘비 접기가 줄을 건너 이어 접는 일이 없어서, 줄 바로 다음 행은 접기 앞뒤로 같은 행이다.
    const grouped = startGroupAfterSystemLine(folded);
    return showIntro ? [CHANNEL_INTRO_ITEM, ...grouped] : grouped;
  }, [
    mainMessages,
    lastReadSeq,
    unreadCount,
    recoveryMarkers,
    pending,
    echoPins,
    serverOffsetMs,
    reactions,
    myMemberIdForFold,
    rollupFor,
    showIntro,
  ]);

  // 각 메시지 바로 위에 **그려진** 메시지(#5357). 접기를 다 거친 `items` 에서 한 번 센다 — 메시지 배열에서 세면 화면이 가린 행과 접은 묘비를
  // 잘못 센다. 가상 목록의 인덱스에서 이웃을 읽지 않는 까닭은 `firstItemIndex` 가 앞에 쌓인 행에 따라 움직이기 때문이다. 에이전트의 답이 이 표의
  // 이웃을 가리키면 그 행은 인용을 그리지 않는다(코어 `isQuoteRedundant`, 폰과 같은 함수).
  const aboveIds = useMemo(() => messageAboveIds(items), [items]);

  // ADR-0155 — 끝난 것을 **본** run 들. 여기서 한 번 구독하고 행에는 boolean 하나만
  // 내려 보낸다. 행마다 구독하면 아무 run 이나 끝날 때 화면의 모든 줄이 다시 그려지고,
  // 이 목록은 가상화되어 있어서 그 비용이 바로 스크롤로 나온다.
  const endedRuns = useEndedRuns();
  // #3824 — 내가 보낸 메시지 아래 상태 줄. 이 채널의 run을 여기서 한 번 구독하고, 행에는
  // 그 메시지가 일으킨 run만 내려 보낸다(같은 이유: 가상 리스트 전체 재렌더 방지).
  const timelineChannelId = messages[0]?.channelId ?? null;
  const channelRuns = useChannelRuns(timelineChannelId);
  const runsByMessage = useMemo(() => runsByTriggerMessage(channelRuns), [channelRuns]);
  const runStatusFor = (message: Message): readonly AgentRunProgress[] | undefined =>
    runStatusForMessage({ message, myMemberId: myMemberIdForFold, directory, runsByMessage });

  // Derived during render, not in an effect: virtuoso has to receive the new
  // `data` and the lowered `firstItemIndex` together or the correction lands a
  // frame late, which is exactly the jump it is meant to prevent. Keyed on the
  // `items` reference so a double render (StrictMode) cannot apply it twice.
  const anchorRef = useRef<AnchorState>({
    items: [],
    firstItemIndex: START_INDEX,
    epoch: 0,
  });
  if (anchorRef.current.items !== items) {
    const previous = anchorRef.current;
    const anchor = anchorOf(previous.items);
    const moved = anchor === null ? -1 : indexOfSeq(items, anchor.seq);
    if (anchor === null) {
      // Nothing was on screen to hold (first fill, or an empty channel).
      anchorRef.current = { ...previous, items };
    } else if (moved < 0) {
      // The stream was replaced (channel switch / reload). A RISING
      // firstItemIndex means "rows fell off the head" to virtuoso, so remount
      // instead and start the next channel from a clean index.
      anchorRef.current = {
        items,
        firstItemIndex: START_INDEX,
        epoch: previous.epoch + 1,
      };
    } else {
      const prepended = Math.max(0, moved - anchor.index);
      anchorRef.current = {
        items,
        firstItemIndex: previous.firstItemIndex - prepended,
        epoch: previous.epoch,
      };
    }
  }
  const { firstItemIndex, epoch } = anchorRef.current;

  // ---- 「이 줄을 존재하게 하라」 (리뷰 B1) -----------------------------------
  //
  // 손잡이는 **렌더 시점의** 목록을 봐야 하므로 거울을 하나 둔다. 클로저로 잡으면
  // 채널을 옮긴 직후 옛 배열을 뒤지게 되고, 그 답은 「없다」라서 화면은 로드된
  // 줄을 두고 「더 불러오세요」라고 말한다 — 이 수리가 없애려는 그 문장이다.
  const itemsRef = useRef<FoldedItem[]>(items);
  itemsRef.current = items;
  useEffect(() => {
    if (jumpHandleRef === undefined) return undefined;
    jumpHandleRef.current = {
      bringIntoView: (target) => {
        const list = itemsRef.current;
        const index =
          target.messageId !== undefined
            ? indexOfMessageId(list, target.messageId)
            : target.seq !== undefined
              ? indexOfSeq(list, target.seq)
              : -1;
        if (index < 0) return false;
        // `firstItemIndex` 를 더하지 않는다 (실측 — react-virtuoso `jn()`):
        // `scrollToIndex` 의 index 는 `totalCount` 로 클램프되는 **배열 첨자**이고,
        // `firstItemIndex` 는 `itemContent` 가 받는 번호에만 얹힌다.
        //
        // `behavior` 를 부드럽게 두지 않는 이유: 바로 뒤에 워처가 마운트된 행에
        // `scrollIntoView` 를 한 번 더 건다. 애니메이션이 도는 중에 그 호출이
        // 끼면 목록이 두 목적지 사이에서 튄다.
        ref.current?.scrollToIndex({ index, align: "center" });
        return true;
      },
    };
    return () => {
      jumpHandleRef.current = null;
    };
  }, [jumpHandleRef]);

  // ---- 항법 상태 (U4-j) -----------------------------------------------------
  //
  // 바닥에 있는지는 virtuoso만 안다(스크롤 위치는 이 컴포넌트가 재지 않는다).
  // 기준선은 **바닥을 떠난 순간의 가장 새 seq**다: 그때 화면에 없던 것이 곧
  // 「아래에 쌓인 것」이다. 상태가 아니라 ref인 이유는 그 값이 바뀌어도 다시
  // 그릴 것이 없기 때문이다 — 그릴 것은 아래 개수뿐이다.
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const baselineRef = useRef<number | null>(null);
  const newestSeqRef = useRef<number | null>(null);
  const messagesRef = useRef(messages);
  // Seeded `true`. Refreshed only on renders where `messages` did not
  // change, so there is a one-render lag between "the reader is away"
  // and "the sweep knows it". Measured (R5 SW): in the 0–16 ms window
  // after `jump-latest` becomes visible, a scrolled-up reader can get 1
  // play at mount (virtuoso itself followed to the bottom in both
  // builds; 1 ≤ ADR-0179 D3's 최대 3). From 50 ms the scroll-up rule
  // holds (0 plays, grant 1, position held). No behaviour change —
  // recorded number.
  const atBottomBeforeBatchRef = useRef(true);
  const pendingBottomBatchRef = useRef(false);
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  newestSeqRef.current = newestSeqOf(messages);

  // 내 확정 전송은 「새 메시지」가 아니다 (design-review M-3) — 그 낱말은 안읽음
  // 구분선에서 **남의 말**을 뜻한다. 이유는 `navigation.ts`에.
  const myMemberId = actions?.myMemberId;
  useEffect(() => {
    const baseline = baselineRef.current;
    setNewCount(
      baseline === null ? 0 : countNewerThan(messages, baseline, myMemberId)
    );
  }, [messages, myMemberId]);

  // ---- 내가 보낸 글은 맨 아래로 (#5603, owner 11-09) -----------------------------
  //
  // 위로 올려 읽던 중이어도 **내가 보내면** 맨 아래로 가서 보낸 줄이 보인다(폰 `selfSendToken` 과 같은 규칙). 남의 말은 지금처럼
  // 따라가지 않고 「최신 메시지로 이동」이 센다. 수리 전에는 바닥이 아닐 때 새 줄을 따라가지 않는 규칙이 내 메아리에도 걸려,
  // 보낸 줄이 화면 아래 밖에 섰다.
  //
  // 신호는 **처음 나타난 내 메아리**다(`hasFreshSelfSend`). 대화를 갈아탄 첫 렌더의 메아리(다른 대화의 것·되살린 실패 행)는 보낸
  // 것이 아니라 바탕으로만 적는다. 옮기는 손은 아래 `holdScrollPosition` 의 `expectBottom` 하나다 — 가상 목록의 따라가기
  // (`followOutput`)를 억지로 켜지 않는다: 게이트 실측(#5603)에서 그 따라가기는 마지막 줄의 아래 몇 px 위에 앉았고, 바닥 붙이기는
  // 줄 높이가 바뀔 때마다 진짜 바닥(거리 0)에 다시 붙인다. 바닥에서 보낸 글은 예전 길 그대로다(`expectBottom` 이 손대지 않는다).
  const seenPendingRef = useRef<{ epoch: number; ids: ReadonlySet<string> } | null>(null);
  const selfSendTickRef = useRef(0);
  {
    const rows = pending ?? [];
    const seen = seenPendingRef.current;
    if (seen === null || seen.epoch !== epoch) {
      seenPendingRef.current = { epoch, ids: new Set(rows.map((row) => row.clientMsgId)) };
    } else if (rows.some((row) => !seen.ids.has(row.clientMsgId))) {
      if (hasFreshSelfSend(seen.ids, rows, Date.now())) selfSendTickRef.current += 1;
      seenPendingRef.current = { epoch, ids: new Set(rows.map((row) => row.clientMsgId)) };
    }
  }

  const followOutput = useCallback(() => {
    // Same pre-batch at-bottom as the leftover sweep (#2050 R5 M-1).
    // `followOutput="auto"` would otherwise stop following while virtuoso
    // reports a transient "not at bottom" on a large same-tick append,
    // unmounting the newest granted rows before they play.
    return atBottomBeforeBatchRef.current || pendingBottomBatchRef.current
      ? "auto"
      : false;
  }, []);

  useEffect(() => {
    // Live-batch leftover sweep reads at-bottom from *before* this
    // messages commit (#2050 R5 M-1). Virtuoso can report a transient
    // "not at bottom" while a large same-tick append lands — often in a
    // follow-up render of the same batch. That is not a reader scroll-up.
    // Bottom same-tick still plays 3 at any batch size. A genuine
    // scroll-up (atBottom-only, no pending at-bottom batch) still sweeps.
    const messagesChanged = messagesRef.current !== messages;
    messagesRef.current = messages;
    const hasGrants = messages.some((message) => isPlayEntrance?.(message.id));
    if (messagesChanged) {
      if (atBottomBeforeBatchRef.current || pendingBottomBatchRef.current) {
        if (hasGrants) pendingBottomBatchRef.current = true;
        return;
      }
      capUnmountedArrivals?.();
      return;
    }
    if (atBottom) {
      atBottomBeforeBatchRef.current = true;
      pendingBottomBatchRef.current = false;
      return;
    }
    if (pendingBottomBatchRef.current) {
      pendingBottomBatchRef.current = false;
      requestAnimationFrame(() => {
        if (!atBottomRef.current) {
          atBottomBeforeBatchRef.current = false;
        }
      });
      return;
    }
    atBottomBeforeBatchRef.current = false;
    capUnmountedArrivals?.();
  }, [messages, atBottom, capUnmountedArrivals, isPlayEntrance]);

  // 상단 N은 연 순간의 동결 스냅샷 — 구분선과 같은 수 (M-1(a)). 라이브 꼬리는
  // 하단 필이 센다. 사유는 `navigation.ts` (a)/(b).
  const unreadJumpCount = countUnreadJump(unreadCount);
  const unreadDividerIndex = unreadDividerIndexOf(items);
  const firstItemIndexRef = useRef(firstItemIndex);
  firstItemIndexRef.current = firstItemIndex;
  const unreadIndexRef = useRef(unreadDividerIndex);
  unreadIndexRef.current = unreadDividerIndex;

  const [renderedRange, setRenderedRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [observedRelation, setObservedRelation] =
    useState<DividerViewportRelation | null>(null);
  const [dividerEl, setDividerEl] = useState<HTMLElement | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const [unreadJumpLatched, setUnreadJumpLatched] = useState(false);

  const dividerRelation = reconcileDividerRelation({
    dividerIndex: unreadDividerIndex,
    visibleStart: renderedRange?.start ?? null,
    visibleEnd: renderedRange?.end ?? null,
    observed: observedRelation,
  });
  const showJumpUnread = shouldShowJumpUnread(
    dividerRelation,
    unreadJumpCount,
    unreadJumpLatched
  );

  // 채널을 갈아타면 기준선도, 위 필이 기대는 창 위치도, 래치도 버린다.
  // `epoch`가 바뀌는 것이 곧 「다른 대화」다.
  useEffect(() => {
    baselineRef.current = null;
    setNewCount(0);
    setAtBottom(true);
    setRenderedRange(null);
    setObservedRelation(null);
    setUnreadJumpLatched(false);
  }, [epoch]);

  // 래치 무장은 IO가 실측한 「in」만. range 폴백 「in」은 오버스캔에 마운트만
  // 된 구분선도 창 안이라고 보고한다 — 그 거짓으로 무장하면 위로 읽는 동안
  // 필이 영구 소멸한다 (H-1 오발).
  useEffect(() => {
    if (shouldLatchUnreadJump(observedRelation)) setUnreadJumpLatched(true);
  }, [observedRelation]);

  useEffect(() => {
    if (dividerEl === null || scrollerEl === null) {
      setObservedRelation(null);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry === undefined) return;
        const next = relationFromIntersection(entry);
        if (next !== null) setObservedRelation(next);
      },
      { root: scrollerEl, threshold: 0 }
    );
    io.observe(dividerEl);
    return () => io.disconnect();
  }, [dividerEl, scrollerEl]);

  const jumpToLatest = useCallback(() => {
    const seq = newestSeqRef.current;
    ref.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: timelineScrollBehavior(prefersReducedMotion()),
    });
    if (seq !== null) scheduleFocusRowStationBySeq(seq);
  }, []);

  const jumpToUnread = useCallback(() => {
    const index = unreadIndexRef.current;
    if (index === null) return;
    const seq = firstUnreadMessageSeq(itemsRef.current, index);
    // 실행 자체가 진입이다. IO가 늦어도 이 epoch에서 필을 다시 세우지 않는다.
    setUnreadJumpLatched(true);
    ref.current?.scrollToIndex({
      index,
      align: "start",
      behavior: timelineScrollBehavior(prefersReducedMotion()),
    });
    if (seq !== null) scheduleFocusRowStationBySeq(seq);
  }, []);

  // 창의 높이가 줄어도(DS2-6 #2718), 줄 높이가 바뀌어도(#5575) 바닥은 바닥이고, 위를 읽던 사람의 줄은
  // 제자리다. 데스크탑 WebKit 은 이 목록 안에서 스크롤 앵커링을 하지 않아 그림 줄이 자라면 목록이 밀렸다.
  // 판정·바로잡기의 규칙은 `scrollHold.ts`.
  const holdRef = useRef<ScrollHold | null>(null);
  useEffect(() => {
    if (!scrollerEl) return;
    const hold = holdScrollPosition(scrollerEl, { firstItemIndex: () => firstItemIndexRef.current });
    holdRef.current = hold;
    return () => {
      hold.stop();
      if (holdRef.current === hold) holdRef.current = null;
    };
  }, [scrollerEl]);

  // 내 메아리가 들어온 커밋에서 위 바로잡기에게 「이제 바닥」이라고 알린다(#5603): 위를 읽던 중이면 그 자리에서 맨 아래로 옮기고,
  // 이어지는 줄 높이 변화(메아리 → 확정본)에도 바닥에 붙인다. 보던 줄을 지키는 바로잡기(WebKit 수동 앵커, #5583)와 같은 모듈이
  // 하므로 둘이 다투지 않는다. 그리기 전에 옮기려고 레이아웃 효과다.
  const handledSelfSendRef = useRef(0);
  useLayoutEffect(() => {
    if (selfSendTickRef.current === handledSelfSendRef.current) return;
    handledSelfSendRef.current = selfSendTickRef.current;
    holdRef.current?.expectBottom();
  }, [pending, epoch]);

  // 「최신 메시지로 이동」의 늦춤 (#5575): 바닥을 떠난 상태가 잠깐 이어져야 선다. 바닥에 닿으면 바로 걷는다.
  // 목록이 한 프레임 밀렸다 돌아오는 동안 필이 섰다 사라지며 깜빡이지 않게 한다. `atBottom` 자체(기준선 ·
  // 따라가기)는 늦추지 않는다 — 늦추는 것은 그리기뿐이다.
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  useEffect(() => {
    if (atBottom) {
      setShowJumpLatest(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShowJumpLatest(true), JUMP_LATEST_SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [atBottom]);

  const onScrollerRef = useCallback((node: HTMLElement | Window | null) => {
    setScrollerEl(node instanceof HTMLElement ? node : null);
  }, []);

  // 맨 위 닿음(#5662). 가상 목록의 `startReached` 는 첫 줄 번호가 바뀔 때만 다시 나간다(같은 번호는 한 번만 — react-virtuoso 4.18).
  // 그래서 (가) 옛 쪽 읽기가 실패해 번호가 그대로면 다시 맨 위에 닿아도 나가지 않았고, (나) 머리말 한 줄뿐인 빈 대화에서 이미 나간
  // 번호를 다음 대화가 같은 목록 인스턴스에서 물려받으면(첫 쪽이 한 프레임 안에 와 로딩 뼈대가 서지 않을 때 — 앞 대화에 메시지 줄이
  // 없어 다시 붙지 않는다) 그 대화에서는 나가지 않았다. 그래서 `startReached` 옆에 닿음 확인을 하나 더 둔다: 위 상태가 참이 될
  // 때마다, 그리고 보이는 대화가 바뀔 때 이미 맨 위면, 가상 목록과 같은 시간 뒤 스크롤러가 아직 맨 위인지 보고 부른다. 진입 수렴(바닥으로
  // 가는 첫 몇 프레임의 맨 위)은 그 안에 끝나 부르지 않는다. 두 길이 겹쳐도 훅이 읽는 중이면 하나 더 내지 않는다(`useTimeline.loadOlder`).
  const atTopRef = useRef(false);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  scrollerElRef.current = scrollerEl;
  const onStartReachedRef = useRef(onStartReached);
  onStartReachedRef.current = onStartReached;
  const topCheckRef = useRef<number | null>(null);
  const checkTopSoon = useCallback(() => {
    if (topCheckRef.current !== null) window.clearTimeout(topCheckRef.current);
    topCheckRef.current = window.setTimeout(() => {
      topCheckRef.current = null;
      const scroller = scrollerElRef.current;
      if (atTopRef.current && scroller !== null && scroller.scrollTop <= 0) onStartReachedRef.current?.();
    }, TOP_REACH_SETTLE_MS);
  }, []);
  useEffect(
    () => () => {
      if (topCheckRef.current !== null) window.clearTimeout(topCheckRef.current);
    },
    []
  );
  // 가장 옛 줄(답글 포함)이 바뀌어도 다시 본다: 옛 쪽이 본류에 줄을 하나도 더하지 않으면(스레드 답글뿐) 목록 번호도 위 상태도 그대로라
  // 두 신호 모두 다시 나가지 않는다.
  const oldestLoadedSeq = messages[0]?.seq ?? null;
  useEffect(() => {
    if (atTopRef.current) checkTopSoon();
  }, [timelineChannelId, oldestLoadedSeq, checkTopSoon]);
  const onAtTopChange = useCallback(
    (top: boolean) => {
      atTopRef.current = top;
      if (top) checkTopSoon();
    },
    [checkTopSoon]
  );

  // 불러오기가 실패했다(#5221). 받아 둔 글이 **없으면** 제목 + 이유 한 줄 + 다시 시도 상자, **있으면** 상자로 덮지 않고
  // 목록은 그대로 두고 위에 한 줄만 건다(읽을 것이 있는데 화면을 비우면 정보를 버리는 일이다). 이유는 실패가 말하는
  // 원인의 닫힌 분류 문장이고 상태 코드·서버 원문은 없다.
  if (status === "error" && empty) {
    return (
      <LoadFailureBox
        titleKey={CONNECTION_KEYS.loadConversationTitle}
        cause={loadCause}
        onRetry={() => onRetry?.()}
        testId="timeline-error"
      />
    );
  }

  if (status === "loading" && empty) {
    // Virtuoso owns a height:100% scroller. Overlaying a fixed-height bar
    // block in the same grid cell fights that ownership (and would floor
    // the pane the way B-1 did on shorter surfaces). Keep the old pop.
    return <Skeleton ready={false} rows={6} className="p-4" />;
  }

  return (
    // `relative`는 아래 항법 컨트롤이 붙을 자리다. 컨트롤이 타임라인 **안**에
    // 사는 이유: 그 줄이 가리키는 곳도, 눌렀을 때 움직이는 것도 이 스크롤러다.
    <div className="relative h-full">
      {status === "error" && (
        <LoadFailureLine
          titleKey={CONNECTION_KEYS.loadNewerTitle}
          onRetry={() => onRetry?.()}
          testId="timeline-error-line"
          className="layer-content-float absolute inset-x-0 top-0 bg-pane"
        />
      )}
      {/* 옛 쪽 읽기 실패(#5662): 같은 자리에 떠 있는 한 줄이라 뜨고 질 때 목록이 밀리지 않는다. 새 쪽 실패 줄이 서 있으면 그것이 먼저다. */}
      {status !== "error" && olderFailed && (
        <LoadFailureLine
          titleKey={CONNECTION_KEYS.loadOlderTitle}
          onRetry={() => onRetryOlder?.()}
          testId="timeline-older-error"
          className="layer-content-float absolute inset-x-0 top-0 bg-pane"
        />
      )}
      <TimelineLiveRegionProvider>
      <TimelineTailContext.Provider value={tail}>
      <Virtuoso
        key={epoch}
        ref={ref}
        // `overscroll-contain` (goal B9): 목록 끝에 닿은 뒤 한 번 더 미는 손가락이
        // 브라우저에게 넘어가지 않는다. 넘어가면 안드로이드 크롬은 pull-to-refresh로
        // 페이지를 다시 읽고 iOS는 화면 전체를 고무줄처럼 끌어당긴다 — 타임라인 맨
        // 위에서 더 당기는 몸짓의 뜻은 언제나 "더 옛날 것"이지 "앱을 다시 열기"가
        // 아니다. `none`이 아닌 이유는 고무줄 자체는 남겨야 화면이 살아 있게
        // 느껴지기 때문이다.
        // `timeline-scroller` (#5638): 브라우저 스크롤 앵커링을 끈다. 스크롤 위치는 가상 목록과
        // `scrollHold` 한 길로만 움직이고, 앵커링이 있는 엔진(Chromium · macOS 27 WebKit)과 없는
        // 엔진(macOS 14~26 WebKit)이 같은 길을 탄다.
        className="overscroll-contain h-full timeline-scroller"
        data={items}
        components={TIMELINE_COMPONENTS}
        data-testid="timeline-virtuoso"
        alignToBottom
        followOutput={followOutput}
        startReached={onStartReached}
        atTopStateChange={onAtTopChange}
        scrollerRef={onScrollerRef}
        rangeChanged={({ startIndex, endIndex }) => {
          const first = firstItemIndexRef.current;
          const start = dataIndexFromVirtuoso(startIndex, first);
          const end = dataIndexFromVirtuoso(endIndex, first);
          setRenderedRange((prev) =>
            prev !== null && prev.start === start && prev.end === end
              ? prev
              : { start, end }
          );
        }}
        // 바닥의 여유 (U4-j). 0이면 마지막 행의 자기 여백 몇 픽셀만으로도 「바닥이
        // 아님」이 되어, 아무도 스크롤하지 않았는데 항법 컨트롤이 떴다 사라진다.
        atBottomThreshold={AT_BOTTOM_SLACK_PX}
        atBottomStateChange={(bottom) => {
          setAtBottom(bottom);
          if (bottom) {
            // 바닥에 닿으면 아래에 쌓인 것은 0이다. 「읽음」의 정본은 서버가
            // 가지므로(안읽음 구분선) 여기서는 아무것도 주장하지 않는다.
            baselineRef.current = null;
            setNewCount(0);
            return;
          }
          baselineRef.current = newestSeqRef.current;
          setNewCount(0);
        }}
        firstItemIndex={firstItemIndex}
        // initialItemCount forces a first paint of rows independent of the
        // ResizeObserver measurement pass (in an embedded webview the scroller
        // height can resolve a tick after mount, leaving the list empty).
        initialItemCount={Math.min(items.length, 24)}
        defaultItemHeight={48}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        computeItemKey={(_index, item: FoldedItem) => item.key}
        itemContent={(_index, item: FoldedItem) => {
          if (item.kind === "intro") {
            return (
              <ChannelIntroBlock
                intro={intro}
                empty={empty}
                peer={peer}
                hideWriteAction={showWelcome || welcomeHoldWriteAction}
                onWrite={onStartWriting}
                onAddMember={onAddMember}
                onConnectAgent={onConnectAgent}
              />
            );
          }
          // 「오늘/어제」는 지금이 언제인지를 알아야 나온다 (H-4). 렌더 시각을 그대로
          // 쓰는 것은 `Sidebar`가 이미 하는 것과 같다. 1Hz 시계를 붙이지 않는 이유는
          // 그 시계가 가상 리스트 전체를 초당 한 번 다시 그리기 때문이다 — 하루에 한
          // 번 바뀌는 낱말에 치를 값이 아니다. 자정을 넘겨 열어 둔 채널은 다음
          // 렌더(새 메시지·스크롤·포커스)에 스스로 맞는다.
          if (item.kind === "day") {
            return <DayDivider atMs={item.atMs} nowMs={Date.now()} />;
          }
          if (item.kind === "unread") {
            return (
              <div ref={setDividerEl} data-unread-anchor="">
                <UnreadDivider count={item.count} />
              </div>
            );
          }
          if (item.kind === "recovery") {
            return <RecoveryDivider seq={item.seq} source={item.source} />;
          }
          if (item.kind === "pending") {
            return (
              <PendingRow
                pending={item.pending}
                startsGroup={item.startsGroup}
                serverOffsetMs={serverOffsetMs}
                directory={directory}
                quoteLookup={quoteLookup}
                onResend={onResendPending}
                onDiscard={onDiscardPending}
                failureKind={failureKinds?.get(item.pending.clientMsgId) ?? null}
                resendAllCount={
                  failedPendingIds.length >= 2 &&
                  failedPendingIds[failedPendingIds.length - 1] === item.pending.clientMsgId
                    ? failedPendingIds.length
                    : undefined
                }
                onResendAll={onResendAllPending}
              />
            );
          }
          // 서버가 방에 알리는 중단 줄(#5079)은 누가 한 말이 아니다 — 말풍선이 아니라 가운데의 시스템 줄이고, 반응·답글·행 동작이
          // 하나도 붙지 않는다. 판정은 코어 `isRunCancelledNotice` 하나(폰과 같다).
          if (isSystemLineMessage(item.message)) {
            return <SystemLine message={item.message} clearsToolbarBand />;
          }
          return (
            <MessageRow
              message={item.message}
              startsGroup={item.startsGroup}
              directory={directory}
              unfurls={unfurlsFor(unfurls ?? {}, item.message.id)}
              playEntrance={isPlayEntrance?.(item.message.id) ?? false}
              onEntranceConsumed={
                onEntranceConsumed
                  ? () => onEntranceConsumed(item.message.id)
                  : undefined
              }
              actions={
                actions && {
                  ...actions,
                  chips: chipsFor(
                    reactions ?? {},
                    item.message.id,
                    actions.myMemberId
                  ),
                  pinned: isPinned(pins ?? {}, item.message.id),
                }
              }
              pausedRepeat={item.pausedRepeat}
              deletedRepeat={item.deletedRepeat}
              deletedFoldedIds={item.deletedFoldedIds}
              rollup={rollupFor(item.message, viewingKey !== null && item.message.id.toLowerCase() === viewingKey)}
              onOpenThread={onOpenThread}
              onQuoteMessage={onQuoteMessage}
              onJumpToMessage={onJumpToMessage}
              quoteLookup={quoteLookup}
              aboveMessageId={aboveIds.get(item.message.id.toLowerCase())}
              onOpenWorkSession={onOpenWorkSession}
              onResend={onResend}
              runEnded={isStreamRunEnded(item.message, endedRuns)}
              runStatus={runStatusFor(item.message)}
              showThought={channelKind === "dm" && peer?.kind === "agent"}
            />
          );
        }}
      />
      </TimelineTailContext.Provider>
      {showJumpUnread && (
        <UnreadPillDock side="top">
          <UnreadPill
            direction="up"
            testId="jump-unread"
            count={unreadJumpCount}
            label={jumpUnreadLabel(unreadJumpCount)}
            accessibleLabel={jumpUnreadAriaLabel(unreadJumpCount)}
            onClick={jumpToUnread}
          />
        </UnreadPillDock>
      )}
      {!atBottom && showJumpLatest && (
        // 컨트롤은 떠 있고 그 아래 타임라인은 계속 눌린다: 감싼 상자는 클릭을
        // 통과시키고 버튼만 받는다. 그러지 않으면 이 줄이 덮은 폭만큼 마지막
        // 메시지가 눌리지 않는 띠가 된다.
        <UnreadPillDock side="bottom">
          <UnreadPill
            direction="down"
            testId="jump-latest"
            count={newCount}
            label={jumpLatestLabel(newCount)}
            accessibleLabel={jumpLatestAriaLabel(newCount)}
            onClick={jumpToLatest}
          />
        </UnreadPillDock>
      )}
      </TimelineLiveRegionProvider>
    </div>
  );
}

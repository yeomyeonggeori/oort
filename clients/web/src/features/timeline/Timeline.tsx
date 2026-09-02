import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  threadRollup,
  type Channel,
  type Message,
  type RosterMember,
} from "@momo/core/lib/api";
import { prefersReducedMotion } from "@/app/sidebarPane";
import type { Directory } from "@/features/workspace/useWorkspace";
import type { OpenWorkSession } from "@/features/work/openWorkSession";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  buildTimelineItems,
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
import {
  foldDeletedRuns,
  type DeletedFoldFields,
} from "@momo/core/features/timeline/deletedFold";
import { isStreamRunEnded } from "@momo/core/features/timeline/streamStop";
import { useEndedRuns } from "@/features/agents/endedRuns";
import {
  DayDivider,
  MessageRow,
  RecoveryDivider,
  UnreadDivider,
  type MessageRowActions,
} from "./MessageRow";
import { TimelineLiveRegionProvider } from "./timelineLiveRegion";
import { PendingRow } from "./PendingRow";
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

/**
 * 이 목록이 그리는 항목. 코어 스트림에 삭제 접기의 두 필드가 얹힌 것이다
 * (`deletedFold.ts`) — 접기는 그리는 순간에만 일어나고 메시지 배열도 seq도
 * 커서도 그것을 모른다.
 */
type FoldedItem = (TimelineItem & DeletedFoldFields) | ChannelIntroItem;

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
// `followOutput="auto"`와의 계약: 바닥에 있으면 virtuoso가 스스로 따라가므로
// 아래 컨트롤은 아예 뜨지 않는다. 읽던 중(바닥이 아닌 상태)에는 화면이
// **움직이지 않아야** 하고 — 읽던 줄이 밀려나는 것은 새 메시지가 저지를 수 있는
// 가장 나쁜 일이다 — 대신 아래에 몇 개가 쌓였는지를 이 줄이 말한다. 그 산수는
// 조용히 틀릴 수 있어서 따로 산다: `navigation.ts`.

export function Timeline({
  messages,
  directory,
  status,
  channelKind,
  peer,
  lastReadSeq,
  unreadCount,
  recoveryMarkers,
  pending,
  actions,
  reactions,
  pins,
  unfurls,
  onStartReached,
  onRetry,
  onOpenThread,
  onQuoteMessage,
  onJumpToMessage,
  jumpHandleRef,
  onOpenWorkSession,
  onResend,
  onResendPending,
  onAddMember,
  onStartWriting,
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
  lastReadSeq?: number | null;
  unreadCount?: number;
  recoveryMarkers?: RecoveryMarker[];
  /** Local echoes awaiting their seq; folded in at the tail (M10). */
  pending?: PendingMessage[];
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
  /**
   * 이 채널에 워크스페이스 멤버를 넣는다. 빈 채널의 보조 행동 (#1536). 이름이
   * 초대가 아니라 추가인 이유는 코어 라벨 상수의 머리말 (#1573): 이 손잡이가
   * 여는 것은 「멤버 추가」 다이얼로그이고, 초대는 워크스페이스의 낱말이다.
   */
  onAddMember?: () => void;
  /**
   * Put the caret in the composer. 빈 채널·빈 DM 양쪽의 **첫** 행동이다 —
   * 두 표면이 다른 이유로 비어 있어도 다음에 하는 일은 같다 (#1536).
   */
  onStartWriting?: () => void;
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
    messageCount: messages.length,
  });
  // A local echo counts as content: it must appear under the intro the moment
  // it is sent, not after the server round trip, and it must not remount the
  // list (that remount was the empty-state layout shift).
  const empty =
    messages.length === 0 && (pending === undefined || pending.length === 0);
  const intro = useMemo(
    () =>
      buildChannelIntro({
        kind: channelKind,
        name: channelName ?? "",
        topic: channelTopic,
        peer: peer ?? null,
        canAddMember: Boolean(canAddMember) && channelKind !== "dm",
        empty,
      }),
    [channelKind, channelName, channelTopic, peer, canAddMember, empty]
  );

  const items = useMemo(() => {
    const folded = foldDeletedRuns(
      buildTimelineItems(messages, {
        lastReadSeq,
        unreadCount,
        recoveryMarkers,
        pending,
      }),
      (item) => ({
        hasRollup: threadRollup(item.message) !== null,
        hasReactions:
          chipsFor(reactions ?? {}, item.message.id, myMemberIdForFold)
            .length > 0,
      })
    );
    return showIntro ? [CHANNEL_INTRO_ITEM, ...folded] : folded;
  }, [
    messages,
    lastReadSeq,
    unreadCount,
    recoveryMarkers,
    pending,
    reactions,
    myMemberIdForFold,
    showIntro,
  ]);

  // ADR-0155 — 끝난 것을 **본** run 들. 여기서 한 번 구독하고 행에는 boolean 하나만
  // 내려 보낸다. 행마다 구독하면 아무 run 이나 끝날 때 화면의 모든 줄이 다시 그려지고,
  // 이 목록은 가상화되어 있어서 그 비용이 바로 스크롤로 나온다.
  const endedRuns = useEndedRuns();

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

  const onScrollerRef = useCallback((node: HTMLElement | Window | null) => {
    setScrollerEl(node instanceof HTMLElement ? node : null);
  }, []);

  if (status === "error") {
    return (
      <InlineBanner
        message="이 구간을 불러오지 못했습니다."
        actionLabel="다시 시도"
        onAction={() => onRetry?.()}
        testId="timeline-error"
      />
    );
  }

  if (status === "loading" && empty) {
    return <SkeletonRows rows={6} className="p-4" />;
  }

  return (
    // `relative`는 아래 항법 컨트롤이 붙을 자리다. 컨트롤이 타임라인 **안**에
    // 사는 이유: 그 줄이 가리키는 곳도, 눌렀을 때 움직이는 것도 이 스크롤러다.
    <div className="relative h-full">
      <TimelineLiveRegionProvider>
      <Virtuoso
        key={epoch}
        ref={ref}
        // `overscroll-contain` (goal B9): 목록 끝에 닿은 뒤 한 번 더 미는 손가락이
        // 브라우저에게 넘어가지 않는다. 넘어가면 안드로이드 크롬은 pull-to-refresh로
        // 페이지를 다시 읽고 iOS는 화면 전체를 고무줄처럼 끌어당긴다 — 타임라인 맨
        // 위에서 더 당기는 몸짓의 뜻은 언제나 "더 옛날 것"이지 "앱을 다시 열기"가
        // 아니다. `none`이 아닌 이유는 고무줄 자체는 남겨야 화면이 살아 있게
        // 느껴지기 때문이다.
        className="overscroll-contain h-full"
        data={items}
        data-testid="timeline-virtuoso"
        alignToBottom
        followOutput="auto"
        startReached={onStartReached}
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
                onWrite={onStartWriting}
                onAddMember={onAddMember}
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
                directory={directory}
                quoteLookup={quoteLookup}
                onResend={onResendPending}
              />
            );
          }
          return (
            <MessageRow
              message={item.message}
              startsGroup={item.startsGroup}
              directory={directory}
              unfurls={unfurlsFor(unfurls ?? {}, item.message.id)}
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
              onOpenThread={onOpenThread}
              onQuoteMessage={onQuoteMessage}
              onJumpToMessage={onJumpToMessage}
              quoteLookup={quoteLookup}
              onOpenWorkSession={onOpenWorkSession}
              onResend={onResend}
              runEnded={isStreamRunEnded(item.message, endedRuns)}
            />
          );
        }}
      />
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
      {!atBottom && (
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

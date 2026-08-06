import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  threadRollup,
  type Channel,
  type Message,
  type RosterMember,
} from "@momo/core/lib/api";
import type { Directory } from "@/features/workspace/useWorkspace";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { Button } from "@/design/ui/button";
import {
  buildTimelineItems,
  emptyChannelCopy,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineItem,
} from "@momo/core/features/timeline/model";
import {
  foldDeletedRuns,
  type DeletedFoldFields,
} from "@momo/core/features/timeline/deletedFold";
import {
  DayDivider,
  MessageRow,
  RecoveryDivider,
  UnreadDivider,
  type MessageRowActions,
} from "./MessageRow";
import { PendingRow } from "./PendingRow";
import { chipsFor, type ReactionMap } from "@momo/core/features/timeline/reactions";
import {
  AT_BOTTOM_SLACK_PX,
  countNewerThan,
  newestSeqOf,
} from "./navigation";

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
type FoldedItem = TimelineItem & DeletedFoldFields;

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

interface AnchorState {
  /** Identity of the stream this index was computed for. */
  items: FoldedItem[];
  firstItemIndex: number;
  /** Bumped when the stream is replaced, to remount instead of shifting. */
  epoch: number;
}

// ---- 항법 (U4-j · 진단 M-9) --------------------------------------------------
//
// 진단이 실측한 것: `ref`는 선언되고 전달만 될 뿐 **한 번도 역참조되지 않았다**.
// 위로 올라가 읽다가 현재로 돌아오려면 손으로 끝까지 밀어야 했다.
//
// 두 컨트롤이 아니라 **한 컨트롤의 두 문장**이다. 자리도 같고 하는 일도 같다
// (맨 아래로 간다). 다른 것은 그 사이에 새 메시지가 왔는가뿐이고, 그것을 아는
// 사람에게 두 개의 버튼을 세우면 같은 자리에서 두 번 고르게 만드는 일이 된다.
//
// `followOutput="auto"`와의 계약: 바닥에 있으면 virtuoso가 스스로 따라가므로
// 이 컨트롤은 아예 뜨지 않는다. 읽던 중(바닥이 아닌 상태)에는 화면이 **움직이지
// 않아야** 하고 — 읽던 줄이 밀려나는 것은 새 메시지가 저지를 수 있는 가장 나쁜
// 일이다 — 대신 아래에 몇 개가 쌓였는지를 이 줄이 말한다. 그 산수는 조용히
// 틀릴 수 있어서 따로 산다: `navigation.ts`.

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
  onStartReached,
  onRetry,
  onOpenThread,
  onQuoteMessage,
  onJumpToMessage,
  onOpenWorkSession,
  onResend,
  onResendPending,
  onInviteMember,
  onStartWriting,
}: {
  messages: Message[];
  directory: Directory;
  status: "loading" | "ready" | "error";
  /** Decides what "empty" means here: a channel gains members, a DM cannot. */
  channelKind?: Channel["kind"];
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
  actions?: Omit<MessageRowActions, "chips">;
  reactions?: ReactionMap;
  onStartReached?: () => void;
  onRetry?: () => void;
  onOpenThread?: (message: Message) => void;
  /** ADR-0148 - pin a row to the composer as a quote. */
  onQuoteMessage?: (message: Message) => void;
  /** Jump to a quoted original (the channel surface's existing anchor watcher). */
  onJumpToMessage?: (messageId: string, seq: number | null) => void;
  onOpenWorkSession?: (sessionId: string) => void;
  onResend?: (message: Message) => Promise<void> | void;
  onResendPending?: (clientMsgId: string) => Promise<void> | void;
  onInviteMember?: () => void;
  /** Put the caret in the composer: the only next step an empty DM has. */
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
  const items = useMemo(
    () =>
      foldDeletedRuns(
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
      ),
    [
      messages,
      lastReadSeq,
      unreadCount,
      recoveryMarkers,
      pending,
      reactions,
      myMemberIdForFold,
    ]
  );

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

  // 채널을 갈아타면 기준선도 버린다. `epoch`가 바뀌는 것이 곧 「다른 대화」다.
  useEffect(() => {
    baselineRef.current = null;
    setNewCount(0);
    setAtBottom(true);
  }, [epoch]);

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

  // A local echo counts as content: the first message in an empty channel must
  // appear the moment it is sent, not after the server round trip finishes.
  const empty = messages.length === 0 && items.length === 0;

  if (status === "loading" && empty) {
    return <SkeletonRows rows={6} className="p-4" />;
  }

  if (status === "ready" && empty) {
    const copy = emptyChannelCopy(channelKind, peer ?? null);
    return (
      <EmptyInvite
        headline={copy.headline}
        detail={copy.detail}
        actions={
          // One action, because there is one act. Adding an agent is not a
          // second, lesser door beside adding a person (R-1 §3): they are the
          // same invite, so two buttons on one handler said nothing twice.
          copy.invitable ? (
            <Button size="sm" variant="outline" onClick={onInviteMember}>
              멤버 초대하기
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onStartWriting}>
              첫 메시지 쓰기
            </Button>
          )
        }
        testId="timeline-empty"
        dataAttrs={{ "data-empty-kind": copy.invitable ? "channel" : "dm" }}
      />
    );
  }

  return (
    // `relative`는 아래 항법 컨트롤이 붙을 자리다. 컨트롤이 타임라인 **안**에
    // 사는 이유: 그 줄이 가리키는 곳도, 눌렀을 때 움직이는 것도 이 스크롤러다.
    <div className="relative h-full">
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
          // 「오늘/어제」는 지금이 언제인지를 알아야 나온다 (H-4). 렌더 시각을 그대로
          // 쓰는 것은 `Sidebar`가 이미 하는 것과 같다. 1Hz 시계를 붙이지 않는 이유는
          // 그 시계가 가상 리스트 전체를 초당 한 번 다시 그리기 때문이다 — 하루에 한
          // 번 바뀌는 낱말에 치를 값이 아니다. 자정을 넘겨 열어 둔 채널은 다음
          // 렌더(새 메시지·스크롤·포커스)에 스스로 맞는다.
          if (item.kind === "day") {
            return <DayDivider atMs={item.atMs} nowMs={Date.now()} />;
          }
          if (item.kind === "unread") return <UnreadDivider count={item.count} />;
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
              actions={
                actions && {
                  ...actions,
                  chips: chipsFor(
                    reactions ?? {},
                    item.message.id,
                    actions.myMemberId
                  ),
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
            />
          );
        }}
      />
      {!atBottom && (
        // 컨트롤은 떠 있고 그 아래 타임라인은 계속 눌린다: 감싼 상자는 클릭을
        // 통과시키고 버튼만 받는다. 그러지 않으면 이 줄이 덮은 폭만큼 마지막
        // 메시지가 눌리지 않는 띠가 된다.
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <button
            type="button"
            data-testid="jump-latest"
            data-new-count={newCount}
            onClick={() => {
              ref.current?.scrollToIndex({
                index: "LAST",
                align: "end",
                // 움직임은 피드백이다: 어디로 가는지가 보여야 「맨 아래로
                // 뛰었다」가 읽힌다. 그것을 원하지 않는다고 말한 사람에게는
                // 즉시 도착한다 — 목적지는 같고 가는 길만 다르다.
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                  .matches
                  ? "auto"
                  : "smooth",
              });
            }}
            className="pointer-events-auto flex h-control-sm items-center gap-2 rounded-sm border border-line-strong bg-surface-raised px-3 text-meta text-ink hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <ArrowDown className="size-4 shrink-0" aria-hidden="true" />
            {/* 라벨은 **한 조각**이다. 조각을 나누어 flex의 자식으로 두면 `gap-2`가
                낱말 사이에도 8px씩 들어가 「새 메시지  1  개 보기」가 된다 — 같은
                레포가 구분선에서 이미 겪은 「7월  29일」과 같은 종류의 벌어짐이다. */}
            <span>
              {newCount > 0 ? (
                // 안읽음 구분선과 **같은 낱말**을 쓴다(코어 `unreadDividerSegments`:
                // 「새 메시지 N개, 여기까지 읽음」). 같은 것을 가리키는 두 자리가
                // 서로 다른 이름을 쓰면 읽는 사람이 그 둘을 대조해야 한다.
                <>
                  새 메시지 <span data-numeric>{newCount}</span>개 보기
                </>
              ) : (
                "최신 메시지로 이동"
              )}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

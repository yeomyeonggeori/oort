import {
  Clock,
  Copy,
  EllipsisVertical,
  Link,
  Mail,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  Quote,
  SmilePlus,
  Trash2,
} from "lucide-react";
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { cn } from "@/design/lib/cn";
import {
  recordEmojiUse,
  useFrequentEmojis,
} from "@/features/emoji/frequencyStore";
import {
  closestToolbarScrollContainer,
  HOVER_TOOLBAR_REACTION_SEED,
  HOVER_TOOLBAR_NUDGE_VAR,
  HOVER_TOOLBAR_SLIDE_VAR,
  HOVER_TOOLBAR_SLOT_COUNT,
  neighborTextRects,
  placeToolbar,
  toolbarNeighbors,
} from "./hoverToolbarModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/design/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { Button } from "@/design/ui/button";
import { Tooltip } from "@/design/ui/tooltip";
import { useEscapeLayer } from "@/design/ui/escapeLayer";

// =============================================================================
// The message action surfaces (B11, hover toolbar reintroduced #1743).
//
// One set of actions, three summons, split by **what the input device can do**
// rather than by how wide the window is:
//
//   * **a pointer that can hover** - on row hover or focus-within, a floating
//     toolbar straddles the top-right (16px gutter, no own-row body overlap):
//     frequency slots, React, Reply, a pencil on **my** messages (#5326, owner
//     2026-11-05: people could not find 고치기), and ⋯. Right-click still opens
//     the same inventory at the pointer. A text selection yields to the
//     browser's native menu and unmounts the toolbar so a drag is not stolen.
//     Edit stays the first row of the overflow menu too; Delete is menu-only.
//
//     R1 shipped a six-button bar and failed twice: `opacity-0` hides a button
//     from the eye but not from Tab (up to ~150 tab stops in a virtualized
//     list), and skill §6 used to forbid a visible button row. The 2026-08-24
//     reintroduction is the two conditions that close those failures: the
//     toolbar DOM is not mounted on a row that is not hovered, not focused,
//     and has no open overlay (no opacity/visibility trick), and the toolbar
//     is a WAI-ARIA toolbar whose items join the row's one roving group so
//     it adds at most one tab stop. Open popover/menu keeps it mounted
//     because focus then lives in a portal.
//
//   * **a finger** - a long press opens a bottom sheet, every row 44px. Hover
//     does not exist on a touch screen, so the toolbar is not rendered there
//     at all. A control that no gesture can reach is worse than no control,
//     and the width it would take is width the message text gets to keep.
//     The sheet does not grow a frequency row (out of scope).
//
// The axis is `(hover: none)`, not a breakpoint. R1 keyed the bar to width and
// the long press to `pointerType`, so a mouse in a 500px window had a bar that
// CSS had hidden and a long press that never armed for it: no path to any
// action at all (R2 M2). Keyed to the pointer, the two halves cannot disagree.
//
// Which actions appear is decided upstream by the pure predicates in `model.ts`
// (`canEditMessage`, …) - the server is the authority and answers 403 anyway,
// so these are affordances, not access control.
// =============================================================================

import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import {
  actionKeepsMenuOpen,
  messageActionGroups,
  messageActionItemsForSurface,
  messageToolbarItems,
  type MessageActionCopyState,
  type MessageActionItem,
  type MessageActionItemKey,
} from "./messageActionModel";

export interface MessageActionCallbacks {
  onReply: () => void;
  /**
   * ADR-0148 - pin this message to the composer as a quote. A different action
   * from `onReply` because they are different devices: 답글 moves the
   * conversation aside into a thread, 인용 keeps it in the channel's main flow
   * and drags the context along. Sharing one menu item would put the ADR's two
   * devices back together in the only place the reader can see them.
   */
  onQuote: () => void;
  /** Copy the author's raw markdown, never the rendered HTML. */
  onCopy: () => void;
  /** Copy the HashRouter URL that ChatShell already reads (`?msg=`). */
  onCopyLink: () => void;
  onReact: (emoji: string) => void;
  /**
   * 이슈 #1112 - pin this message to the channel, or take the pin back down.
   * One callback for both directions because the row already knows which way it
   * is going (`pinned` below): a second callback would let the label and the
   * request disagree.
   */
  onPin: () => void;
  /** ADR-0175 — open the later-reminder dialog for this row. */
  onRemind: () => void;
  /** ADR-0178 — mark this channel unread from this message's seq. */
  onMarkUnread?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * 아이콘은 Lucide 기존 글리프만이다(새로 그리지 않는다, README §2.8). 뜻에 맞춰 고른 이유(#5192):
 *   react-more   SmilePlus  「더하기」가 모양에 있다(Buzz와 같다). 그냥 웃는 얼굴은 상태 표시처럼 읽힌다.
 *   reply        MessageSquareReply  답글은 옆 판(스레드)을 여는 일이라 말풍선+화살표다. 인용(Quote)과 모양이 안 겹친다.
 *   quote        Quote  인용부호 그대로.
 *   pin          Pin / PinOff  고정 / 고정 풀기.
 *   remind       Clock  「나중에」는 시각의 이야기다(README §2.8: 시각 = Clock, Buzz도 시계). Bell은 이미 알림 켜고 끄기
 *                (채널 음소거·스레드 따라가기)가 쓰고 있어 「나중에 알림」이 그것과 섞인다.
 *   mark-unread  Mail  닫힌 봉투 = 안 읽음(메일 문법). BT-6이 정하고 `markUnread.entry.test.ts`가 못 박은 읽음 상태 문법이다
 *                (숨김을 뜻하는 눈 아이콘이 아니다). 이 이슈는 바꾸지 않았다: Buzz의 열린 봉투는 「읽음」으로 읽혀 따르지 않았다.
 *   copy / copy-link  Copy / Link  (Buzz와 같다)
 *   edit / delete     Pencil / Trash2
 * 크기는 16(`size-4`)이 앱 단일 기본이다(README §2.8).
 */
function actionIcon(item: MessageActionItem, pinned: boolean) {
  if (item.key.startsWith("react:")) return null;
  switch (item.key) {
    case "react-more":
      return <SmilePlus className="size-4" aria-hidden="true" />;
    case "reply":
      return <MessageSquareReply className="size-4" aria-hidden="true" />;
    case "quote":
      return <Quote className="size-4" aria-hidden="true" />;
    case "copy":
      return <Copy className="size-4" aria-hidden="true" />;
    case "copy-link":
      return <Link className="size-4" aria-hidden="true" />;
    case "pin":
      return pinned ? (
        <PinOff className="size-4" aria-hidden="true" />
      ) : (
        <Pin className="size-4" aria-hidden="true" />
      );
    case "remind":
      return <Clock className="size-4" aria-hidden="true" />;
    case "mark-unread":
      return <Mail className="size-4" aria-hidden="true" />;
    case "edit":
      return <Pencil className="size-4" aria-hidden="true" />;
    case "delete":
      return <Trash2 className="size-4" aria-hidden="true" />;
  }
}

function invokeAction(
  key: MessageActionItemKey,
  callbacks: MessageActionCallbacks,
  onOpenPicker: (opener?: HTMLElement | null) => void
) {
  if (key.startsWith("react:")) {
    callbacks.onReact(key.slice("react:".length));
    return;
  }
  switch (key) {
    case "react-more":
      onOpenPicker();
      return;
    case "reply":
      callbacks.onReply();
      return;
    case "quote":
      callbacks.onQuote();
      return;
    case "copy":
      callbacks.onCopy();
      return;
    case "copy-link":
      callbacks.onCopyLink();
      return;
    case "pin":
      callbacks.onPin();
      return;
    case "remind":
      callbacks.onRemind();
      return;
    case "mark-unread":
      callbacks.onMarkUnread?.();
      return;
    case "edit":
      callbacks.onEdit();
      return;
    case "delete":
      callbacks.onDelete();
  }
}

function ActionMenuItem({
  surface,
  prefix,
  item,
  pinned,
  callbacks,
  onOpenPicker,
}: {
  surface: "dropdown" | "context";
  prefix: "menu" | "context";
  item: MessageActionItem;
  pinned: boolean;
  callbacks: MessageActionCallbacks;
  onOpenPicker: (opener?: HTMLElement | null) => void;
}) {
  const props = {
    "data-testid": `${prefix}-${item.testKey}`,
    "aria-label": item.accessibleLabel,
    tone: item.tone,
    onSelect: (event: Event) => {
      // Copy receipts only work while the row stays visible: the label flips in
      // place (「복사됨」), so the menu has to stay open for the person to read it.
      if (actionKeepsMenuOpen(item.key)) event.preventDefault();
      invokeAction(item.key, callbacks, onOpenPicker);
    },
    children: (
      <>
        {actionIcon(item, pinned)}
        {item.label}
      </>
    ),
  };
  return surface === "dropdown" ? (
    <DropdownMenuItem {...props} />
  ) : (
    <ContextMenuItem {...props} />
  );
}

function ActionMenuSeparator({ surface }: { surface: "dropdown" | "context" }) {
  return surface === "dropdown" ? (
    <DropdownMenuSeparator />
  ) : (
    <ContextMenuSeparator />
  );
}

/**
 * ⋯ 와 우클릭이 같이 그리는 목록 (#5192). 반응·답글은 도구 막대가 직접 보여 주므로 여기서 되풀이하지 않는다(Buzz). 같은
 * 묶음끼리 모으고 묶음 사이에 구분선을 긋는다. 지우기는 마지막 묶음의 맨 아래다.
 */
function MessageActionMenuItems({
  surface,
  prefix,
  available,
  copyState,
  callbacks,
  onOpenPicker,
}: {
  surface: "dropdown" | "context";
  prefix: "menu" | "context";
  available: MessageActionAvailability;
  copyState: MessageActionCopyState;
  callbacks: MessageActionCallbacks;
  onOpenPicker: (opener?: HTMLElement | null) => void;
}) {
  const groups = messageActionGroups(
    messageActionItemsForSurface(
      surface === "dropdown" ? "menu" : "context",
      available,
      copyState
    )
  );
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group[0].group}>
          {index > 0 && <ActionMenuSeparator surface={surface} />}
          {group.map((item) => (
            <ActionMenuItem
              key={item.key}
              surface={surface}
              prefix={prefix}
              item={item}
              pinned={copyState.pinned}
              callbacks={callbacks}
              onOpenPicker={onOpenPicker}
            />
          ))}
        </Fragment>
      ))}
    </>
  );
}

/**
 * 줄 도구 막대의 모양 (#4324, Buzz 수준). 클래스를 이 파일의 최상위 문자열로 두는 이유는
 * 눌림 원장·층 시험이 같은 파일의 문자열을 읽고, `rowSurface.browser.test.ts`가 이 상수를 그대로
 * 엔진에 먹여 계산된 값(32px 원·16 아이콘·20 이모지·막대 안쪽 4·단추 사이 2)을 재기 때문이다.
 */
/** 알약 막대: 완전한 둥글기, 안쪽 4, 단추 사이 2, 재료는 `toolbar-float`(옅은 테두리·반투명·블러·옅은 그림자). */
export const TOOLBAR_CLASS =
  "absolute right-3 layer-content-float flex select-none items-center gap-toolbar rounded-full p-1 toolbar-float motion-fast-enter motion-reduce:animate-none";
/** 오른쪽 12는 줄 안쪽 여백(`px-3`)과 같아 막대 오른끝이 본문 글자 끝과 맞는다. */
export const toolbarItemClass =
  "flex size-control items-center justify-center rounded-full text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring";
/**
 * 빠른 반응 이모지: 글리프 20px. 내가 남긴 반응도 바탕을 칠하지 않는다(owner 2026-10-31, #4879):
 * 달린 반응은 아래 칩 줄(`ReactionChips`)이 말하고, 이 막대는 보조 기술에 `aria-pressed`와
 * 「반응 취소」 라벨로 같은 상태를 말한다.
 */
export const toolbarReactionClass =
  "flex size-control items-center justify-center rounded-full reaction-glyph press focus-visible:focus-ring";
/** 반응과 행동 사이 세로 구분선(1×16). */
export const toolbarDividerClass = "mx-1 h-4 w-px bg-line";
const toolbarIconClass = "size-4";

/**
 * Floating hover/focus toolbar. The parent decides whether this is mounted;
 * this component never hides itself with opacity or visibility.
 *
 * Custom rather than a Radix Toolbar: that primitive is not vendored, and a
 * row-local toolbar has to join the row's existing roving group (`data-row-action`)
 * so ←/→ can enter and leave it (#1743 M-2). Hover must not call `focus()`; the
 * pointer highlight is CSS only (UX-EB cursor split).
 *
 * Placement straddles the row's top edge (`hover-toolbar-straddle`) and keeps
 * the same 16px right gutter as the body (`right-4`). When that would clip the
 * nearest scroll-container top, it mirrors to the row's bottom edge
 * (`hover-toolbar-straddle-below`, #1743 H-4). It mirrors the same way when the
 * top edge would cover the previous neighbour's text and the bottom edge would
 * cover none of the next neighbour's (#5179, `shouldFlipToolbarBelow`). When both
 * edges are blocked it slides down into the first text-free window of the row
 * (#5179, `slideToolbarDown`). A line end that grazes the toolbar's left edge by
 * 1-2px is dodged by nudging the bar right (#5179). Own-row body text must not
 * intersect the toolbar box (B11 R2 Blocker / #1743 B-3).
 */
export function MessageHoverToolbar({
  available,
  copyState,
  callbacks,
  onOpenPicker,
  menuOpen,
  onMenuOpenChange,
  triggerRef,
  mineEmojis,
}: {
  available: MessageActionAvailability;
  copyState: MessageActionCopyState;
  callbacks: MessageActionCallbacks;
  onOpenPicker: (opener?: HTMLElement | null) => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** Surviving ⋯ trigger used as the reaction picker fallback anchor (H-4). */
  triggerRef?: Ref<HTMLButtonElement>;
  mineEmojis: ReadonlySet<string>;
}) {
  useEscapeLayer(menuOpen, () => onMenuOpenChange(false));
  const barRef = useRef<HTMLDivElement>(null);
  const [straddleBelow, setStraddleBelow] = useState(false);
  const liveSlots = useFrequentEmojis(
    HOVER_TOOLBAR_REACTION_SEED,
    HOVER_TOOLBAR_SLOT_COUNT
  );
  // Freeze rank for the life of this mount (focus on a slot can keep the
  // mount alive). A click must not rearrange the glyph under the cursor;
  // the next unmount+mount picks up the new order (#1743 H-2). aria-pressed
  // still follows live `mineEmojis`.
  const [slots] = useState(liveSlots);
  // 설 쪽은 마운트 때 한 번 잰다(열린 메뉴가 막대를 붙들고 있는 동안 자리가 옮겨 다니지 않는다). 스크롤러를 못 찾으면 — 레이아웃을 못
  // 재는 jsdom 시험이 그렇다 — 이웃 글자에는 손도 대지 않는다. 규칙은 `hoverToolbarModel.placeToolbar`(#5179): 아래 경계로 뒤집거나, 위·아래가 모두
  // 글자에 막히면 위 자리에서 아래로 밀어 행 안쪽의 빈 창에 앉힌다(밀림은 CSS 변수로 건다 — 인라인 style 속성은 CSP가 막는다).
  useLayoutEffect(() => {
    if (straddleBelow) return;
    const bar = barRef.current;
    if (!bar) return;
    const scroller = closestToolbarScrollContainer(bar);
    if (!scroller) return;
    const row = bar.closest('[data-testid="timeline-message"]');
    const neighbors = row ? toolbarNeighbors(row, scroller) : null;
    const placement = placeToolbar({
      bar: bar.getBoundingClientRect(),
      row: row ? row.getBoundingClientRect() : null,
      scroller: scroller.getBoundingClientRect(),
      prevText: () => neighborTextRects(neighbors?.prev ?? null),
      selfText: () => neighborTextRects(row),
      nextText: () => neighborTextRects(neighbors?.next ?? null),
    });
    // 비껴 서기(가로 1~2px)는 위·아래 어느 자리에서도 같다. 변수는 막대 요소에 걸려 자리 이름이 바뀌어도(`straddleBelow`) 남는다.
    if (placement.nudge > 0) bar.style.setProperty(HOVER_TOOLBAR_NUDGE_VAR, String(placement.nudge));
    if (placement.below) setStraddleBelow(true);
    else if (placement.slide > 0) {
      bar.style.setProperty(HOVER_TOOLBAR_SLIDE_VAR, String(Number(placement.slide.toFixed(2))));
    }
  }, [straddleBelow]);
  // 도구 막대의 단추는 모델의 표가 정한다(`MESSAGE_ACTION_GROUP_PLACEMENT`): 표와 화면이 따로 놀지 않는다.
  const toolbarItems = messageToolbarItems(available, copyState);
  const hasReact = toolbarItems.some((item) => item.key.startsWith("react:"));
  const hasReactMore = toolbarItems.some((item) => item.key === "react-more");
  const hasReply = toolbarItems.some((item) => item.key === "reply");
  // 도구 막대에도 복사본이 서는 메뉴 항목(`toolbarCopy`): 연필(고치기, #5326) 하나다. 내 메시지에만 선다(`available.edit`가 작성자 문이다).
  // 이름은 메뉴의 같은 항목에서 읽는다: 메뉴의 첫 줄과 같은 낱말이고 이 파일이 낱말을 두 번 적지 않는다.
  const editCopy = toolbarItems.find((item) => item.toolbarCopy === true);
  const hasMenu =
    messageActionItemsForSurface("menu", available, copyState).length > 0;
  if (toolbarItems.length === 0 && !hasMenu) return null;
  // 막대가 행 위 경계에 걸치면 툴팁은 아래로, 아래 경계로 뒤집히면 위로 뜬다(막대가 가린 쪽의 반대).
  const tipSide = straddleBelow ? "top" : "bottom";

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="메시지 액션"
      aria-orientation="horizontal"
      data-testid="message-hover-toolbar"
      data-straddle={straddleBelow ? "below" : "top"}
      className={cn(
        straddleBelow
          ? "hover-toolbar-straddle-below"
          : "hover-toolbar-straddle",
        TOOLBAR_CLASS
      )}
    >
      {hasReact &&
        slots.map((emoji) => {
          const mine = mineEmojis.has(emoji);
          const label = mine ? `${emoji} 반응 취소` : `${emoji} 반응 남기기`;
          return (
            <Tooltip key={emoji} label={label} side={tipSide}>
              <button
                type="button"
                data-toolbar-item=""
                data-row-action=""
                data-testid={`toolbar-react-${emoji}`}
                aria-label={label}
                aria-pressed={mine}
                onClick={() => {
                  recordEmojiUse(emoji);
                  callbacks.onReact(emoji);
                }}
                // 내가 단 이모지도 안 단 것과 같은 모양이다: 바탕색 없음(owner 2026-10-31, #4879).
                className={cn(
                  toolbarReactionClass,
                  "text-ink-muted hover:bg-surface-hover hover:text-ink"
                )}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            </Tooltip>
          );
        })}
      {hasReact && (hasReactMore || hasReply) && (
        <div className={toolbarDividerClass} aria-hidden="true" />
      )}
      {hasReactMore && (
        <Tooltip label="다른 반응 고르기" side={tipSide}>
          <button
            type="button"
            data-toolbar-item=""
            data-row-action=""
            data-testid="toolbar-react-more"
            aria-label="다른 반응 고르기"
            onClick={(event) => onOpenPicker(event.currentTarget)}
            className={toolbarItemClass}
          >
            <SmilePlus className={toolbarIconClass} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      {hasReply && (
        <Tooltip label="답글 달기" side={tipSide}>
          <button
            type="button"
            data-toolbar-item=""
            data-row-action=""
            data-testid="toolbar-reply"
            aria-label="답글 달기"
            onClick={() => callbacks.onReply()}
            className={toolbarItemClass}
          >
            <MessageSquareReply
              className={toolbarIconClass}
              aria-hidden="true"
            />
          </button>
        </Tooltip>
      )}
      {editCopy && (
        <Tooltip label={editCopy.label} side={tipSide}>
          <button
            type="button"
            data-toolbar-item=""
            data-row-action=""
            data-testid="toolbar-edit"
            aria-label={editCopy.label}
            onClick={() => callbacks.onEdit()}
            className={toolbarItemClass}
          >
            <Pencil className={toolbarIconClass} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      {hasMenu && (
        <DropdownMenu
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          modal={false}
        >
          <Tooltip label="더 많은 액션" side={tipSide} align="end">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                ref={triggerRef}
                data-toolbar-item=""
                data-testid="message-actions-trigger"
                data-row-action="primary"
                aria-label="더 많은 액션"
                className={cn(
                  toolbarItemClass,
                  "data-[state=open]:bg-surface-hover data-[state=open]:text-ink"
                )}
              >
                <EllipsisVertical
                  className={toolbarIconClass}
                  aria-hidden="true"
                />
              </button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            data-testid="message-action-menu"
            aria-label="메시지 액션"
          >
            <MessageActionMenuItems
              surface="dropdown"
              prefix="menu"
              available={available}
              copyState={copyState}
              callbacks={callbacks}
              onOpenPicker={onOpenPicker}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** The row wrapper that adds the pointer-native right-click summons. */
export function MessageActionContextMenu({
  children,
  enabled,
  available,
  copyState,
  callbacks,
  onOpenPicker,
  onOpenChange,
}: {
  children: React.ReactElement;
  /** False on touch-only hardware and while text in this row is selected. */
  enabled: boolean;
  available: MessageActionAvailability;
  copyState: MessageActionCopyState;
  callbacks: MessageActionCallbacks;
  onOpenPicker: (opener?: HTMLElement | null) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const setMenuOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  useEscapeLayer(open, () => setMenuOpen(false));
  // 반응·답글은 도구 막대의 몫이라 메뉴 목록이 비는 행이 있을 수 있다. 빈 판을 열면 제스처만 쓰고 답이 없다(시트와 같은 규칙).
  const hasMenu =
    messageActionItemsForSurface("context", available, copyState).length > 0;
  return (
    <ContextMenu open={open} onOpenChange={setMenuOpen} modal={false}>
      <ContextMenuTrigger asChild disabled={!enabled || !hasMenu}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        data-testid="message-context-menu"
        aria-label="메시지 액션"
      >
        <MessageActionMenuItems
          surface="context"
          prefix="context"
          available={available}
          copyState={copyState}
          callbacks={callbacks}
          onOpenPicker={onOpenPicker}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** One row of the phone sheet. Full width, 44px tall, label beside the glyph. */
function SheetAction({
  label,
  testId,
  tone,
  onSelect,
  children,
}: {
  label: string;
  testId: string;
  tone?: "danger";
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onSelect}
      className={cn(
        "tap-target flex w-full items-center gap-3 rounded-sm px-3 text-body hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring",
        tone === "danger" ? "text-danger" : "text-ink"
      )}
    >
      {children}
      {label}
    </button>
  );
}

/**
 * The phone sheet, opened by a long press on the row.
 *
 * Anchored to the bottom rather than centred: it is summoned by a thumb and
 * answered by a thumb, and a centred panel puts every choice at the top of a
 * 6-inch screen. Radix keeps focus inside it and Esc closes it, so the sheet is
 * as reachable by an external keyboard as the menu is.
 */
export function MessageActionSheet({
  open,
  onOpenChange,
  preview,
  available,
  copyState,
  callbacks,
  onOpenPicker,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The first line of the message, so the sheet names what it will act on. */
  preview: string;
  available: MessageActionAvailability;
  copyState: MessageActionCopyState;
  callbacks: MessageActionCallbacks;
  onOpenPicker: (opener?: HTMLElement | null) => void;
}) {
  const close = () => onOpenChange(false);
  const items = messageActionItemsForSurface("sheet", available, copyState);
  const quick = items.filter((item) => item.key.startsWith("react:"));
  const more = items.find((item) => item.key === "react-more");
  const regular = items.filter(
    (item) => !item.key.startsWith("react:") && item.key !== "react-more"
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="message-action-sheet"
        // Bottom-anchored sheet: modal zoom would inherit origin-center and
        // lift the panel off the screen edge on the opening frame (UX-R1a M-4).
        className="safe-area-bottom bottom-0 left-0 top-auto max-w-none origin-bottom translate-x-0 gap-2 rounded-lg p-3"
      >
        <DialogTitle className="px-3 pt-1 text-body">메시지 액션</DialogTitle>
        <DialogDescription className="line-clamp-2 px-3 text-meta">
          {preview}
        </DialogDescription>
        {quick.length > 0 && (
          <div className="flex flex-wrap gap-1 px-1 pt-1">
            {quick.map((item) => (
              <button
                key={item.key}
                type="button"
                data-testid={`sheet-${item.testKey}`}
                aria-label={item.accessibleLabel}
                onClick={() => {
                  invokeAction(item.key, callbacks, onOpenPicker);
                  close();
                }}
                className="tap-target flex items-center justify-center rounded-sm text-title press hover:bg-surface-hover focus-visible:focus-ring"
              >
                <span aria-hidden="true">{item.label}</span>
              </button>
            ))}
            {more && (
              <button
                type="button"
                data-testid={`sheet-${more.testKey}`}
                aria-label={more.label}
                onClick={() => {
                  close();
                  invokeAction(more.key, callbacks, onOpenPicker);
                }}
                className="tap-target flex items-center justify-center rounded-sm px-3 text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
              >
                {actionIcon(more, copyState.pinned)}
              </button>
            )}
          </div>
        )}
        {regular.map((item) => (
          <SheetAction
            key={item.key}
            label={item.label}
            testId={`sheet-${item.testKey}`}
            tone={item.tone}
            onSelect={() => {
              // As in the pointer menus, the copy receipt has to remain visible.
              if (!actionKeepsMenuOpen(item.key)) close();
              invokeAction(item.key, callbacks, onOpenPicker);
            }}
          >
            {actionIcon(item, copyState.pinned)}
          </SheetAction>
        ))}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The delete confirmation.
 *
 * A confirmation and not an undo, because the server has no undo: the delete is
 * a tombstone that erases the body, so there is nothing left to restore. Asking
 * once, before, is the only honest shape.
 *
 * Both buttons carry `tap-target`: on a phone this dialog is the last step of a
 * flow that started with a thumb (long press → 지우기), and R1 landed that thumb
 * on 32px controls (R2 H3).
 */
export function DeleteMessageDialog({
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="delete-message-dialog" className="gap-3 p-4">
        <DialogTitle>메시지를 지울까요?</DialogTitle>
        <DialogDescription>
          지운 메시지는 되돌릴 수 없습니다. 자리에는 「삭제된 메시지」가 남고,
          달려 있던 반응도 함께 지워집니다.
        </DialogDescription>
        {/* 두 버튼의 `tap-target`은 이제 Button의 `default` 크기가 준다
            (goal P3 1-4). 같은 유틸리티를 여기서 한 번 더 적는 것은 중복이고,
            44px는 캡처 게이트가 `delete-message-commit`/`-cancel`을 직접 재서
            지킨다. */}
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="secondary"
            data-testid="delete-message-cancel"
            onClick={() => onOpenChange(false)}
          >
            취소
          </Button>
          <Button
            variant="destructive"
            data-testid="delete-message-commit"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "지우는 중…" : "지우기"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

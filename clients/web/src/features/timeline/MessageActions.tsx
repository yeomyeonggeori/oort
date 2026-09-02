import {
  Bell,
  Copy,
  EyeOff,
  Link,
  MessageSquareReply,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Quote,
  Smile,
  Trash2,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { cn } from "@/design/lib/cn";
import {
  recordEmojiUse,
  useFrequentEmojis,
} from "@/features/emoji/frequencyStore";
import {
  closestToolbarScrollContainer,
  HOVER_TOOLBAR_REACTION_SEED,
  HOVER_TOOLBAR_SLOT_COUNT,
  toolbarClipsScrollerTop,
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
import { useEscapeLayer } from "@/design/ui/escapeLayer";

// =============================================================================
// The message action surfaces (B11, hover toolbar reintroduced #1743).
//
// One set of actions, three summons, split by **what the input device can do**
// rather than by how wide the window is:
//
//   * **a pointer that can hover** - on row hover or focus-within, a floating
//     toolbar straddles the top-right (16px gutter, no own-row body overlap):
//     frequency slots, React, Reply, and ⋯. Right-click still opens the same
//     inventory at the pointer. A text selection yields to the browser's
//     native menu and unmounts the toolbar so a drag is not stolen.
//     Edit/Delete stay in the overflow menu.
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
  messageActionItems,
  messageActionItemsForSurface,
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

function actionIcon(item: MessageActionItem, pinned: boolean) {
  if (item.key.startsWith("react:")) return null;
  switch (item.key) {
    case "react-more":
      return <Smile className="size-4" aria-hidden="true" />;
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
      return <Bell className="size-4" aria-hidden="true" />;
    case "mark-unread":
      return <EyeOff className="size-4" aria-hidden="true" />;
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
  compact = false,
}: {
  surface: "dropdown" | "context";
  prefix: "menu" | "context";
  item: MessageActionItem;
  pinned: boolean;
  callbacks: MessageActionCallbacks;
  onOpenPicker: (opener?: HTMLElement | null) => void;
  compact?: boolean;
}) {
  const props = {
    "data-testid": `${prefix}-${item.testKey}`,
    "aria-label": item.accessibleLabel,
    tone: item.tone,
    onSelect: (event: Event) => {
      // Copy receipts only work while the row stays visible. react-more opens
      // a picker anchored to the ⋯ trigger. If Radix closes the menu first,
      // the hover toolbar can unmount (pointer is on the portaled item,
      // outside the row) before setPickerOpen runs, and the popover is left
      // with a detached anchor.
      if (actionKeepsMenuOpen(item.key)) event.preventDefault();
      invokeAction(item.key, callbacks, onOpenPicker);
    },
    className: compact ? "size-control-sm justify-center px-0" : undefined,
    children: (
      <>
        {item.key.startsWith("react:") ? (
          <span aria-hidden="true">{item.label}</span>
        ) : (
          <>
            {actionIcon(item, pinned)}
            {item.label}
          </>
        )}
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
  const items = messageActionItemsForSurface(
    surface === "dropdown" ? "menu" : "context",
    available,
    copyState
  );
  const quick = items.filter((item) => item.key.startsWith("react:"));
  const more = items.find((item) => item.key === "react-more");
  const regular = items.filter(
    (item) => !item.key.startsWith("react:") && item.key !== "react-more"
  );
  return (
    <>
      {quick.length > 0 && (
        <div className="flex items-center gap-px" aria-label="빠른 반응">
          {quick.map((item) => (
            <ActionMenuItem
              key={item.key}
              surface={surface}
              prefix={prefix}
              item={item}
              pinned={copyState.pinned}
              callbacks={callbacks}
              onOpenPicker={onOpenPicker}
              compact
            />
          ))}
        </div>
      )}
      {more && (
        <ActionMenuItem
          surface={surface}
          prefix={prefix}
          item={more}
          pinned={copyState.pinned}
          callbacks={callbacks}
          onOpenPicker={onOpenPicker}
        />
      )}
      {quick.length > 0 && regular.length > 0 && (
        <ActionMenuSeparator surface={surface} />
      )}
      {regular.map((item) => (
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
    </>
  );
}

const toolbarItemClass =
  "flex size-control-sm items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:focus-ring";

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
 * (`hover-toolbar-straddle-below`, #1743 H-4). Own-row body text must not
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
  useLayoutEffect(() => {
    if (straddleBelow) return;
    const bar = barRef.current;
    if (!bar) return;
    const scroller = closestToolbarScrollContainer(bar);
    if (!scroller) return;
    if (
      toolbarClipsScrollerTop(
        bar.getBoundingClientRect(),
        scroller.getBoundingClientRect()
      )
    ) {
      setStraddleBelow(true);
    }
  }, [straddleBelow]);
  const hasMenu = messageActionItems(available, copyState).length > 0;
  if (!available.react && !available.reply && !hasMenu) return null;

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
        "absolute right-4 z-20 flex select-none items-center gap-px rounded-md border border-line-strong bg-surface-raised p-px shadow-lg"
      )}
    >
      {available.react &&
        slots.map((emoji) => {
          const mine = mineEmojis.has(emoji);
          return (
            <button
              key={emoji}
              type="button"
              data-toolbar-item=""
              data-row-action=""
              data-testid={`toolbar-react-${emoji}`}
              aria-label={
                mine ? `${emoji} 반응 취소` : `${emoji} 반응 남기기`
              }
              title={mine ? `${emoji} 반응 취소` : `${emoji} 반응 남기기`}
              aria-pressed={mine}
              onClick={() => {
                recordEmojiUse(emoji);
                callbacks.onReact(emoji);
              }}
              className={cn(
                toolbarItemClass,
                "text-title",
                mine && "bg-accent-soft text-ink"
              )}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          );
        })}
      {available.react && (
        <div className="mx-px h-4 w-px bg-line" aria-hidden="true" />
      )}
      {available.react && (
        <button
          type="button"
          data-toolbar-item=""
          data-row-action=""
          data-testid="toolbar-react-more"
          aria-label="다른 반응 고르기"
          title="다른 반응 고르기"
          onClick={(event) => onOpenPicker(event.currentTarget)}
          className={toolbarItemClass}
        >
          <Smile className="size-4" aria-hidden="true" />
        </button>
      )}
      {available.reply && (
        <button
          type="button"
          data-toolbar-item=""
          data-row-action=""
          data-testid="toolbar-reply"
          aria-label="답글 달기"
          title="답글 달기"
          onClick={() => callbacks.onReply()}
          className={toolbarItemClass}
        >
          <MessageSquareReply className="size-4" aria-hidden="true" />
        </button>
      )}
      {hasMenu && (
        <DropdownMenu
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          modal={false}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              ref={triggerRef}
              data-toolbar-item=""
              data-testid="message-actions-trigger"
              data-row-action="primary"
              aria-label="더 많은 액션"
              title="더 많은 액션"
              className={cn(
                toolbarItemClass,
                "data-[state=open]:bg-surface-hover data-[state=open]:text-ink"
              )}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
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
  return (
    <ContextMenu open={open} onOpenChange={setMenuOpen} modal={false}>
      <ContextMenuTrigger asChild disabled={!enabled}>
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
        "tap-target flex w-full items-center gap-3 rounded-sm px-3 text-body transition-colors hover:bg-surface-hover focus-visible:focus-ring",
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
        className="safe-area-bottom bottom-0 left-0 top-auto max-w-none translate-x-0 gap-2 rounded-lg p-3"
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
                className="tap-target flex items-center justify-center rounded-sm text-title transition-colors hover:bg-surface-hover focus-visible:focus-ring"
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
                className="tap-target flex items-center justify-center rounded-sm px-3 text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring"
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

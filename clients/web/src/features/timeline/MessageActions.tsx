import {
  Copy,
  MessageSquareReply,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Quote,
  Smile,
  Trash2,
} from "lucide-react";
import { useState, type Ref } from "react";
import { cn } from "@/design/lib/cn";
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
// The message action surfaces (B11).
//
// One set of actions, three summons, split by **what the input device can do**
// rather than by how wide the window is:
//
//   * **a pointer that can hover** - a ⋯ trigger appears in the row's own
//     gutter and opens a menu, while right-click opens the same inventory at
//     the pointer. A text selection yields to the browser's native menu. One
//     visible control, therefore one tab stop. R1 shipped a six-button bar and failed
//     twice over: `opacity-0` hides a button from the eye but not from Tab
//     (up to ~150 tab stops between the timeline and the composer in a
//     virtualized list), and skill §6 puts row-level actions in a menu, not in
//     a visible button row. MOMO-626 R1 M8 reverted a change that added ONE tab
//     stop per agent group; this had added six per message.
//   * **a finger** - a long press opens a bottom sheet, every row 44px. Hover
//     does not exist on a touch screen, so the gutter and its trigger are not
//     rendered there at all (tokens.css `pointer-only`): a control that no
//     gesture can reach is worse than no control, and the width it would take
//     is width the message text gets to keep.
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
  messageActionItems,
  messageActionItemsForSurface,
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
  onReact: (emoji: string) => void;
  /**
   * 이슈 #1112 - pin this message to the channel, or take the pin back down.
   * One callback for both directions because the row already knows which way it
   * is going (`pinned` below): a second callback would let the label and the
   * request disagree.
   */
  onPin: () => void;
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
    case "pin":
      return pinned ? (
        <PinOff className="size-4" aria-hidden="true" />
      ) : (
        <Pin className="size-4" aria-hidden="true" />
      );
    case "edit":
      return <Pencil className="size-4" aria-hidden="true" />;
    case "delete":
      return <Trash2 className="size-4" aria-hidden="true" />;
  }
}

function invokeAction(
  key: MessageActionItemKey,
  callbacks: MessageActionCallbacks,
  onOpenPicker: () => void
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
    case "pin":
      callbacks.onPin();
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
  onOpenPicker: () => void;
  compact?: boolean;
}) {
  const props = {
    "data-testid": `${prefix}-${item.testKey}`,
    "aria-label": item.accessibleLabel,
    tone: item.tone,
    onSelect: (event: Event) => {
      // CopyButton's receipt only works while it remains visible. Keep this one
      // row open long enough to become 「복사됨」; every other action dismisses.
      if (item.key === "copy") event.preventDefault();
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
  canCopy,
  copied,
  pinned,
  callbacks,
  onOpenPicker,
}: {
  surface: "dropdown" | "context";
  prefix: "menu" | "context";
  available: MessageActionAvailability;
  canCopy: boolean;
  copied: boolean;
  pinned: boolean;
  callbacks: MessageActionCallbacks;
  onOpenPicker: () => void;
}) {
  const items = messageActionItemsForSurface(
    surface === "dropdown" ? "menu" : "context",
    available,
    { canCopy, copied, pinned }
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
              pinned={pinned}
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
          pinned={pinned}
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
          pinned={pinned}
          callbacks={callbacks}
          onOpenPicker={onOpenPicker}
        />
      ))}
    </>
  );
}

/**
 * The row's action gutter: a reserved 32px column, and inside it the single
 * control that opens everything.
 *
 * **Why a reserved column.** R1 floated the bar over the row with a negative
 * offset (`-top-3` against a 32px bar), which left 20px of it inside the row
 * and covered the first line of the message it belonged to - in a Korean
 * paragraph the first line reaches the right edge almost every time, so the bar
 * covered the text you were reading. Any offset is a bet about line heights.
 * A column is not a bet: text stops where the gutter starts, and the trigger
 * has nothing to overlap. The width is paid on every row of the surface, which
 * is what keeps the right edge of the channel straight.
 *
 * The trigger is `absolute` inside that column so it contributes no height: a
 * 28px control must not make a 24px line into a 28px row.
 */
export function MessageActionColumn({
  available,
  canCopy,
  copied,
  pinned,
  callbacks,
  onOpenPicker,
  hidden,
  triggerRef,
}: {
  available: MessageActionAvailability;
  canCopy: boolean;
  copied: boolean;
  /** 이슈 #1112 - whether this message is currently pinned, which flips the label. */
  pinned: boolean;
  callbacks: MessageActionCallbacks;
  onOpenPicker: () => void;
  /** While the row is being edited the editor owns it (R2 M3). */
  hidden?: boolean;
  /** Surviving ⋯ trigger used as the reaction picker anchor (H-4). */
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  useEscapeLayer(open, () => setOpen(false));
  const hasItems =
    messageActionItems(available, { canCopy, copied, pinned }).length > 0;
  return (
    <div
      data-testid="message-action-column"
      className="pointer-only relative w-control shrink-0"
    >
      {hasItems && !hidden && (
        // `modal={false}`: a row menu is not a mode. Radix's modal branch locks
        // `pointer-events` on the body, which stops the timeline scrolling
        // underneath and fights the confirm dialog that 지우기 opens next.
        <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              ref={triggerRef}
              data-testid="message-actions-trigger"
              // The row's preferred keyboard entry point (see rowFocus.ts):
              // last in DOM order, first in the order someone looks for it.
              data-row-action="primary"
              aria-label="메시지 액션"
              title="메시지 액션"
              className={cn(
                "absolute right-0 top-0 flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-opacity",
                "hover:bg-surface-hover hover:text-ink focus-visible:focus-ring",
                // Invisible and un-clickable until the row is under the pointer
                // or holds focus. `pointer-events-none` matters: an invisible
                // button that still takes clicks is a trap in the gutter.
                "pointer-events-none opacity-0",
                "group-hover:pointer-events-auto group-hover:opacity-100",
                "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
                // While the menu is open focus lives in the portal, outside this
                // row, so `focus-within` cannot hold the trigger visible.
                "data-[state=open]:pointer-events-auto data-[state=open]:bg-surface-hover data-[state=open]:text-ink data-[state=open]:opacity-100"
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
              canCopy={canCopy}
              copied={copied}
              pinned={pinned}
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
  canCopy,
  copied,
  pinned,
  callbacks,
  onOpenPicker,
}: {
  children: React.ReactElement;
  /** False on touch-only hardware and while text in this row is selected. */
  enabled: boolean;
  available: MessageActionAvailability;
  canCopy: boolean;
  copied: boolean;
  pinned: boolean;
  callbacks: MessageActionCallbacks;
  onOpenPicker: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEscapeLayer(open, () => setOpen(false));
  return (
    <ContextMenu open={open} onOpenChange={setOpen} modal={false}>
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
          canCopy={canCopy}
          copied={copied}
          pinned={pinned}
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
  canCopy,
  copied,
  pinned,
  callbacks,
  onOpenPicker,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The first line of the message, so the sheet names what it will act on. */
  preview: string;
  available: MessageActionAvailability;
  canCopy: boolean;
  copied: boolean;
  /** 이슈 #1112 - flips the pin row's label, exactly as it does in the menu. */
  pinned: boolean;
  callbacks: MessageActionCallbacks;
  onOpenPicker: () => void;
}) {
  const close = () => onOpenChange(false);
  const items = messageActionItemsForSurface("sheet", available, {
    canCopy,
    copied,
    pinned,
  });
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
                {actionIcon(more, pinned)}
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
              if (item.key !== "copy") close();
              invokeAction(item.key, callbacks, onOpenPicker);
            }}
          >
            {actionIcon(item, pinned)}
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

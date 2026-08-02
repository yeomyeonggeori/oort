import {
  MessageSquareReply,
  MoreHorizontal,
  Pencil,
  Smile,
  Trash2,
} from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { Button } from "@/design/ui/button";
import { QUICK_REACTIONS } from "./reactions";

// =============================================================================
// The message action surfaces (B11).
//
// One set of actions, two surfaces, split by **what the input device can do**
// rather than by how wide the window is:
//
//   * **a pointer that can hover** - a ⋯ trigger appears in the row's own
//     gutter and opens a menu. One control, therefore one tab stop; the menu
//     carries every action. R1 shipped a six-button bar here and it failed
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

import { hasAnyAction, type MessageActionAvailability } from "./model";

export interface MessageActionCallbacks {
  onReply: () => void;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onDelete: () => void;
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
  callbacks,
  onOpenPicker,
  hidden,
}: {
  available: MessageActionAvailability;
  callbacks: MessageActionCallbacks;
  onOpenPicker: () => void;
  /** While the row is being edited the editor owns it (R2 M3). */
  hidden?: boolean;
}) {
  const offersReactions = available.react;
  return (
    <div
      data-testid="message-action-column"
      className="pointer-only relative w-control shrink-0"
    >
      {hasAnyAction(available) && !hidden && (
        // `modal={false}`: a row menu is not a mode. Radix's modal branch locks
        // `pointer-events` on the body, which stops the timeline scrolling
        // underneath and fights the confirm dialog that 지우기 opens next.
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="message-actions-trigger"
              // The row's preferred keyboard entry point (see rowFocus.ts):
              // last in DOM order, first in the order someone looks for it.
              data-row-action="primary"
              aria-label="메시지 액션"
              title="메시지 액션"
              className={cn(
                "absolute right-0 top-0 flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-opacity",
                "hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
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
            {offersReactions && (
              <>
                {/* The six most-used emoji sit on one line: the common reaction
                    should not cost a trip into a picker and back out of it.
                    Radix walks these with the arrow keys like any other item. */}
                <div className="flex items-center gap-px" aria-label="빠른 반응">
                  {QUICK_REACTIONS.map((emoji) => (
                    <DropdownMenuItem
                      key={emoji}
                      data-testid={`menu-react-${emoji}`}
                      aria-label={`${emoji} 반응 남기기`}
                      onSelect={() => callbacks.onReact(emoji)}
                      className="size-control-sm justify-center px-0"
                    >
                      <span aria-hidden="true">{emoji}</span>
                    </DropdownMenuItem>
                  ))}
                </div>
                <DropdownMenuItem
                  data-testid="menu-react-more"
                  onSelect={onOpenPicker}
                >
                  <Smile className="size-4" aria-hidden="true" />
                  다른 반응 고르기
                </DropdownMenuItem>
              </>
            )}
            {offersReactions &&
              (available.reply || available.edit || available.delete) && (
                <DropdownMenuSeparator />
              )}
            {available.reply && (
              <DropdownMenuItem
                data-testid="menu-reply"
                onSelect={callbacks.onReply}
              >
                <MessageSquareReply className="size-4" aria-hidden="true" />
                답글 달기
              </DropdownMenuItem>
            )}
            {available.edit && (
              <DropdownMenuItem
                data-testid="menu-edit"
                onSelect={callbacks.onEdit}
              >
                <Pencil className="size-4" aria-hidden="true" />
                고치기
              </DropdownMenuItem>
            )}
            {available.delete && (
              <DropdownMenuItem
                data-testid="menu-delete"
                tone="danger"
                onSelect={callbacks.onDelete}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                지우기
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
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
        "tap-target flex w-full items-center gap-3 rounded-sm px-3 text-body transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
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
  callbacks,
  onOpenPicker,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The first line of the message, so the sheet names what it will act on. */
  preview: string;
  available: MessageActionAvailability;
  callbacks: MessageActionCallbacks;
  onOpenPicker: () => void;
}) {
  const close = () => onOpenChange(false);
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
        {available.react && (
          <div className="flex flex-wrap gap-1 px-1 pt-1">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                data-testid={`sheet-react-${emoji}`}
                aria-label={`${emoji} 반응 남기기`}
                onClick={() => {
                  callbacks.onReact(emoji);
                  close();
                }}
                className="tap-target flex items-center justify-center rounded-sm text-title transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))}
            <button
              type="button"
              data-testid="sheet-react-more"
              aria-label="다른 반응 고르기"
              onClick={() => {
                close();
                onOpenPicker();
              }}
              className="tap-target flex items-center justify-center rounded-sm px-3 text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Smile className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}
        {available.reply && (
          <SheetAction
            label="답글 달기"
            testId="sheet-reply"
            onSelect={() => {
              close();
              callbacks.onReply();
            }}
          >
            <MessageSquareReply className="size-4" aria-hidden="true" />
          </SheetAction>
        )}
        {available.edit && (
          <SheetAction
            label="고치기"
            testId="sheet-edit"
            onSelect={() => {
              close();
              callbacks.onEdit();
            }}
          >
            <Pencil className="size-4" aria-hidden="true" />
          </SheetAction>
        )}
        {available.delete && (
          <SheetAction
            label="지우기"
            testId="sheet-delete"
            tone="danger"
            onSelect={() => {
              close();
              callbacks.onDelete();
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </SheetAction>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The rest of the emoji, hand-rolled.
 *
 * No emoji-picker dependency, and that is a decision rather than a shortcut: a
 * picker library ships a font or a sprite sheet, and this app has a strict CSP
 * with no external hosts and an offline shell (B10). A fixed grid of the emoji a
 * work channel actually uses costs nothing to load and works with no network at
 * all.
 */
const PICKER_EMOJI = [
  "👍", "👎", "✅", "❌", "🙏", "🎉", "👀", "😄",
  "😂", "😅", "🤔", "😮", "😭", "🔥", "💯", "✨",
  "🚀", "🐛", "🛠️", "📌", "📝", "🔍", "⏳", "⚠️",
  "❤️", "💡", "🙌", "👏", "☕", "🍀", "🥲", "🫡",
];

export function ReactionPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="reaction-picker"
        className="max-w-pane-sm gap-3 p-4"
      >
        <DialogTitle>반응 고르기</DialogTitle>
        <DialogDescription className="sr-only">
          이 메시지에 남길 이모지를 고르세요.
        </DialogDescription>
        <div className="grid grid-cols-8 gap-1">
          {PICKER_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-testid={`picker-react-${emoji}`}
              aria-label={`${emoji} 반응 남기기`}
              onClick={() => {
                onPick(emoji);
                onOpenChange(false);
              }}
              className="tap-target flex size-control items-center justify-center rounded-sm text-title transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
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

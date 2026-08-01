import { MessageSquareReply, Pencil, Smile, Trash2 } from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Button } from "@/design/ui/button";
import { QUICK_REACTIONS } from "./reactions";

// =============================================================================
// The message action bar (B11).
//
// Two surfaces for one set of actions, because the gesture that summons them is
// not the same on both:
//
//   * **desktop** — revealed on hover, and equally on `focus-within`, so the bar
//     is reachable by Tab and not only by a pointer. `opacity-0` rather than
//     `hidden`: a hidden button is not focusable, and a keyboard reader would
//     have no way to reach any of this.
//   * **phone** — a long press opens a sheet ([`MessageActionSheet`]). Hover
//     does not exist on a touch screen, and B9's rule is that the phone gets its
//     own affordance rather than a desktop one that happens to fit. Every row in
//     the sheet is a 44px target.
//
// Which actions appear is decided upstream by the pure predicates in `model.ts`
// (`canEditMessage`, …) — the server is the authority and answers 403 anyway,
// so these are affordances, not access control.
// =============================================================================

import { hasAnyAction, type MessageActionAvailability } from "./model";

export interface MessageActionCallbacks {
  onReply: () => void;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** The bar's icon buttons share one shape; only the hazard tone differs. */
const ACTION_BUTTON =
  "flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The hover bar. Rendered on every actionable row and revealed by the row's
 * `group-hover` / `focus-within`, so it costs no state and cannot get stuck
 * open on a row the pointer has left.
 *
 * `wide-only`: on a phone this bar never appears at all — the sheet is the
 * phone's path, and shipping both would put an unreachable control on a surface
 * that has no hover to reveal it.
 */
export function MessageActionBar({
  available,
  callbacks,
  onOpenPicker,
}: {
  available: MessageActionAvailability;
  callbacks: MessageActionCallbacks;
  onOpenPicker: () => void;
}) {
  if (!hasAnyAction(available)) return null;
  return (
    <div
      data-testid="message-actions"
      // `-top-3`: 행 위 경계에 걸쳐 뜬다. `top-0`에 두면 바가 본문 **첫 줄**의
      // 오른쪽 끝을 덮는데, 긴 URL 한 줄이 오른쪽 끝까지 가는 행에서 그건 읽던
      // 글자를 가리는 것이다. 경계에 걸치면 가리는 것은 위 행의 아래 여백이다.
      className="wide-only absolute -top-3 right-4 z-10 flex items-center gap-px rounded-sm border border-line bg-surface-raised p-px opacity-0 shadow-sm transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
    >
      {available.react && (
        <>
          {/* The two most-used emoji sit on the bar itself: the common reaction
              should cost one click, not a click into a picker and another out
              of it. The rest are one more click away, deliberately. */}
          {QUICK_REACTIONS.slice(0, 2).map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={ACTION_BUTTON}
              data-testid={`message-react-${emoji}`}
              aria-label={`${emoji} 반응 남기기`}
              title={`${emoji} 반응 남기기`}
              onClick={() => callbacks.onReact(emoji)}
            >
              <span aria-hidden="true" className="text-body">
                {emoji}
              </span>
            </button>
          ))}
          <button
            type="button"
            className={ACTION_BUTTON}
            data-testid="message-react-more"
            aria-label="다른 반응 고르기"
            title="다른 반응 고르기"
            onClick={onOpenPicker}
          >
            <Smile className="size-4" aria-hidden="true" />
          </button>
        </>
      )}
      {available.reply && (
        <button
          type="button"
          className={ACTION_BUTTON}
          data-testid="message-reply"
          aria-label="답글 달기"
          title="답글 달기"
          onClick={callbacks.onReply}
        >
          <MessageSquareReply className="size-4" aria-hidden="true" />
        </button>
      )}
      {available.edit && (
        <button
          type="button"
          className={ACTION_BUTTON}
          data-testid="message-edit"
          aria-label="메시지 고치기"
          title="메시지 고치기"
          onClick={callbacks.onEdit}
        >
          <Pencil className="size-4" aria-hidden="true" />
        </button>
      )}
      {available.delete && (
        <button
          type="button"
          className={cn(ACTION_BUTTON, "hover:text-danger")}
          data-testid="message-delete"
          aria-label="메시지 지우기"
          title="메시지 지우기"
          onClick={callbacks.onDelete}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
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
 * as reachable by an external keyboard as the bar is.
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

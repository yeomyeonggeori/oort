import type { VisibleCustomStatus } from "@momo/core/features/presence/customStatus";
import { MessageCircle } from "lucide-react";
import { cn } from "@/design/lib/cn";

// Custom status (ADR-0176) is a second axis next to declared presence.
// Emoji is decorative when text is present. An emoji-only status is the
// accessible fact, so the glyph stays in the tree (design-review #1889 M-2).
// A text-only status still needs a quiet mark on the sidebar card
// (design-review #1889 R2-M2); the bubble is decorative, names stay on
// the trigger.

export function CustomStatusMark({
  status,
  className,
  emojiOnly = false,
  wrap = false,
}: {
  status: VisibleCustomStatus;
  className?: string;
  /** Sidebar card: emoji (or a quiet bubble if the status is text-only). */
  emojiOnly?: boolean;
  /** Profile dialog: wrap instead of truncating mid-word. */
  wrap?: boolean;
}) {
  if (emojiOnly && !status.emoji && !status.text) return null;
  const text = emojiOnly ? undefined : status.text;
  return (
    <span
      className={cn(
        "min-w-0",
        wrap ? "break-words" : "flex items-baseline gap-1",
        className
      )}
      data-testid="custom-status"
    >
      {emojiOnly && !status.emoji ? (
        <MessageCircle
          aria-hidden="true"
          className="size-3 shrink-0"
          data-testid="custom-status-glyph"
        />
      ) : null}
      {status.emoji ? (
        <span
          aria-hidden={text ? true : undefined}
          className="shrink-0"
          data-testid="custom-status-emoji"
        >
          {status.emoji}
        </span>
      ) : null}
      {text ? (
        <span
          className={wrap ? "break-words" : "min-w-0 truncate"}
          title={status.text}
          data-testid="custom-status-text"
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

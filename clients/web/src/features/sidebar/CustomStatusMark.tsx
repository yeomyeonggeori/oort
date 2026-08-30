import type { VisibleCustomStatus } from "@momo/core/features/presence/customStatus";
import { cn } from "@/design/lib/cn";

// Custom status (ADR-0176) is a second axis next to declared presence.
// Emoji is decorative when text is present. An emoji-only status is the
// accessible fact, so the glyph stays in the tree (design-review #1889 M-2).

export function CustomStatusMark({
  status,
  className,
  emojiOnly = false,
  wrap = false,
}: {
  status: VisibleCustomStatus;
  className?: string;
  /** Sidebar card: emoji only. Text lives on title / menu head / profile. */
  emojiOnly?: boolean;
  /** Profile dialog: wrap instead of truncating mid-word. */
  wrap?: boolean;
}) {
  if (emojiOnly && !status.emoji) return null;
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

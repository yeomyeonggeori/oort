import type { VisibleCustomStatus } from "@momo/core/features/presence/customStatus";
import { cn } from "@/design/lib/cn";

// Custom status (ADR-0176) is a second axis next to declared presence. The
// emoji is decorative (aria-hidden); the text is the accessible fact and
// truncates with a title of the full string.

export function CustomStatusMark({
  status,
  className,
}: {
  status: VisibleCustomStatus;
  className?: string;
}) {
  return (
    <span
      className={cn("flex min-w-0 items-baseline gap-1", className)}
      data-testid="custom-status"
    >
      {status.emoji ? (
        <span
          aria-hidden="true"
          className="shrink-0"
          data-testid="custom-status-emoji"
        >
          {status.emoji}
        </span>
      ) : null}
      {status.text ? (
        <span
          className="min-w-0 truncate"
          title={status.text}
          data-testid="custom-status-text"
        >
          {status.text}
        </span>
      ) : null}
    </span>
  );
}

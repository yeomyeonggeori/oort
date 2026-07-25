import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";

// =============================================================================
// The four mandatory surface states (design-taste-web §5), one implementation
// so the sidebar, timeline, inbox and settings all read identically:
//   empty   = one line of copy + one action (an invitation, not a poster)
//   loading = height-preserving neutral bars, never a shimmer
//   error   = what happened + what to do next, inline, never a toast
//   offline = one inline banner, cached content keeps rendering (P15)
// =============================================================================

/** Height-preserving neutral bars. No shimmer: loading is not a light show. */
export function SkeletonRows({
  rows = 4,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 p-2", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-6 rounded-sm bg-surface-hover"
          data-testid="skeleton-row"
        />
      ))}
    </div>
  );
}

/**
 * Inline banner used for both error and offline. Toast stacks are banned; the
 * message lives where the problem is.
 */
export function InlineBanner({
  tone = "error",
  message,
  actionLabel,
  onAction,
  testId,
}: {
  tone?: "error" | "neutral";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  testId?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={cn(
        "flex items-start justify-between gap-3 border-b px-4 py-2 text-body",
        tone === "error"
          ? "border-danger text-danger"
          : "border-line bg-surface-hover text-ink"
      )}
    >
      {/* Wraps, never truncates: this banner also runs in the sidebar column,
          and half an error message is worse than none. */}
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {actionLabel && onAction && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * Empty state: one line of copy plus at most two equal actions. Left-aligned
 * and quiet, never a centered illustration poster.
 */
export function EmptyInvite({
  headline,
  detail,
  actions,
  testId,
}: {
  headline: string;
  detail?: string;
  actions?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col items-start gap-3 px-4 py-6"
      data-testid={testId}
    >
      <p className="text-body font-medium text-ink">
        {headline}
      </p>
      {detail && (
        <p className="text-body text-ink-muted">{detail}</p>
      )}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

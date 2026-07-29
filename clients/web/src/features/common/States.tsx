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
 *
 * The bottom border is a SEPARATOR, not a frame: it exists to divide the banner
 * from the content it sits on top of. `separator={false}` is for the one shape
 * where there is nothing to divide from, a banner that is the only child of a
 * box that already draws its own boundary. Drawing it there produced two
 * parallel horizontal rules 16px apart in 설정 > 사용량, the louder of the two
 * landing where no frame boundary is (MOMO-628 R1 M2). Default stays true, so
 * every existing caller renders exactly as before.
 *
 * `lines` is the same shape of opt-in, for text FORMATTING. Exactly one caller
 * (the app consent dialog's per-cause failure) composes its message with `\n`,
 * and that caller alone taught this shared banner to honour them: forty-odd
 * call sites from the sidebar to 설정 inherited a formatting behaviour none of
 * them asked for (MOMO-642 4). A banner message is one sentence unless the
 * caller says it is a list.
 */
export function InlineBanner({
  tone = "error",
  message,
  actionLabel,
  onAction,
  separator = true,
  lines = false,
  testId,
}: {
  tone?: "error" | "neutral";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  separator?: boolean;
  /** Render the `\n` in `message` as line breaks instead of collapsing them. */
  lines?: boolean;
  testId?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={cn(
        "flex items-start justify-between gap-3 px-4 py-2 text-body",
        separator && "border-b",
        tone === "error"
          ? "border-danger text-danger"
          : "border-line bg-surface-hover text-ink"
      )}
    >
      {/* Wraps, never truncates: this banner also runs in the sidebar column,
          and half an error message is worse than none. */}
      <span
        className={cn(
          "min-w-0 flex-1 break-words",
          lines && "whitespace-pre-line"
        )}
      >
        {message}
      </span>
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
  dataAttrs,
}: {
  headline: string;
  detail?: string;
  actions?: React.ReactNode;
  testId?: string;
  /** Extra data-* hooks, e.g. which variant of an empty state this is. */
  dataAttrs?: Record<string, string>;
}) {
  return (
    <div
      className="flex flex-col items-start gap-3 px-4 py-6"
      data-testid={testId}
      {...dataAttrs}
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

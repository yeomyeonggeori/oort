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
 * `items` is the same shape of opt-in, for STRUCTURE. Exactly one caller (the
 * app consent dialog's per-cause failure) ever has more than one thing to say,
 * and that caller alone used to teach this shared banner a text FORMATTING
 * behaviour: `whitespace-pre-line`, so it could join `"• " + sentence` with
 * `\n` (MOMO-642 4, then MOMO-676 M-4). A typed bullet is not a list. It had no
 * `ul`/`li` semantics, `role="alert"` announced the whole join as one sentence,
 * and a soft-wrapped continuation started under the dot instead of under the
 * text it continued. The opt-in is now the list itself: the caller hands over
 * its items and the banner renders real list markup, with the hanging indent
 * that `list-outside` gives for free. `\n` is not a formatting language.
 *
 * `list-disc` rather than a typed bullet also keeps the semantics in Safari,
 * which drops list roles from a `list-style: none` list, and the desktop shell
 * is WKWebView.
 */
export function InlineBanner({
  tone = "error",
  message,
  items,
  icon,
  actionLabel,
  onAction,
  actionBusy = false,
  separator = true,
  heading = false,
  testId,
}: {
  tone?: "error" | "neutral";
  message: string;
  /** Rendered as a real list under `message`. Omit for a one-sentence banner. */
  items?: readonly string[];
  /**
   * Leading indicator, for a banner that has to be FINDABLE rather than merely
   * present. The neutral tone deliberately looks like chrome, which is right
   * for a banner the reader arrived at and wrong for one that appears while
   * they are looking elsewhere (the shell's connection line, goal B8 B2). Pass
   * a lucide icon carrying a status token; leave it out and nothing changes.
   */
  icon?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  /**
   * The action is running. `aria-busy` and a changed label, never `disabled`
   * and never dimmed: a control that goes grey mid-action reads as "you may not
   * do this" rather than "this is happening" (gate-shell-layout asserts exactly
   * that shape for the consent dialog's confirm).
   */
  actionBusy?: boolean;
  separator?: boolean;
  /**
   * This banner REPLACED the page, so its sentence is the page's heading.
   *
   * Default false, and it has to stay that way: nearly every caller sits under
   * a heading that is still on screen (the route header, the goal a detail page
   * is about), and a second `h1` there would be two documents in one pane. The
   * opt-in is for the branch where the content is gone and the banner is all
   * that is left, which otherwise renders a route with no heading at all
   * (PR 918 R1 Low).
   */
  heading?: boolean;
  testId?: string;
}) {
  const Message = heading ? "h1" : "span";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={cn(
        // 한국어 산문 표면이므로 음절이 아니라 어절에서 끊는다(MOMO-676 M-5).
        // `break-words`와 **같은 엘리먼트에 둘 수 없다**: tailwind-merge는 둘을
        // 한 `break` 그룹으로 묶어 마지막 하나만 남기므로, 끊기지 않는 긴 토큰을
        // 받아내는 overflow-wrap이 조용히 사라진다. word-break는 상속되니 부모가
        // keep-all을, 자식이 break-words를 갖는다.
        "flex items-start justify-between gap-3 break-keep px-4 py-2 text-body",
        separator && "border-b",
        tone === "error"
          ? "border-danger text-danger"
          : "border-line bg-surface-hover text-ink"
      )}
    >
      {icon && (
        <span aria-hidden="true" className="mt-px shrink-0">
          {icon}
        </span>
      )}
      {/* Wraps, never truncates: this banner also runs in the sidebar column,
          and half an error message is worse than none. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Message className="break-words">{message}</Message>
        {items && items.length > 0 && (
          <ul className="flex list-outside list-disc flex-col gap-1 ps-4">
            {items.map((item) => (
              <li key={item} className="break-words">{item}</li>
            ))}
          </ul>
        )}
      </div>
      {actionLabel && onAction && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-busy={actionBusy || undefined}
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
 *
 * Same `break-keep` as the banner above, for the same reason and by the same
 * rule: these two are the file's Korean prose surfaces, so the rule applies to
 * both branches of it rather than only to the one a review happened to measure.
 */
export function EmptyInvite({
  headline,
  detail,
  actions,
  heading = false,
  className,
  testId,
  dataAttrs,
}: {
  headline: string;
  detail?: string;
  actions?: React.ReactNode;
  /**
   * 자리 조정용. 이 상자는 기본으로 자기 여백(px-4)을 갖는데, 이미 여백을 가진
   * 상자 안에 들어가면 그만큼 안으로 더 들어가 앉는다. `cn()`이 tailwind-merge를
   * 거치므로 `px-0` 한 마디로 기본값을 덮을 수 있다.
   */
  className?: string;
  /**
   * This state REPLACED the page, so its headline is the page's heading. Same
   * opt-in and same reason as `InlineBanner.heading`: an empty list inside a
   * route that still shows its own `h1` must not add a second one, and a 404
   * that replaced the whole route must not leave the document with none.
   */
  heading?: boolean;
  testId?: string;
  /** Extra data-* hooks, e.g. which variant of an empty state this is. */
  dataAttrs?: Record<string, string>;
}) {
  const Headline = heading ? "h1" : "p";
  return (
    <div
      className={cn(
        "flex break-keep flex-col items-start gap-3 px-4 py-6",
        className
      )}
      data-testid={testId}
      {...dataAttrs}
    >
      <Headline className="text-body font-medium text-ink">
        {headline}
      </Headline>
      {detail && (
        <p className="text-body text-ink-muted">{detail}</p>
      )}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

import { useCallback, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AtSign, Bot, ShieldAlert } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { channelPath, watchForMessage } from "./anchor";
import type { FeedItem, FeedTone, OutcomeTone } from "@momo/core/features/inbox/model";

// =============================================================================
// One feed row, shared by the inbox and the activity route (R-1 §2). Flat rows
// with a separator and a hover background, never one rounded card per item
// (design-taste-web §8). The whole row is a link: clicking it lands on the
// message the row is about.
//
// The row title carries "왜 이게 왔는지" (P10). A Radix Tooltip would be the
// primitive of choice, but @radix-ui/react-tooltip is not a dependency of this
// client and P1 wave2 adds none, so this uses the native title attribute, which
// is also the pattern the sidebar turn badge already uses.
// =============================================================================

const TONE_CLASS: Record<FeedTone, string> = {
  warn: "text-warn",
  accent: "text-accent",
  agent: "text-agent",
  muted: "text-ink-muted",
};

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  ok: "text-ok",
  danger: "text-danger",
  warn: "text-warn",
  muted: "text-ink-muted",
};

function KindIcon({ kind, tone }: { kind: FeedItem["kind"]; tone: FeedTone }) {
  const className = cn("size-4", TONE_CLASS[tone]);
  if (kind === "approval") return <ShieldAlert className={className} />;
  if (kind === "mention") return <AtSign className={className} />;
  return <Bot className={className} />;
}

/**
 * `actions` is rendered as a SIBLING of the link, never inside it.
 *
 * The whole row is an anchor, and a button inside an anchor is not a button: the
 * browser gives the click to the link, so 승인 would navigate to the channel
 * instead of deciding anything, and the keyboard path collapses to one stop.
 * Keeping the two apart inside one `li` is what lets the row stay openable and
 * decidable at the same time (goal B5.3b D-5).
 */
export function FeedRow({
  item,
  actions,
}: {
  item: FeedItem;
  actions?: ReactNode;
}) {
  const seqAttrs = item.seq === undefined ? {} : { "data-seq": String(item.seq) };
  const hasFooter =
    item.outcome !== null ||
    item.note !== undefined ||
    item.managedBy !== undefined;

  return (
    <li className={actions ? "border-b border-line" : undefined}>
      <Link
        to={channelPath(item.channelId, item.seq)}
        onClick={() => {
          if (item.seq !== undefined) watchForMessage(item.seq);
        }}
        title={item.reason}
        data-feed-row=""
        data-testid="feed-row"
        data-kind={item.kind}
        data-channel-id={item.channelId}
        {...seqAttrs}
        className={cn(
          "flex gap-3 px-4 py-2 transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          !actions && "border-b border-line"
        )}
      >
        <span className="shrink-0 pt-1" aria-hidden="true">
          <KindIcon kind={item.kind} tone={item.tone} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex flex-wrap items-baseline gap-2">
            {/* Agent identity is this token and nothing else: same grid, same
             * type, only the --agent color differs (design-taste-web §9). */}
            <span
              className={cn(
                "text-body font-semibold",
                item.actorIsAgent ? "text-agent" : "text-ink"
              )}
            >
              {item.actor}
            </span>
            <span className="text-body text-ink">{item.predicate}</span>
            <span className="text-meta text-ink-muted">{item.channelLabel}</span>
            {item.timeLabel && (
              <span
                className="text-timestamp text-ink-muted"
                data-numeric
                data-testid="feed-row-time"
              >
                {item.timeLabel}
              </span>
            )}
          </span>
          {item.detail && (
            <span className="truncate text-body text-ink-muted">
              {item.detail}
            </span>
          )}
          {hasFooter && (
            <span className="flex flex-wrap items-center gap-2 text-meta">
              {item.outcome !== null && (
                <span
                  className={cn("font-medium", OUTCOME_CLASS[item.outcomeTone])}
                  data-testid="feed-row-outcome"
                >
                  → {item.outcome}
                </span>
              )}
              {item.note && <span className="text-warn">{item.note}</span>}
              {item.managedBy && (
                <span className="text-ink-muted">
                  {item.managedBy} 님이 관리
                </span>
              )}
            </span>
          )}
        </span>
      </Link>
      {actions}
    </li>
  );
}

/**
 * The row list with its keyboard path (R-1 §2): ↑/↓ moves between rows, Enter
 * opens the source (the row is a link, so that is native), E marks a mention
 * read by advancing the server cursor.
 */
export function FeedList({
  items,
  onMarkRead,
  renderActions,
  testId,
}: {
  items: FeedItem[];
  /** Only offered for rows that carry a seq to read up to. */
  onMarkRead?: (item: FeedItem) => void;
  /** Per-row controls, rendered beside the link. Return null for plain rows. */
  renderActions?: (item: FeedItem) => ReactNode;
  testId: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const rows = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>("[data-feed-row]") ?? []
      );
      if (rows.length === 0) return;
      const index = rows.indexOf(document.activeElement as HTMLElement);

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        event.preventDefault();
        rows[(Math.max(index, 0) + step + rows.length) % rows.length]?.focus();
        return;
      }
      if ((event.key === "e" || event.key === "E") && index >= 0) {
        const item = items[index];
        if (!item || !onMarkRead || item.seq === undefined) return;
        event.preventDefault();
        onMarkRead(item);
      }
    },
    [items, onMarkRead]
  );

  return (
    <ul
      ref={listRef}
      onKeyDown={onKeyDown}
      data-testid={testId}
      className="flex flex-col"
    >
      {items.map((item) => (
        <FeedRow key={item.key} item={item} actions={renderActions?.(item)} />
      ))}
    </ul>
  );
}

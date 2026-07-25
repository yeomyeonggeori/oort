import { useCallback, useRef } from "react";
import { cn } from "@/design/lib/cn";
import {
  INBOX_FILTERS,
  filterLabel,
  panelId,
  tabId,
  type InboxFilter,
} from "./model";

// =============================================================================
// The three inbox filters as a segmented control (R-1 §2).
//
// Hand-built rather than a primitive: @radix-ui/react-tabs is not a dependency
// of this client and P1 wave2 adds no packages, so this implements the WAI-ARIA
// tabs pattern directly (roving tabindex, aria-selected, ←/→ traversal) and the
// route owns the panel it controls.
// =============================================================================

const BASE =
  "inline-flex h-control-sm items-center gap-2 rounded-sm px-3 text-body transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function FilterTabs({
  value,
  onChange,
  counts,
}: {
  value: InboxFilter;
  onChange: (filter: InboxFilter) => void;
  /** Rendered only where a server projection actually supplies a number. */
  counts?: Partial<Record<InboxFilter, number>>;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const index = INBOX_FILTERS.indexOf(value);
      const next =
        INBOX_FILTERS[
          (index + step + INBOX_FILTERS.length) % INBOX_FILTERS.length
        ];
      onChange(next);
      listRef.current
        ?.querySelector<HTMLElement>(`#${tabId(next)}`)
        ?.focus();
    },
    [value, onChange]
  );

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="인박스 필터"
      onKeyDown={onKeyDown}
      className="flex items-center gap-1"
    >
      {INBOX_FILTERS.map((filter) => {
        const selected = filter === value;
        const count = counts?.[filter] ?? 0;
        return (
          <button
            key={filter}
            type="button"
            role="tab"
            id={tabId(filter)}
            aria-controls={panelId(filter)}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-testid={`inbox-tab-${filter}`}
            onClick={() => onChange(filter)}
            className={cn(
              BASE,
              selected
                ? "bg-accent-soft font-medium text-ink"
                : "text-ink-muted hover:bg-surface-hover"
            )}
          >
            {filterLabel(filter)}
            {count > 0 && (
              <span className="text-timestamp text-ink-muted" data-numeric>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

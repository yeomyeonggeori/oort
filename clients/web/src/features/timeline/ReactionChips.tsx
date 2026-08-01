import { Smile } from "lucide-react";
import { cn } from "@/design/lib/cn";
import type { ReactionChip } from "./reactions";

// =============================================================================
// Reaction chips (B11) — the row of 👍 3 under a message.
//
// A chip is a **toggle**, not a counter: clicking one adds or removes *my*
// reaction depending on whether I am already in it, which is why `mine` drives
// both the emphasis and the direction. The count is everyone's, the emphasis is
// mine, and the two are read at a glance because they are the same control.
//
// Renders nothing at all when there are no reactions. An empty row would take
// vertical rhythm from every message in the channel to say "no one reacted",
// which is what the absence already says.
// =============================================================================

export function ReactionChips({
  chips,
  onToggle,
  onOpenPicker,
  disabled,
}: {
  chips: ReactionChip[];
  onToggle: (emoji: string) => void;
  /** Absent on a row that may not be reacted to (a tombstone). */
  onOpenPicker?: () => void;
  disabled?: boolean;
}) {
  if (chips.length === 0) return null;
  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1"
      data-testid="reaction-chips"
    >
      {chips.map((chip) => (
        <button
          key={chip.emoji}
          type="button"
          disabled={disabled}
          data-testid="reaction-chip"
          // 이 행의 로빙 그룹 구성원 (rowFocus.ts). 반응이 다섯 개 달린 메시지가
          // 키보드로 지나가는 데 다섯 번의 Tab을 요구하지 않게 하는 표시다.
          data-row-action=""
          data-emoji={chip.emoji}
          data-mine={chip.mine ? "true" : "false"}
          aria-pressed={chip.mine}
          // The accessible name says what the click will do, because the glyph
          // and the number alone do not: a screen reader user cannot see the
          // emphasis that tells a sighted user which way the toggle goes.
          aria-label={
            chip.mine
              ? `${chip.emoji} 반응 ${chip.count}개, 내 반응 취소`
              : `${chip.emoji} 반응 ${chip.count}개, 나도 반응하기`
          }
          onClick={() => onToggle(chip.emoji)}
          className={cn(
            "tap-target flex items-center gap-1 rounded-sm border px-2 py-px text-meta transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50",
            chip.mine
              ? "border-accent bg-accent-soft text-ink"
              : "border-line bg-surface-raised text-ink-muted hover:bg-surface-hover"
          )}
        >
          <span aria-hidden="true">{chip.emoji}</span>
          <span aria-hidden="true" data-numeric>
            {chip.count}
          </span>
        </button>
      ))}
      {onOpenPicker && (
        // The add button lives at the end of an existing row only. On a message
        // with no reactions the entry point is the action bar (or the long-press
        // sheet); putting a permanent 「+」 under every message would draw a
        // control on every row of the channel to serve the rare one.
        <button
          type="button"
          disabled={disabled}
          data-testid="reaction-add"
          data-row-action=""
          aria-label="다른 반응 고르기"
          title="다른 반응 고르기"
          onClick={onOpenPicker}
          className="tap-target flex items-center rounded-sm border border-line bg-surface-raised px-2 py-px text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          <Smile className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

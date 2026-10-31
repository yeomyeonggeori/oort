import { ExpressionText } from "@/features/expressions/ExpressionText";
import { useMemo } from "react";
import { Smile } from "lucide-react";
import { cn } from "@/design/lib/cn";
import type { Directory } from "@momo/core/features/workspace/directory";
import type { ReactionChip } from "@momo/core/features/timeline/reactions";
import {
  formatReactionNames,
  reactionChipAccessibleName,
} from "@momo/core/features/timeline/reactionNames";

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
//
// 모양 (#4879, owner 2026-10-31, Buzz 기준): 알약, 보이는 높이 28(`h-control-sm`), 이모지 16,
// 숫자 13 굵게. 내가 단 칩은 `accent-soft` 바탕 + 1px `accent` 테두리 + 강조 글자, 안 단 칩은 흐린
// 바탕(`surface-muted`)에 테두리 없음 + `ink-muted` 글자다. 색만으로 가르지 않는다: 테두리 유무와
// `aria-pressed`가 같은 말을 한다. 안 단 칩의 「테두리 없음」은 투명 1px이라 두 상태의 상자가
// 같다 — 눌러서 바뀌어도 이웃 칩이 밀리지 않는다. 색은 전부 토큰이라 워크스페이스 강조색(테마)이
// 그대로 따라온다. 600px 아래의 누르는 영역은 `tap-target`(44)이 지고, 이 유틸은 줄이지 않는다.
// =============================================================================

export function ReactionChips({
  chips,
  directory,
  myMemberId,
  onToggle,
  onOpenPicker,
  disabled,
}: {
  chips: ReactionChip[];
  directory: Directory;
  myMemberId: string | undefined;
  onToggle: (emoji: string) => void;
  /** Absent on a row that may not be reacted to (a tombstone). */
  onOpenPicker?: (opener: HTMLButtonElement) => void;
  disabled?: boolean;
}) {
  if (chips.length === 0) return null;
  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1"
      data-testid="reaction-chips"
    >
      {chips.map((chip) => (
        <ReactionChipButton
          key={chip.emoji}
          chip={chip}
          directory={directory}
          myMemberId={myMemberId}
          disabled={disabled}
          onToggle={onToggle}
        />
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
          onClick={(event) => onOpenPicker(event.currentTarget)}
          // 칩과 같은 높이(`control-sm` 28)의 원, 흐린 바탕, 테두리 없음 (#4879).
          className="tap-target flex size-control-sm items-center justify-center rounded-full bg-surface-muted text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring disabled:opacity-50"
        >
          <Smile className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ReactionChipButton({
  chip,
  directory,
  myMemberId,
  disabled,
  onToggle,
}: {
  chip: ReactionChip;
  directory: Directory;
  myMemberId: string | undefined;
  disabled?: boolean;
  onToggle: (emoji: string) => void;
}) {
  // chipsFor reuses the map's memberIds array, so this identity is stable
  // across parent renders that did not change who reacted.
  const names = useMemo(
    () => formatReactionNames(chip.memberIds ?? [], directory, myMemberId),
    [chip.memberIds, directory, myMemberId]
  );
  const accessibleName = useMemo(
    () =>
      reactionChipAccessibleName(chip.emoji, chip.count, names, chip.mine),
    [chip.emoji, chip.count, names, chip.mine]
  );

  return (
    <button
      type="button"
      disabled={disabled}
      data-testid="reaction-chip"
      // 이 행의 로빙 그룹 구성원 (rowFocus.ts). 반응이 다섯 개 달린 메시지가
      // 키보드로 지나가는 데 다섯 번의 Tab을 요구하지 않게 하는 표시다.
      data-row-action=""
      data-emoji={chip.emoji}
      data-mine={chip.mine ? "true" : "false"}
      aria-pressed={chip.mine}
      // Native `title` is the house tooltip (FeedRow, huddle Live chip,
      // toolbar react). @radix-ui/react-tooltip is not a dependency; a
      // chip-only primitive would be the first. The attribute is present on
      // hover and keyboard focus; the screen reader reads aria-label.
      title={names || undefined}
      aria-label={accessibleName}
      onClick={() => onToggle(chip.emoji)}
      className={cn(
        "tap-target flex h-control-sm items-center gap-1 rounded-full border px-2 press focus-visible:focus-ring disabled:opacity-50",
        chip.mine
          ? "border-accent bg-accent-soft text-signal-text active:bg-surface-pressed"
          : "border-transparent bg-surface-muted text-ink-muted hover:bg-surface-hover"
      )}
    >
      {/* 이모지 16: `text-heading`이 16 역할이다(툴바의 20은 `reaction-glyph`, 이 줄의 것이 아니다). */}
      <span aria-hidden="true" className="text-heading leading-none">
        <ExpressionText text={chip.emoji} reaction />
      </span>
      {/* 숫자 13 굵게: 13은 `text-code`뿐이라 크기만 빌린다(글꼴은 그대로 본문 글꼴, 코드 서체가 아니다).
          색은 칩(버튼)이 정하고 숫자는 물려받는다: 내 칩은 강조 글자, 안 단 칩은 ink-muted. */}
      <span aria-hidden="true" data-numeric className="text-code font-semibold">
        {chip.count}
      </span>
    </button>
  );
}

import { cn } from "@/design/lib/cn";
import {
  composerTriggerSpec,
  type ComposerCandidate,
  type ComposerTriggerKind,
} from "./composerAutocomplete";

/**
 * 자동완성 후보 목록 (#1930). `@`·`#`·`:` 가 **한 목록**을 쓴다.
 *
 * 행 해부는 하나다: 왼쪽에 넣을 것(`@handle`·`#name`·글리프), 오른쪽 흐린 자리에
 * 그것이 무엇인지(사람 이름·방 주제·숏코드). 트리거마다 다른 행 모양을 만들면
 * 강조·자르기·간격이 세 벌이 되고, 셋 중 둘은 아무도 다시 보지 않는다.
 */
export function ComposerAutocompleteList({
  id,
  kind,
  candidates,
  highlight,
  onChoose,
  testId,
  optionTestId,
  className,
}: {
  id: string;
  kind: ComposerTriggerKind | null;
  candidates: ComposerCandidate[];
  highlight: number;
  onChoose: (candidate: ComposerCandidate) => void;
  testId: string;
  optionTestId: string;
  className?: string;
}) {
  if (kind === null || candidates.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label={composerTriggerSpec(kind).listLabel}
      data-testid={testId}
      className={cn(
        "absolute bottom-full left-3 mb-2 w-pane-sm overflow-hidden rounded-md border border-line bg-surface-raised p-1 shadow-lg",
        className
      )}
    >
      {candidates.map((candidate, index) => (
        <li key={candidate.id}>
          <button
            id={`${id}-option-${index}`}
            type="button"
            role="option"
            aria-selected={index === highlight}
            data-testid={optionTestId}
            onMouseDown={(event) => {
              event.preventDefault();
              onChoose(candidate);
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body",
              index === highlight ? "bg-accent-soft text-ink" : "text-ink"
            )}
          >
            <span className="truncate">{candidate.lead}</span>
            <span className="min-w-0 flex-1 truncate text-meta text-ink-muted">
              {candidate.hint}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

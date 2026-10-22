import { ChevronDown, ChevronRight } from "lucide-react";
import { goneDmDisclosureLabel } from "@momo/core/features/sidebar/goneDm";

// DM 구역 끝의 조용한 줄 「나간 멤버와의 대화 N개」 (#4252). 규칙(무엇이 접히는가)은 코어
// `dmHiddenAsGone` 이 갖고, 이 줄은 접힌 수를 말하고 펼침을 여는 문이다.
//
// 모양은 행 문법의 한 줄이다: 행과 같은 좌우 10 · 아이콘 칸(셰브론)에서 시작해 글자가 DM 이름과 같은
// 자리(38px)에서 시작한다. 글자는 meta·muted 라 이름보다 한 단 낮다. 펼치면 접힌 대화가 이 줄 **아래**에
// 선다(줄이 손가락 밑에 그대로 있다). 키보드는 행과 같은 ↑↓ 순회에 든다(`data-sidebar-row`).
export function GoneDmFold({
  count,
  expanded,
  onToggle,
  listId,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  /** 펼쳤을 때 접힌 대화들이 서는 목록의 id. */
  listId: string;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <li>
      <button
        type="button"
        data-sidebar-row=""
        data-testid="gone-dm-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={onToggle}
        className="tap-target sidebar-row flex w-full items-center text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring"
      >
        <span data-row-icon="" aria-hidden="true">
          <Chevron />
        </span>
        <span className="min-w-0 flex-1 truncate text-meta text-ink-muted">
          {goneDmDisclosureLabel(count)}
        </span>
      </button>
    </li>
  );
}

import { useLayoutEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { goneDmDisclosureLabel } from "@momo/core/features/sidebar/goneDm";

// DM 구역 끝의 조용한 줄 「나간 멤버와의 대화 N개」 (#4252). 규칙(무엇이 접히는가)은 코어
// `dmHiddenAsGone` 이 갖고, 이 줄은 접힌 수를 말하고 펼침을 여는 문이다.
//
// 모양은 행 문법의 한 줄이다: 행과 같은 좌우 10 · 아이콘 칸(셰브론)에서 시작해 글자가 DM 이름과 같은
// 자리(38px)에서 시작한다. 글자는 meta·muted 라 이름보다 한 단 낮다. 펼치면 접힌 대화가 이 줄 **아래**에
// 선다(줄이 손가락 밑에 그대로 있다). 키보드는 행과 같은 ↑↓ 순회에 든다(`data-sidebar-row`).
//
// 왜 `Collapsible` 이 아니라 손으로 만든 버튼인가(SKILL §1: 프리미티브가 못 한 일을 한 줄로 적는다): 이 줄은 구획 머리글이
// 아니라 **목록 안의 한 행**이다. `SidebarSection` 의 머리글 문법(굵은 제목 · 개수 알약 · 우측 액션)은 이 줄에 맞지 않고,
// 행과 같은 로빙 정거장(`data-sidebar-row`)·같은 안쪽 여백·같은 글자 자리에 서야 해서 행의 `sidebar-row` 문법을 그대로 입는다.
//
// 줄이 **눌린 채 사라지는** 순간이 있다(접힌 대화가 0 이 될 때: 접힌 대화가 하나뿐이고 그것이 열려 있을 때 줄을 접으면 열린
// 행이 위 목록으로 올라가 접힌 대화가 없어진다). 포커스가 있던 버튼이 사라지면 캐럿은 `<body>` 로 떨어지고 ↑↓ 순회가 죽는다
// (design-review #4252 H1). 사라지는 순간에만 `onVanishWhileFocused` 를 불러 호출부가 캐럿을 넘기게 한다. 레이아웃 효과의
// 정리는 React 가 DOM 에서 이 노드를 걷어내기 **전에** 돌므로 그때는 아직 `document.activeElement` 가 이 버튼이다.
export function GoneDmFold({
  count,
  expanded,
  onToggle,
  listId,
  onVanishWhileFocused,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  /** 펼쳤을 때 접힌 대화들이 서는 목록의 id. */
  listId: string;
  /** 이 줄에 포커스가 있는 채로 줄이 사라질 때(접힌 대화가 0 이 됐다) 호출부가 캐럿을 넘길 수 있게 불린다. */
  onVanishWhileFocused?: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const vanishRef = useRef(onVanishWhileFocused);
  vanishRef.current = onVanishWhileFocused;
  useLayoutEffect(
    () => () => {
      const button = buttonRef.current;
      if (
        button !== null &&
        typeof document !== "undefined" &&
        document.activeElement === button
      ) {
        vanishRef.current?.();
      }
    },
    []
  );
  return (
    <li>
      <button
        ref={buttonRef}
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

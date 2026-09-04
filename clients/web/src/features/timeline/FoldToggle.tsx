import { useMemo, useState } from "react";
import { cn } from "@/design/lib/cn";
import { CARD_FOLD, foldText, type FoldBudget } from "./fold";

// =============================================================================
// 접힌 것이 몇 줄인지 말하는 컨트롤 (U4-e · 진단 H-8).
//
// **페이드아웃이 아니다.** 아티팩트 카드가 잘린 패치에 대해 이미 내린 판단을
// 그대로 따른다: 흐려지는 그라디언트는 「더 있다」를 암시만 하고 얼마나 더
// 있는지는 끝내 말하지 않는다. 여기서는 숫자를 말한다 — 「38줄 더 보기」.
//
// **왜 `<details>`가 아닌가.** 이 앱의 다른 접힘(원본 데이터 보기, 자세히,
// 파일 블록)은 전부 네이티브 `<details>`이고 그것이 옳다. 여기만 다른 이유는
// **닫힌 `<details>`도 자식을 DOM에 만든다**는 것이다. 이 예산의 목적은 화면을
// 아끼는 것만이 아니라 500줄을 애초에 세우지 않는 것이므로(`fold.ts` 머리말),
// 접힌 쪽은 렌더되지 않아야 한다. 그래서 `aria-expanded`를 든 버튼 + 조건부
// 렌더라는, 같은 계약의 다른 표준 표현을 쓴다.
//
// **행의 탭 예산을 늘리지 않는다.** `data-row-action`을 달아 행의 로빙 그룹에
// 합류하므로(rowFocus.ts) Tab은 여전히 행 하나를 한 번에 지나가고, 행 안에서
// ←/→가 이 버튼에 닿는다. 액션이 없는 표면에서는 이 버튼이 그 행의 유일한
// 구성원이 되어, 키보드만 쓰는 사람에게 그 행의 첫 정거장이 된다.
// =============================================================================

const FOLD_CONTROL_CLASS = cn(
  // `touch-target`: hover가 없는 기기에서 이 링크의 **누를 수 있는 면적**이
  // 24px가 된다 (design-review U4-5 M-1, WCAG 2.5.8 AA 바닥선). 리뷰 실측은
  // ~18px이었고, 같은 배치가 폰에는 44pt를 도출식으로 강제하고 있었다 — hover 없는
  // 기기를 섬기기 시작한 이상 그 축은 두 클라에서 같은 뜻이어야 한다.
  //
  // 44px(`tap-target`)를 주지 않는 이유는 이 컨트롤이 자기 줄을 갖는 버튼이 아니라
  // 본문 밑에 붙는 밑줄 링크이기 때문이다 — 그 값을 주면 링크가 한 줄짜리 메시지
  // 보다 커진다(tokens.css의 두 값이 갈리는 근거, `LongPressHint`의 같은 산수).
  // 글자 크기도 밑줄 위치도 그대로다: 커지는 것은 면적뿐이다.
  "touch-target self-start rounded-sm text-meta text-ink-muted underline underline-offset-2",
  "press hover:text-ink focus-visible:focus-ring"
);

export function FoldToggle({
  hiddenLines,
  expanded,
  onToggle,
  testId = "message-fold",
}: {
  /** 접었을 때 숨는 줄 수. 0이면 이 컨트롤은 그려지지 않는다. */
  hiddenLines: number;
  expanded: boolean;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-row-action=""
      data-fold-hidden={hiddenLines}
      aria-expanded={expanded}
      onClick={onToggle}
      className={FOLD_CONTROL_CLASS}
    >
      {expanded ? (
        "접기"
      ) : (
        <>
          <span data-numeric>{hiddenLines}</span>줄 더 보기
        </>
      )}
    </button>
  );
}

/**
 * 같은 예산을 쓰는 평문 조각 — 에이전트 카드의 값과 실패 상세.
 *
 * 상태를 트리 밖에 두지 않는 것은 의도다: 이 조각들은 이미 `<details>` 안에
 * 산다. 그 `<details>` 자체가 스크롤로 닫히는 것이 먼저 고쳐질 문제이고, 그
 * 안쪽의 펼침만 따로 기억하면 카드가 닫힌 채로 「접기」를 들고 있는 상태가 된다.
 */
export function FoldedValue({
  text,
  className,
  budget = CARD_FOLD,
  testId = "card-value-fold",
}: {
  text: string;
  className?: string;
  budget?: FoldBudget;
  testId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const folded = useMemo(() => foldText(text, budget), [text, budget]);
  if (folded.hiddenLines === 0) {
    return <span className={cn("whitespace-pre-wrap", className)}>{text}</span>;
  }
  return (
    <span className={cn("flex flex-col items-start gap-1", className)}>
      <span className="whitespace-pre-wrap">
        {expanded ? text : folded.text}
      </span>
      <FoldToggle
        hiddenLines={folded.hiddenLines}
        expanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
        testId={testId}
      />
    </span>
  );
}

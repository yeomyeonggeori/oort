import { useState, type FocusEvent } from "react";

// =============================================================================
// 호버로 드러나는 첨부 행동의 상태 (#3820).
//
// 메시지 행 툴바와 **같은 규율**이다(MessageActions.tsx, #1743): 행동 버튼은
// `opacity-0` 로 숨기지 않고, 드러나는 조건일 때만 DOM 에 선다. 보이지 않는데
// 눌리거나 탭 순서에 들어 있는 버튼이 B11 R1 의 결함이었다.
//
// 드러나는 조건은 셋이다.
//   · 포인터가 위에 있다 (마우스 호버)
//   · 키보드 포커스가 안에 있다 (미리보기 버튼에 탭하면 같은 줄의 행동이 선다)
//   · 호버가 없는 입력(`hover: none`, 터치)이면 늘 선다 — 호버할 수단이 없는
//     사람에게 내려받기가 사라지면 안 된다. 이미지는 탭하면 크게 보기가 열리고
//     거기에 내려받기가 있으므로 이 예외는 파일 카드에만 쓴다.
// =============================================================================

export function canHover(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(hover: hover)").matches;
}

function isFocusVisible(target: EventTarget): boolean {
  try {
    return (target as Element).matches(":focus-visible");
  } catch {
    return true; // 셀렉터를 모르는 환경은 키보드로 본다(행동을 숨기는 쪽이 더 나쁘다)
  }
}

export function useRevealOnHover(options: { alwaysOnTouch?: boolean } = {}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const revealed =
    hovered || focused || (options.alwaysOnTouch === true && !canHover());
  return {
    revealed,
    handlers: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      // 마우스 클릭이 남긴 포커스는 키보드 포커스가 아니다: `:focus-visible` 일 때만.
      onFocus: (event: FocusEvent<HTMLElement>) =>
        setFocused(isFocusVisible(event.target)),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        // 같은 행동 줄 안에서 포커스가 옮겨 가는 동안은 접지 않는다.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocused(false);
      },
    },
  };
}

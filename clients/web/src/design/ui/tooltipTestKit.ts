import { act } from "react";

/**
 * 시험이 아이콘 단추의 「눈으로 보는 이름」(공용 `Tooltip`의 글)을 읽는 길 (#5779).
 *
 * 아이콘 단추의 이름 툴팁은 `title` 속성이 아니라 가리키거나 키보드 초점일 때 그려지는 노드라서, 속성을 읽던 시험은 이 함수로 바꾼다.
 * 키보드 초점 길(지연 0)을 탄다: 초점 이벤트를 단추에 직접 보내고(막힌 `disabled` 단추도 같다) `:focus-visible`을 참으로 답하게 해
 * 진짜 `Tooltip`의 키보드 경로를 지난다. 읽은 뒤 초점 나감을 보내 닫는다(다른 단정이 열린 툴팁을 보지 않게).
 * 가리킴 지연·터치·Esc 같은 동작 자체는 `tooltip.test.ts`가 잰다.
 */
export function tooltipTextOf(trigger: Element): string | null {
  const element = trigger as HTMLElement;
  const original = element.matches.bind(element);
  element.matches = (selector: string) => (selector === ":focus-visible" ? true : original(selector));
  try {
    act(() => {
      element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    let text: string | null = null;
    for (let node: Element | null = element.parentElement; node !== null && node !== element.ownerDocument.body; node = node.parentElement) {
      const tip = node.querySelector(':scope > [data-testid="tooltip"]');
      if (tip !== null) {
        text = tip.textContent;
        break;
      }
    }
    if (text === null) text = element.ownerDocument.querySelector('body > [data-testid="tooltip"]')?.textContent ?? null;
    act(() => {
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    return text;
  } finally {
    element.matches = original;
  }
}

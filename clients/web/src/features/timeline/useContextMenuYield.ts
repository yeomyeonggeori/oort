import { useRef, type MouseEvent, type PointerEvent, type RefObject } from "react";
import {
  isContextPress,
  selectionIsWithinRow,
  shouldYieldContextMenu,
} from "./messageContextMenuModel";

/**
 * 메시지 행의 우클릭 양보 규칙 (#5192). 규칙과 이유는 `messageContextMenuModel.ts`의 머리 주석에 있다.
 *
 * 돌려주는 핸들러 둘을 행(`<article>`)에 펴 붙인다. 둘 다 **캡처 단계**라서 Radix 컨텍스트 메뉴 트리거(버블 단계)보다 먼저 선다.
 * 양보할 때는 전파를 끊어 트리거가 `preventDefault`를 못 부르게 한다(브라우저 기본 메뉴가 그대로 뜬다).
 */
export function useContextMenuYield(rowRef: RefObject<HTMLElement | null>) {
  const selectedBeforePress = useRef<boolean | null>(null);
  return {
    onPointerDownCapture(event: PointerEvent<HTMLElement>) {
      // 왼쪽 누르기는 기록을 지운다: 오래된 우클릭 기록이 나중의 키보드 `contextmenu`를 잘못 읽지 않게.
      selectedBeforePress.current = isContextPress(event)
        ? selectionIsWithinRow(rowRef.current, document.getSelection())
        : null;
    },
    onContextMenuCapture(event: MouseEvent<HTMLElement>) {
      const before = selectedBeforePress.current;
      selectedBeforePress.current = null;
      const selection = document.getSelection();
      const now = selectionIsWithinRow(rowRef.current, selection);
      if (shouldYieldContextMenu(before, now)) {
        event.stopPropagation();
        return;
      }
      // 엔진이 이 우클릭 때문에 만든 낱말 선택: 앱 메뉴가 열리므로 남기지 않는다.
      if (now) selection?.removeAllRanges();
    },
  };
}

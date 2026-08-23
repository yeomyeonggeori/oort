import { useCallback, useEffect, useRef } from "react";
import {
  IDLE,
  LONG_PRESS_MS,
  pressStep,
  type PressInput,
  type PressState,
} from "@momo/core/features/timeline/longPressModel";

// =============================================================================
// 길게 누르기 (B11), hover의 터치 쪽 짝.
//
// **터치 화면에는 hover가 없다.** `:hover`로 여는 액션은 폰에서는 아무것도로
// 여는 액션이다 — B9가 세운 규칙은 폰이 데스크탑 어포던스를 물려받는 대신 자기
// 어포던스를 갖는다는 것이고, 메시지 행에서는 이것이 그 어포던스다.
//
// 규칙 자체는 `longPressModel.ts`에 있고 테스트가 지킨다. 여기 남은 것은 그
// 규칙을 타이머와 DOM 이벤트에 붙이는 배선뿐이다 — 1라운드에 규칙과 배선이
// 섞여 있었고, 그래서 배선이 규칙을 지워 버린 것을 아무도 보지 못했다.
// =============================================================================

export { LONG_PRESS_MS };

export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

/**
 * 길게 눌러 반응해야 하는 요소에 그대로 펼쳐 넣는다.
 *
 * `onContextMenu`는 **터치일 때만** 막는다: 안드로이드는 길게 누르기에 자기
 * 컨텍스트 메뉴를 이 시트 위로 띄운다. 데스크탑 우클릭은 MessageRow의 공용 액션
 * 메뉴가 받고, 선택 영역이 있으면 브라우저의 부분 복사·검사 메뉴에 양보한다.
 */
export function useLongPress(
  onLongPress: () => void,
  options?: { enabled?: boolean; delayMs?: number }
): LongPressHandlers {
  const enabled = options?.enabled ?? true;
  const delayMs = options?.delayMs ?? LONG_PRESS_MS;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const state = useRef<PressState>(IDLE);
  const isTouch = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const stopTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /**
   * 규칙에 한 걸음 물어보고, 그 대답대로 타이머를 건다.
   *
   * 상태를 ref에 두는 것은 의도다: 이 값이 바뀔 때마다 행이 다시 그려질 이유가
   * 없고, 가상 목록에서 손가락이 지나간 모든 행을 리렌더하는 것은 정확히 스크롤
   * 을 버벅이게 만드는 일이다.
   */
  const step = useCallback(
    (input: PressInput) => {
      const next = pressStep(state.current, input, { enabled });
      state.current = next.state;
      if (next.effect === "none") return;
      // "arm"도 먼저 지운다 — 새 누르기가 이전 타이머를 살려 두면 손을 뗀
      // 메시지의 시트가 열린다.
      stopTimer();
      if (next.effect !== "arm") return;
      timer.current = setTimeout(() => {
        timer.current = null;
        state.current = pressStep(state.current, { kind: "fire" }, { enabled })
          .state;
        callback.current();
      }, delayMs);
    },
    [delayMs, enabled, stopTimer]
  );

  // 행은 누르는 도중에 사라질 수 있다(가상 목록은 스크롤 중에 공격적으로
  // 재활용한다). 살아남은 타이머는 이미 화면에 없는 메시지의 시트를 연다.
  useEffect(() => stopTimer, [stopTimer]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      isTouch.current = event.pointerType === "touch";
      step({
        kind: "down",
        pointerType: event.pointerType,
        point: { x: event.clientX, y: event.clientY },
      });
    },
    [step]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      step({ kind: "move", point: { x: event.clientX, y: event.clientY } });
    },
    [step]
  );

  const onEnd = useCallback(() => step({ kind: "end" }), [step]);

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    if (isTouch.current) event.preventDefault();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: onEnd,
    onPointerCancel: onEnd,
    onPointerLeave: onEnd,
    onContextMenu,
  };
}

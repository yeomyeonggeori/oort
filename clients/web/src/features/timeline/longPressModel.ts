// =============================================================================
// 길게 누르기의 규칙 (B11), 훅 밖의 순수 함수로.
//
// **왜 훅에서 꺼냈는가.** 1라운드의 `useLongPress`는 세 규칙 중 2번("스크롤은
// 누르기가 아니다")을 주석으로 적어 두고 실행하지는 못했다. `origin`을 채운
// 직후 `clear()`를 불렀는데 `clear()`가 하는 일이 바로 그 `origin`을 지우는
// 것이어서, `pointermove` 핸들러의 첫 줄(`if (!start) return`)이 **언제나**
// 조기 반환했다. 10px 게이트는 한 번도 돌지 않았고, 남은 방어는 브라우저가
// 스크롤을 확정했을 때 오는 `pointercancel` 뿐이었다. 그 임계 아래에서 천천히
// 끌다 멈추는 손가락에는 아무 방어도 없었다 — 읽으려고 문지른 화면이 시트를
// 열었다.
//
// 타이머와 DOM에 붙어 있는 한 그 죽은 방어는 테스트로 잡히지 않는다. 규칙만
// 여기로 옮기면 제스처 시퀀스를 그대로 재생할 수 있고, 게이트가 "게이트가
// 돈다"는 사실 자체를 지킨다(`longPressModel.test.ts`).
//
// 세 규칙은 그대로다:
//
// 1. **터치만.** 마우스도 포인터 이벤트를 낸다. 마우스에까지 무장하면 이미
//    액션 버튼이 떠 있는 커서 아래에서 시트가 또 열린다 — 한 제스처를 두고 두
//    어포던스가 다툰다.
// 2. **스크롤은 누르기가 아니다.** 몇 px 넘게 움직인 손가락은 고르는 중이
//    아니라 읽는 중이다. 거리는 **직전 위치가 아니라 시작점**에서 잰다: 1px씩
//    스무 번 밀어도 스무 번 다 "거의 안 움직였다"가 되는 것이 직전 위치
//    기준이고, 그게 이 방어를 우회하는 정확한 경로다.
// 3. **pointerdown에서 preventDefault를 부르지 않는다.** 아직 스크롤로 밝혀질
//    수 있는 제스처를 취소해 버리면 타임라인 전체가 붙잡힌 느낌이 된다.
// =============================================================================

/** 길게 누르기로 인정하는 시간. 스크롤 중에 뜨지 않을 만큼 길고, 고장 났다고 느낄 만큼 길지는 않게. */
export const LONG_PRESS_MS = 450;

/** 이 거리를 넘으면 누르기가 아니라 스크롤이다. */
export const MOVE_TOLERANCE_PX = 10;

export interface PressPoint {
  x: number;
  y: number;
}

export type PressInput =
  | { kind: "down"; pointerType: string; point: PressPoint }
  | { kind: "move"; point: PressPoint }
  /** pointerup · pointercancel · pointerleave — 어느 쪽이든 제스처는 끝났다. */
  | { kind: "end" }
  /** 타이머가 실제로 울렸다. */
  | { kind: "fire" };

/** 무장 상태는 시작점 하나로 표현된다: `null`이면 아무것도 재고 있지 않다. */
export interface PressState {
  origin: PressPoint | null;
}

/**
 * 이 단계가 타이머에 시켜야 하는 일.
 *
 * `"arm"`은 항상 "기존 타이머를 지우고 새로 건다"를 뜻한다 — 두 번째
 * pointerdown이 첫 번째의 타이머를 살려 두면 손을 뗀 메시지의 시트가 열린다.
 */
export type PressEffect = "arm" | "disarm" | "none";

export const IDLE: PressState = { origin: null };

export interface PressStepOptions {
  /** 이 행에 열 것이 있는가(액션 없음·편집 중이면 false). */
  enabled: boolean;
  tolerancePx?: number;
}

function distance(a: PressPoint, b: PressPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 한 단계 전진. 순수 함수이므로 시퀀스를 그대로 재생할 수 있다.
 */
export function pressStep(
  state: PressState,
  input: PressInput,
  options: PressStepOptions
): { state: PressState; effect: PressEffect } {
  const tolerance = options.tolerancePx ?? MOVE_TOLERANCE_PX;

  switch (input.kind) {
    case "down": {
      // 규칙 1. 마우스는 여기서 끝난다 — 그리고 혹시 남아 있던 무장도 푼다.
      if (!options.enabled || input.pointerType !== "touch") {
        return { state: IDLE, effect: "disarm" };
      }
      return { state: { origin: input.point }, effect: "arm" };
    }
    case "move": {
      // 무장하지 않은 손가락의 움직임은 그냥 스크롤이다.
      if (state.origin === null) return { state, effect: "none" };
      // 규칙 2. 시작점에서 잰다.
      if (distance(state.origin, input.point) > tolerance) {
        return { state: IDLE, effect: "disarm" };
      }
      return { state, effect: "none" };
    }
    case "end":
      return { state: IDLE, effect: "disarm" };
    case "fire":
      // 시트가 열린 뒤의 움직임은 더 이상 이 제스처의 것이 아니다.
      return { state: IDLE, effect: "none" };
  }
}

import { TOOLTIP_SKIP_DELAY_MS } from "@/design/motion";

// =============================================================================
// 툴팁 무리: 「옮겨 다닐 때는 지연이 없다」의 기억 (#5192).
//
// 공용 `Tooltip`은 처음 가리키면 `TOOLTIP_DELAY_MS`만큼 기다린다. 그런데 도구 막대의 단추를 하나씩 훑어 읽는 사람에게
// 단추마다 같은 지연을 매기면 한 줄 읽는 데 단추 수만큼의 기다림이 든다. 그래서 **툴팁이 떠 있거나 방금(`TOOLTIP_SKIP_DELAY_MS`
// 안에) 닫혔으면 다음 툴팁은 지연 없이** 뜬다(Radix `skipDelayDuration`과 같은 규칙, Buzz가 쓰는 동작이다).
//
// 이 모듈이 아는 것은 세 가지다: 떠 있는 툴팁의 수(`open`), 방금 닫혔는지(`recent`), 마운트된 툴팁의 수(`mounted`).
// 앱 전체가 한 무리다: 사이드바의 툴팁에서 머리 단추로 옮겨 가도 옮겨 다님이다.
//
// 왜 시각 비교가 아니라 타이머인가: 「방금」을 `performance.now()` 차이로 재면 가짜 타이머를 쓰는 시험이 시계를 따로 가짜로
// 만들어야 하고(안 만들면 창이 안 닫힌다), 한 번 새면 다음 시험에 지연 없이 뜨는 툴팁이 나온다. 타이머는 가짜 타이머가 그대로
// 움직인다. 시험 사이로 새지 않게 **마운트된 툴팁이 하나도 없으면 상태를 비운다**(시험은 매번 언마운트로 끝난다).
//
// 지나가는 포인터(빠른 통과)를 거르는 일은 여기서 하지 않는다. 그건 처음 지연의 몫이다: 트리거 위에 지연만큼 머물러야 타이머가
// 끝나고, 그 전에 나가면 취소되어 아무것도 뜨지 않고 이 모듈의 `open`·`recent`에도 닿지 않는다(떠 본 적 없는 툴팁은 무리를
// 깨우지 않는다).
// =============================================================================

interface GroupState {
  mounted: number;
  open: number;
  recent: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const state: GroupState = { mounted: 0, open: 0, recent: false, timer: null };

function clearTimer(): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function reset(): void {
  clearTimer();
  state.mounted = 0;
  state.open = 0;
  state.recent = false;
}

export const tooltipGroup = {
  /**
   * 툴팁이 마운트될 때 부른다. 돌려준 함수는 언마운트 때 부른다. 마지막 하나가 사라지면 상태를 비운다:
   * 이어받을 이전 툴팁이 이미 없다(시험이 서로 새지 않는 근거이기도 하다).
   */
  attach(): () => void {
    state.mounted += 1;
    return () => {
      state.mounted = Math.max(0, state.mounted - 1);
      if (state.mounted === 0) reset();
    };
  },

  /** 지금 가리키기 시작한 툴팁이 기다릴 시간. 떠 있는 툴팁이 있거나 방금 닫혔으면 0, 아니면 처음 지연이다. */
  delayFor(firstDelayMs: number): number {
    return state.open > 0 || state.recent ? 0 : firstDelayMs;
  },

  /** 툴팁이 떴다. */
  opened(): void {
    state.open += 1;
    state.recent = false;
    clearTimer();
  },

  /** 떠 있던 툴팁이 닫혔다(포인터가 나가도, 눌려도, 초점이 나가도, Esc도, 트리거가 사라져도). 마지막 하나가 닫히면 「방금」이 시작된다. */
  closed(): void {
    if (state.open === 0) return;
    state.open -= 1;
    if (state.open > 0) return;
    state.recent = true;
    clearTimer();
    state.timer = setTimeout(() => {
      state.timer = null;
      state.recent = false;
    }, TOOLTIP_SKIP_DELAY_MS);
  },

  /** 상태를 비운다(시험이 쓴다). */
  reset,
};

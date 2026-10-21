// =============================================================================
// 메뉴 ↔ 카드 변신의 상태 — 순수 절반 (#4181 Goal 3).
//
// 변신은 두 값이다: **어디로 가는가**(`target`)와 **도착했는가**(`settled`). 네 단계(메뉴 ·
// 펼치는 중 · 카드 · 접는 중)는 그 둘에서 나온다. 중간에 방향을 바꿀 수 있다(펼치는 중에
// 뒤로, 접는 중에 사진) — 스프링이 지금 값에서 새 목표로 이어 가므로 되감기가 튀지 않는다.
//
// 도착 신호(`settled`)는 **목표가 같을 때만** 받는다. 펼치다 접기로 바꾸면 펼침 스프링이
// 「끝나지 못한 채」 끊기고, 그 신호가 늦게 도착해 접는 중을 「카드」로 읽게 만들면 안 된다.
// =============================================================================

export type MorphTarget = 'menu' | 'card';
export type MorphPhase = 'menu' | 'opening' | 'card' | 'closing';

export interface MorphState {
  target: MorphTarget;
  settled: boolean;
}

export type MorphEvent =
  | {type: 'open'}
  | {type: 'back'}
  | {type: 'settled'; target: MorphTarget};

export const MORPH_START: MorphState = {target: 'menu', settled: true};

export function morphReduce(state: MorphState, event: MorphEvent): MorphState {
  switch (event.type) {
    case 'open':
      return state.target === 'card' ? state : {target: 'card', settled: false};
    case 'back':
      return state.target === 'menu' ? state : {target: 'menu', settled: false};
    case 'settled':
      return event.target === state.target && !state.settled
        ? {target: state.target, settled: true}
        : state;
  }
}

export function morphPhase(state: MorphState): MorphPhase {
  if (state.settled) return state.target;
  return state.target === 'card' ? 'opening' : 'closing';
}

/** 카드의 내용이 살아 있어야 하는가 — 펼치기 시작부터 접기가 **끝날 때까지**. 권한 읽기는 여기서 시작한다. */
export function cardIsLive(state: MorphState): boolean {
  return state.target === 'card' || !state.settled;
}

/** 메뉴가 눌릴 수 있는가 — 완전히 돌아온 뒤에만. 접히는 동안 두 번 누르면 카드가 다시 열린다. */
export function menuIsInteractive(state: MorphState): boolean {
  return state.target === 'menu' && state.settled;
}

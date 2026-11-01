import {useRef} from 'react';
import type {GestureResponderEvent} from 'react-native';

import type {TapTouchHandlers} from './tapDismiss';

// =============================================================================
// 대화 목록을 아래로 끌면 입력창이 쉰다 (#4665, B2 — owner 10-27)
//
// owner(10-27): 「채팅을 치다가 스크롤을 내리면 타이핑 영역이 최소화되게, 보낸 뒤에도 자연스럽게 스크롤하며 최소화」.
// #4614 가 만든 「쉬기」 길(자판을 내리고, 글이 남은 입력창은 한 줄 알약으로 접는다 — `tapDismiss.ts` → `Timeline.restDock` → `dockFollow.rest`)을 탭에 이어 **끌기**에도 잇는다.
// 이 파일은 쉬는 동작이 아니라 **언제 쉬는가**만 정한다. 쉬는 동작은 탭과 같은 함수를 `Timeline` 이 건넨다 — 두 길이 서로 다른 「쉬기」를 갖지 않는다.
//
// ## 언제 — 손가락이 목록을 끌며 아래로 `DRAG_REST_PT`(48pt) 누적되었을 때
//
// 끌기 **즉시**(`keyboardDismissMode="on-drag"`)는 읽으려고 살짝 밀어도 첫 1px 에 자판이 사라진다. 문턱을 두면 살짝 민 손에는 자판이 남고 의도적으로 민 손에는 바로 접힌다.
// 값은 Buzz(`keyboard_dismiss_on_drag.dart` 의 `keyboardDismissDragThreshold`)와 같고 owner 가 10-27 에 이 값으로 결정했다. 그래서 `Timeline` 의 `keyboardDismissMode` 는 `none` 이다
// (`on-drag` 로 두면 UIKit 이 문턱보다 먼저 첫 1px 에 자판을 걷는다).
//
// - **손가락을 읽는다. 스크롤 오프셋을 읽지 않는다.** 오프셋은 바닥·꼭대기의 늘어남(고무줄)에서 손가락보다 덜 움직이고, 이 목록이 스스로 내는 이동(입력창이 줄 때의 바닥 맞춤·새 줄 따라가기·점프)과
//   `maintainVisibleContentPosition` 보정까지 섞인다. 손가락의 화면 높이(`pageY`, `tapDismiss` 가 이미 읽는 `onTouchMove` 와 같은 좌표)는 손가락이 움직인 만큼만 나온다.
// - **아래로만 쌓는다.** 아래 = 이전 대화를 읽는 방향이다. 직전 위치보다 **위로 한 번이라도** 가면 누적은 0 이다(Buzz 와 같다 — 오르내리며 헤매는 손은 아무리 해도 문턱에 닿지 않는다).
//   같은 높이(가로로만 움직임)는 쌓지도 지우지도 않는다.
// - **목록이 손가락에 끌리는 동안만 센다**(`onScrollBeginDrag` ~ `onScrollEndDrag`). 손을 뗀 뒤의 **관성**은 손가락이 아니다 — 던진 목록이 아무리 멀리 미끄러져도 문턱에 닿지 않는다
//   (Buzz 도 손가락이 없는 스크롤 알림은 0 으로 되돌린다). 손가락은 닿아 있으나 목록을 끌지 않는 움직임(관성 중 막 닿아 멈추려는 손가락의 첫 움직임, 목록 밖 응답자가 가져간 제스처)도 세지 않는다.
//   프로그램 이동(점프·꼬리 따라가기)에는 손가락이 없으니 애초에 이 판정에 오지 않는다. 끌기가 시작되기 **전**의 움직임(터치 문턱 안)도 세지 않는다 — Buzz 가 `ScrollStartNotification` 에서
//   0 으로 시작하는 것과 같다.
// - **한 제스처에 한 번.** 쉬라고 한 손가락은 뗄 때까지 다시 알리지 않는다. 손가락이 둘이면(확대·두 손가락 스크롤) 그 제스처는 세지 않는다.
//
// ## 순수 판정과 훅
//
// `dragRestStep` 은 순수 함수다 — 제스처 시퀀스를 그대로 재생해 시험한다(`dragRest.test.ts`). `useDragRest` 는 그것을 터치 이벤트와 목록의 끌기 시작·끝 알림에 붙이는 배선일 뿐이다.
// 터치는 **관찰만** 한다(응답자를 잡지 않는다 — `tapDismiss.ts` 머리말과 같은 이유: 링크·칩·길게 누르기·행 탭이 그대로 산다).
//
// **예비안(런타임 미확인 — 스택 검증 메모).** 문턱에서 접는 순간 손가락 밑 목록이 튀면(`contentOffset` 점프) 문턱을 넘은 **손을 뗄 때** 접도록 이 한 곳(`move` 단계의 `rest`)을
// `up` 단계로 옮긴다. 그 밖의 다른 곳은 안 바뀐다.
// =============================================================================

/**
 * 손가락이 목록을 끌며 아래로 이만큼(pt) **누적**되면 입력창이 쉰다 — 이 값이 「한 곳의 상수」다. 문턱에 **닿으면**(`>=`) 쉰다: 47pt 는 아니고 48pt 는 맞다.
 * (Buzz `keyboardDismissDragThreshold` = 48 — 읽는 속도의 밀기는 닿지 않고 의도적으로 밀어내는 스와이프는 바로 닿는 값. owner 10-27 결정.)
 */
export const DRAG_REST_PT = 48;

/**
 * 끌기로 입력창이 쉬기 시작한 뒤 이 시간(ms) 동안은 **손가락이 떠난 뒤에도** 목록이 바닥을 따라가지 않는다(`Timeline` 의 도크 처리기·`onLayout`). 입력창 접힘 스프링(`COMPOSER_EXPAND_SPRING`,
 * 감쇠비 ≈ 0.92 — 눈에 보이는 끝까지 약 250ms)은 문턱을 넘은 **뒤에** 시작해서 손을 뗀 뒤에도 몇 프레임 남는다. 그 프레임마다 네이티브 `scrollToEnd` 를 부르면 방금 위로 읽으러 간 사람의 목록이
 * 끝으로 되돌아간다(「따라가는 중」은 바닥에서 120pt 안이면 켜져 있다). 시한이 있는 막이라 풀리지 못하고 남는 일이 없다 — 손을 뗀 뒤의 관성 신호(`onMomentumScrollEnd`)에 매이지 않는다.
 * 탭으로 쉴 때는 이 막이 없다: 손가락이 없으니 꼬리가 입력창을 따라 내려가는 것이 맞다(#4614·#4518).
 */
export const DRAG_REST_FOLLOW_HOLD_MS = 400;

/** 손가락 하나가 쌓는 것. `lastY === null` 이면 아직 이 제스처의 첫 위치를 모른다. */
export interface DragRestState {
  /** 직전 손가락의 화면 높이(`pageY`). */
  lastY: number | null;
  /** 아래로 쌓인 거리(pt). 위로 한 번 가면 0. */
  travel: number;
  /** 목록이 손가락에 끌리고 있다 — `onScrollBeginDrag` 부터 `onScrollEndDrag`(손을 떼는 순간) 까지. 관성은 여기에 들지 않는다. */
  dragging: boolean;
  /** 이 제스처는 세지 않는다 — 손가락이 둘이었다. 마지막 손가락이 떼어질 때까지 이어진다. */
  broken: boolean;
  /** 이 제스처는 이미 쉬라고 알렸다 — 한 제스처에 한 번. */
  fired: boolean;
}

export const IDLE_DRAG_REST: DragRestState = {
  lastY: null,
  travel: 0,
  dragging: false,
  broken: false,
  fired: false,
};

/**
 * 입력의 종류. 문자열이 아니라 숫자인 까닭: 문구 장부(`i18n/tooling/direct-copy.mjs`)가 `'down'` 같은 한 단어 문자열 값을 사용자 문구로 세어 새 파일마다 장부가 늘어난다.
 * 이것은 문구가 아니라 판정의 갈래 표식이다.
 */
export const DragRestKind = {Down: 0, Move: 1, Up: 2, Cancel: 3, DragBegin: 4, DragEnd: 5} as const;

export type DragRestInput =
  /** `touches` = 이 이벤트 **뒤에** 화면에 닿아 있는 손가락 수. 둘째 손가락이 닿으면 2 다. */
  | {kind: typeof DragRestKind.Down; y: number; touches: number}
  | {kind: typeof DragRestKind.Move; y: number}
  /** `touches` = 이 손가락을 뗀 **뒤에** 남은 손가락 수. 마지막 손가락이면 0. */
  | {kind: typeof DragRestKind.Up; touches: number}
  /** 시스템이 터치를 가져갔다(스크롤·전화·알림). */
  | {kind: typeof DragRestKind.Cancel}
  /** 목록이 손가락에 끌리기 시작했다(`onScrollBeginDrag`). 이 순간부터 쌓는다. */
  | {kind: typeof DragRestKind.DragBegin}
  /** 손가락이 목록을 놓았다(`onScrollEndDrag`). 그 뒤의 관성은 쌓지 않는다. */
  | {kind: typeof DragRestKind.DragEnd};

/** 한 단계 전진. `rest` 는 문턱에 **처음** 닿은 단계에서만 참이다(한 제스처에 한 번). */
export function dragRestStep(
  state: DragRestState,
  input: DragRestInput,
): {state: DragRestState; rest: boolean} {
  switch (input.kind) {
    case DragRestKind.Down: {
      if (!Number.isFinite(input.y)) return {state, rest: false};
      // 첫 손가락은 새로 시작한다(이전 제스처의 끝을 놓쳤어도 여기서 풀린다). `dragging` 은 건드리지 않는다: 그것은 목록의 끌기 시작·끝이 정하고, 손가락이 닿는 순간의 사실이 아니다.
      if (input.touches <= 1) {
        return {
          state: {lastY: input.y, travel: 0, dragging: state.dragging, broken: false, fired: false},
          rest: false,
        };
      }
      // 둘째 손가락은 이 제스처를 깨뜨린다 — 확대·두 손가락 스크롤이 문턱을 채우면 안 된다.
      return {state: {...state, broken: true}, rest: false};
    }
    case DragRestKind.Move: {
      if (!Number.isFinite(input.y)) return {state, rest: false};
      // 첫 위치를 모르면(닿는 것을 못 봤다) 위치만 적는다 — 어디서 얼마나 움직였는지 모르는 거리를 쌓지 않는다.
      if (state.lastY === null) return {state: {...state, lastY: input.y}, rest: false};
      const delta = input.y - state.lastY;
      if (state.broken || state.fired) return {state: {...state, lastY: input.y}, rest: false};
      // 위로 한 번이라도 가면 0. 같은 높이(delta === 0)는 그대로 둔다.
      let travel = state.travel;
      if (delta < 0) travel = 0;
      // 목록이 손가락에 끌리는 동안의 아래 움직임만 쌓는다. 끌지 않는 손(관성 중 막 닿은 손가락·목록 밖 응답자의 제스처)은 쌓지 않는다.
      else if (state.dragging) travel += delta;
      if (travel >= DRAG_REST_PT) {
        return {state: {...state, lastY: input.y, travel: 0, fired: true}, rest: true};
      }
      return {state: {...state, lastY: input.y, travel}, rest: false};
    }
    case DragRestKind.Up: {
      // 아직 손가락이 남았다 — 이 제스처는 세지 않고 마지막 손가락이 떼어질 때까지 기다린다.
      if (input.touches > 0) return {state: {...state, broken: true}, rest: false};
      // 마지막 손가락이 떼어졌다: 이 손가락의 일은 끝났다. 손을 뗀 뒤의 관성은 손가락이 아니므로 끌기도 여기서 끝난다 — `onScrollEndDrag` 가 곧 오든 늦든 같다.
      return {state: IDLE_DRAG_REST, rest: false};
    }
    case DragRestKind.Cancel:
      return {state: IDLE_DRAG_REST, rest: false};
    case DragRestKind.DragBegin:
      // 새 끌기는 0 에서 시작한다 — 한 손가락이 끌기를 끝내고 다시 시작해도(Buzz 의 `ScrollStartNotification`) 앞의 누적을 이어받지 않는다.
      return {state: {...state, dragging: true, travel: 0}, rest: false};
    case DragRestKind.DragEnd:
      return {state: {...state, dragging: false}, rest: false};
  }
}

export interface DragRestHandlers {
  onTouchStart: (event: GestureResponderEvent) => void;
  onTouchMove: (event: GestureResponderEvent) => void;
  onTouchEnd: (event: GestureResponderEvent) => void;
  onTouchCancel: (event: GestureResponderEvent) => void;
  /** 목록의 `onScrollBeginDrag` 에서 부른다. */
  onScrollBeginDrag: () => void;
  /** 목록의 `onScrollEndDrag` 에서 부른다. */
  onScrollEndDrag: () => void;
}

/**
 * 같은 터치 이벤트를 읽는 두 처리기 벌(탭 · 끌기)을 한 벌로 묶는다 — 목록의 터치 prop 은 한 벌이다. 두 벌이 둘 다 신원이 안정하면(`useTapDismiss`·`useDragRest` 가 그렇다) 묶음도 한 번만 만들면 된다.
 * 둘은 서로의 결과를 보지 않는다: 탭은 10pt 미만·250ms 미만, 끌기는 48pt 누적이라 한 손가락이 둘 다 될 수 없다.
 */
export function joinTouchHandlers(a: TapTouchHandlers, b: TapTouchHandlers): TapTouchHandlers {
  return {
    onTouchStart: event => {
      a.onTouchStart(event);
      b.onTouchStart(event);
    },
    onTouchMove: event => {
      a.onTouchMove(event);
      b.onTouchMove(event);
    },
    onTouchEnd: event => {
      a.onTouchEnd(event);
      b.onTouchEnd(event);
    },
    onTouchCancel: event => {
      a.onTouchCancel(event);
      b.onTouchCancel(event);
    },
  };
}

function pageY(event: GestureResponderEvent): number {
  return event.nativeEvent.pageY;
}

function touchCount(event: GestureResponderEvent): number {
  return event.nativeEvent.touches?.length ?? 0;
}

/**
 * 목록(`FlatList` → `ScrollView`)의 터치 prop 과 끌기 시작·끝 prop 에 건다. 응답자를 잡지 않는다 — 읽기만 하고, 문턱에 닿는 **그 순간**(손을 떼기 전, 끄는 도중) `onRest` 를 한 번 부른다.
 *
 * 핸들러 신원은 처음부터 끝까지 같다(`ref`). 이 목록은 `React.memo` 로 렌더를 아끼는 곳이라(`Timeline` 의 `memo` 주석) 터치 prop 이 렌더마다 바뀌면 안 된다.
 */
export function useDragRest(onRest: () => void): DragRestHandlers {
  const stateRef = useRef<DragRestState>(IDLE_DRAG_REST);
  const onRestRef = useRef(onRest);
  onRestRef.current = onRest;

  return useRef<DragRestHandlers>({
    onTouchStart: event => {
      stateRef.current = dragRestStep(stateRef.current, {
        kind: DragRestKind.Down,
        y: pageY(event),
        touches: touchCount(event),
      }).state;
    },
    onTouchMove: event => {
      const step = dragRestStep(stateRef.current, {kind: DragRestKind.Move, y: pageY(event)});
      stateRef.current = step.state;
      if (step.rest) onRestRef.current();
    },
    onTouchEnd: event => {
      stateRef.current = dragRestStep(stateRef.current, {kind: DragRestKind.Up, touches: touchCount(event)}).state;
    },
    onTouchCancel: () => {
      stateRef.current = dragRestStep(stateRef.current, {kind: DragRestKind.Cancel}).state;
    },
    onScrollBeginDrag: () => {
      stateRef.current = dragRestStep(stateRef.current, {kind: DragRestKind.DragBegin}).state;
    },
    onScrollEndDrag: () => {
      stateRef.current = dragRestStep(stateRef.current, {kind: DragRestKind.DragEnd}).state;
    },
  }).current;
}

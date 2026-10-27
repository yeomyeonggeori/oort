import {LONG_PRESS_MS, MOVE_TOLERANCE_PX} from '@momo/core/features/timeline/longPressModel';
import {useRef} from 'react';
import type {GestureResponderEvent} from 'react-native';

// =============================================================================
// 대화 목록의 탭 = 자판을 내리고 입력창을 쉬게 한다 (#4614).
//
// owner(10-26, iOS 3055): 「메세지창이 포커싱된 상태에서 메세지 리스트를 누르면 채팅창이 닫히는 그런 UX … 입력한 상태에서나 메세지 보낸 이후에 채팅창을
// 최소화하기 너무 어려워」.
//
// ## 어느 응답자가 탭을 삼키는가 (시뮬레이터 16 Pro · iOS 26.5 실측, `measure/tapDismiss.tsx`)
//
// 처음 가설은 「행(`Pressable`) 이나 그 위의 무엇이 탭을 삼켜 `handled` 가 자판을 못 내린다」였다. 실측은 반대다 — 본문·빈 곳·날짜 알약·보내는 중인 메아리는 **이미 내려간다**:
//
//   - 말풍선 본문: 행 `Pressable` 이 응답자를 쥐고 `onRowPress` 가 `Keyboard.isVisible()` 이면 `Keyboard.dismiss()` 를 부른다(goal RN-U1, 8/3). `ScrollView` 는 탭을 못 본다.
//   - 빈 곳·날짜 알약·보내는 중인 메아리(`Pressable` 이 없다): 아무도 응답자를 안 쥐니 `ScrollView` 의 `onStartShouldSetResponder`(`handled` 의 몫)가 쥐고,
//     손을 뗄 때 `TextInputState.blurTextInput` 으로 입력창을 놓는다.
//
// 삼키는 것은 **자기 동작이 있는 요소** 전부다: 링크(`Text onPress`) · 아바타 · 작성자 줄(행 전체 폭이라 이름 오른쪽 **빈 곳**까지) · 답글 표식 · 반응 칩 · 스레드 롤업.
// 이들은 응답자를 쥐고 자기 동작만 하며, `handled` 의 정의대로 「처리된 탭」은 자판을 안 내린다. 그래서 목록의 상당한 면이 「눌러도 최소화되지 않는 면」이었다.
//
// ## 그래서 요소마다 고치지 않고 목록에서 한 번 본다
//
// 요소마다 `Keyboard.dismiss()` 를 심으면 **새 요소가 생길 때마다 기본이 「안 내림」** 이 된다(카드 단추·첨부·코드 복사가 이미 그렇다). 기본을 「내림」으로 하려면 한 곳에서 봐야 한다.
// 이 판정은 터치 이벤트(`onTouchStart/Move/End`)를 **관찰만** 한다. 터치 이벤트는 응답자 협상과 별개로 대상에서 조상으로 올라오므로, 응답자를 새로 잡지 않고도(= 링크·칩·길게 누르기·
// 행 탭의 스레드 열기는 그대로) 어느 요소의 탭이든 목록이 듣는다. 같은 길을 `Composer`(끌어 내리기)·`useLongPress` 가 이미 쓴다.
//
// 이벤트 순서는 실측이다: 응답자의 손 뗌(`onPress`) → 그다음 이 목록의 `onTouchEnd`. 그래서 행 탭의 「자판이 올라와 있으면 첫 탭은 닫기, 아니면 스레드」(`MessageRow.onRowPress`)가 **먼저** 자판 상태를 읽고,
// 이 판정은 그 뒤에 나머지를 거둔다.
//
// ## 탭의 정의
//
// 손가락 **하나**가 시작점에서 `TAP_SLOP_PT` 미만 움직이고 `TAP_MAX_MS` 미만에 떼어졌다. 끌기는 이 판정의 일이 아니다 — 목록은 지금처럼 `keyboardDismissMode="on-drag"` 가 내린다.
// 거리는 직전 위치가 아니라 **시작점**에서 잰다(`longPressModel.ts` 규칙 2: 1pt 씩 스무 번 밀어도 스무 번 다 「거의 안 움직였다」가 되는 길을 막는다). 좌표는 `pageX/pageY` 다 —
// 손가락이 목록을 끌면 내용이 손가락을 따라가서 `locationX/Y`(대상 뷰 기준)는 거의 안 변한다(`useLongPress.ts` 머리말).
//
// **시간 상한은 길게 누르기(`LONG_PRESS_MS`=250)와 같다.** 이슈 처음 문구는 300ms 였고 planner 가 10-27 에 250ms 로 고쳤다: 250ms 에 시트가 열리는 손가락을 「탭」으로도 세면
// 시트가 열린 채 입력창이 접힌다 — 두 제스처는 겹치면 안 된다. 그래서 탭은 「길게 누르기가 열리기 **전에** 떼어진 손」이다.
// =============================================================================

/**
 * 시작점에서 이 거리(pt) **미만**이어야 탭이다. 길게 누르기가 취소되는 움직임 문턱(`MOVE_TOLERANCE_PX`)과 **같은 값을 읽는다** — 한 손가락의 제스처가 「길게 누르기 → 끌기 → 탭」으로 갈리는 경계가 한 곳에서 정해진다
 * (사본을 따로 두면 한쪽만 바뀌는 날 손가락이 둘 다 아니거나 둘 다인 틈이 생긴다. 디자인 리뷰 #4614 M3).
 */
export const TAP_SLOP_PT = MOVE_TOLERANCE_PX;

/**
 * 이 시간(ms) **미만**에 떼어져야 탭이다. 길게 누르기가 열리는 시간(250)과 같다 — 둘이 겹치지 않는다(이슈의 처음 300ms 는 10-27 에 이 값으로 정정). 길게 누르기 상수가 바뀌면 이 값이 따라간다.
 */
export const TAP_MAX_MS = LONG_PRESS_MS;

export interface TapPoint {
  x: number;
  y: number;
}

export type TapInput =
  /** `touches` = 이 이벤트 **뒤에** 화면에 닿아 있는 손가락 수(`nativeEvent.touches.length`). 둘째 손가락이 닿으면 2 다. */
  | {kind: 'down'; point: TapPoint; at: number; touches: number}
  | {kind: 'move'; point: TapPoint}
  /** `touches` = 이 손가락을 뗀 **뒤에** 남은 손가락 수. 마지막 손가락이면 0. */
  | {kind: 'up'; at: number; touches: number}
  /** 시스템이 터치를 가져갔다(스크롤·전화·알림). */
  | {kind: 'cancel'};

/** `origin === null` 이면 아무것도 재고 있지 않다. `broken` 은 이 제스처가 이미 탭이 아니라고 밝혀졌다는 뜻이다(끌었다·손가락이 둘이었다). */
export interface TapState {
  origin: TapPoint | null;
  startedAt: number;
  broken: boolean;
}

export const IDLE_TAP: TapState = {origin: null, startedAt: 0, broken: false};

function distance(a: TapPoint, b: TapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 한 단계 전진. 순수 함수이므로 제스처 시퀀스를 그대로 재생할 수 있다(`tapDismiss.test.ts`). `tap` 은 마지막 손가락이 **탭으로** 떼어진 단계에서만 참이다. */
export function tapStep(state: TapState, input: TapInput): {state: TapState; tap: boolean} {
  switch (input.kind) {
    case 'down': {
      // 첫 손가락은 새로 시작한다(이전 제스처의 끝을 놓쳤어도 여기서 풀린다). 둘째 손가락은 이 제스처를 깨뜨린다 — 확대·두 손가락 스크롤이 탭이 되면 안 된다.
      if (input.touches <= 1) {
        return {state: {origin: input.point, startedAt: input.at, broken: false}, tap: false};
      }
      return {state: {...state, broken: true}, tap: false};
    }
    case 'move': {
      if (state.origin === null || state.broken) return {state, tap: false};
      if (distance(state.origin, input.point) >= TAP_SLOP_PT) {
        return {state: {...state, broken: true}, tap: false};
      }
      return {state, tap: false};
    }
    case 'up': {
      if (state.origin === null) return {state: IDLE_TAP, tap: false};
      // 아직 손가락이 남았다 — 이 제스처는 탭이 아니고, 마지막 손가락이 떼어질 때까지 기다린다.
      if (input.touches > 0) return {state: {...state, broken: true}, tap: false};
      const tap = !state.broken && input.at - state.startedAt < TAP_MAX_MS;
      return {state: IDLE_TAP, tap};
    }
    case 'cancel':
      return {state: IDLE_TAP, tap: false};
  }
}

export interface TapTouchHandlers {
  onTouchStart: (event: GestureResponderEvent) => void;
  onTouchMove: (event: GestureResponderEvent) => void;
  onTouchEnd: (event: GestureResponderEvent) => void;
  onTouchCancel: (event: GestureResponderEvent) => void;
}

/**
 * 네이티브가 찍은 시각(ms, `UITouch.timestamp`). JS 가 바빠 핸들러가 늦게 불려도 손가락의 시간은 그대로다. 없으면(시험·하네스 일부) 지금 시각이다 —
 * 같은 제스처 안에서 두 시계가 섞이지 않도록 이벤트마다 같은 길로 읽는다.
 */
function stamp(event: GestureResponderEvent): number {
  const {timestamp} = event.nativeEvent;
  return typeof timestamp === 'number' ? timestamp : Date.now();
}

function pointOf(event: GestureResponderEvent): TapPoint {
  return {x: event.nativeEvent.pageX, y: event.nativeEvent.pageY};
}

function touchCount(event: GestureResponderEvent): number {
  return event.nativeEvent.touches?.length ?? 0;
}

/**
 * 목록(`FlatList` → `ScrollView`)의 터치 prop 에 그대로 펼친다. 응답자를 잡지 않는다 — 읽기만 하고, 탭이면 `onTap` 을 **손을 뗀 순간** 부른다.
 *
 * 핸들러 신원은 처음부터 끝까지 같다(`ref`). 이 목록은 `React.memo` 로 렌더를 아끼는 곳이라(`Timeline` 의 `memo` 주석) 터치 prop 이 렌더마다 바뀌면 안 된다.
 */
export function useTapDismiss(onTap: () => void): TapTouchHandlers {
  const stateRef = useRef<TapState>(IDLE_TAP);
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  return useRef<TapTouchHandlers>({
    onTouchStart: event => {
      stateRef.current = tapStep(stateRef.current, {
        kind: 'down',
        point: pointOf(event),
        at: stamp(event),
        touches: touchCount(event),
      }).state;
    },
    onTouchMove: event => {
      stateRef.current = tapStep(stateRef.current, {kind: 'move', point: pointOf(event)}).state;
    },
    onTouchEnd: event => {
      const step = tapStep(stateRef.current, {
        kind: 'up',
        at: stamp(event),
        touches: touchCount(event),
      });
      stateRef.current = step.state;
      if (step.tap) onTapRef.current();
    },
    onTouchCancel: () => {
      stateRef.current = IDLE_TAP;
    },
  }).current;
}

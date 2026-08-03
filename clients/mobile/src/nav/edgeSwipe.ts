import {MOVE_TOLERANCE_PX} from '@momo/core/features/timeline/longPressModel';

// =============================================================================
// 좌측 엣지에서 슥 넘기면 뒤로 — **규칙만**. 배선은 `EdgeSwipeBack.tsx` 다.
//
// 성재, iPhone 17: "뒤로가기 버튼 뿐만 아니라, 화면 좌측을 슥 넘기면 뒤로가게
// 해주면 안돼?"
//
// ## 왜 규칙이 컴포넌트 밖에 있는가
//
// `useLongPress` 가 이미 이 교훈의 값을 치렀다. 규칙이 타이머와 터치 핸들러에
// 붙어 있으면 **테스트로 재생할 수 없고, 재생할 수 없는 방어는 죽어도 아무도
// 모른다** — 웹(B11)에서 10px 게이트가 한 줄의 순서 실수로 한 번도 돌지 않은 채
// 살아 있는 척했다. 이 제스처는 그때보다 위험하다: 그것은 시트 하나를 잘못
// 열었지만 이것은 **사람이 보던 화면을 통째로 닫는다**. 그래서 판정은 전부
// 여기, PanResponder 가 한 줄도 개입하지 않는 순수 함수에 있다.
//
// 그리고 이 파일이 존재하는 진짜 이유는 **충돌**이다. 이 제스처는 이미 같은
// 유리 위에서 살고 있는 셋과 손가락을 두고 다툰다:
//
//   ① 메시지 길게 누르기 (250ms, page 좌표 10px 게이트)
//   ② 타임라인 세로 스크롤
//   ③ 컴포저 입력
//
// 셋 중 무엇도 깨지면 안 된다는 것은 의견이 아니라 요구사항이고, 규칙이 값으로
// 있어야 그 셋의 제스처 시퀀스를 그대로 재생해서 **"가져가지 않았다"를 증명**할 수
// 있다. `__tests__/edgeSwipe.test.ts` 가 그 증명이다.
//
// ## 세 개의 문턱, 그리고 각각이 무엇을 막는가
//
// **시작점이 엣지 안이어야 한다** ({@link EDGE_WIDTH_PX}). 화면 한가운데서 시작한
// 수평 드래그는 뒤로가기가 아니다 — 그것까지 먹으면 코드블록의 가로 스크롤과
// 텍스트 선택이 전부 이 제스처에게 잡아먹힌다. 시작점 하나로 걸러지므로 나머지
// 판정은 손가락 하나당 많아야 한 번만 돈다.
//
// **세로가 먼저 움직였으면 영영 탈락이다** ({@link SCROLL_LOCK_PX}). 이것이
// 세로 스크롤을 지키는 핵심이고, 비율 판정만으로는 부족한 이유이기도 하다: 손가락은
// 대각선으로도 움직이므로, 아래로 40px 간 뒤 오른쪽으로 30px 가는 손가락은 어느
// 순간 비율을 통과한다. 스크롤 도중에 화면이 뒤로 넘어가는 것은 이 배치가 고치려는
// 문제보다 나쁘다. 그래서 탈락에는 되돌아올 길을 두지 않는다 — 손을 떼야 다시
// 시작한다. `pressStep` 의 무장 해제와 같은 모양이고, 같은 이유다.
//
// **가로로 {@link ACTIVATE_PX} 만큼 갔고, 그것이 세로보다 뚜렷해야 한다.**
//
// ## ACTIVATE_PX 는 왜 코어의 상수에서 유도되는가
//
// 길게 누르기는 시작점에서 {@link MOVE_TOLERANCE_PX}(10px)를 넘게 움직이면 무장을
// 푼다. 이 제스처가 화면을 가져가는 문턱을 **그보다 위**에 두면 다음이 공짜로
// 참이 된다:
//
//   **이 제스처가 가져간 손가락은, 가져가는 순간 이미 길게 누르기가 아니었다.**
//
// 즉 두 제스처는 다투지 않는다. 다투지 않게 조율한 것이 아니라, 겹치는 구간이
// 아예 없다. 숫자를 그냥 12로 적어 두면 이 성질은 주석의 주장으로만 남고 코어의
// 상수가 바뀌는 날 조용히 거짓이 된다. 유도해 두면 그날 같이 움직인다.
//
// 반대 방향(코어가 10보다 커지는 경우)도 안전하다. 가져가려면 여전히 가로로 그
// 이상 가야 하므로 문턱은 항상 위에 있다.
// =============================================================================

/**
 * 시작점이 화면 왼쪽에서 이 안이어야 뒤로가기가 될 수 있다, 단위 pt.
 *
 * 24 는 iOS 자신의 화면 가장자리 인식폭(~20pt)보다 살짝 넉넉하다. 우리 화면에서
 * 이 띠는 대부분 `SAFE_GUTTER`(16) 의 여백이라 눌러야 할 것이 거의 없고, 그
 * 바깥부터는 사람이 겨눈 것을 이 제스처가 가로채지 않는다.
 */
export const EDGE_WIDTH_PX = 24;

/**
 * 화면을 가져가기까지 필요한 가로 이동, 단위 pt.
 *
 * 코어의 길게 누르기 허용치에서 유도한다 — 위 헤더의 「ACTIVATE_PX 는 왜」 참고.
 * 이 값이 그 허용치보다 크다는 것이 두 제스처가 겹치지 않는다는 증명이고,
 * `edgeSwipe.test.ts` 가 그 부등식 자체를 못 박는다.
 */
export const ACTIVATE_PX = MOVE_TOLERANCE_PX + 2;

/**
 * 이만큼 세로로 움직인 손가락은 스크롤이다 — 영구 탈락, 단위 pt.
 *
 * `ACTIVATE_PX` 보다 크게 잡는다. 같거나 작으면 정확히 대각선으로 들어온 손가락이
 * 두 판정을 동시에 통과하고, 그때 이기는 쪽은 이벤트가 도착한 순서라는 우연이 된다.
 */
export const SCROLL_LOCK_PX = 16;

/** 가로가 세로보다 이 배는 뚜렷해야 한다. */
export const DIRECTION_RATIO = 1.4;

/** 손을 뗐을 때 이 비율을 넘겨 놨으면 넘어간다. */
export const COMPLETE_FRACTION = 0.33;

/**
 * 거리가 모자라도 이 속도로 튕겼으면 넘어간다, 단위 pt/ms.
 *
 * 거리만 보면 빠르고 짧은 스와이프(사람들이 실제로 하는 그것)가 매번 취소되고,
 * 속도만 보면 천천히 끝까지 끌고 간 손가락이 취소된다. 둘 다 본다.
 */
export const FLICK_VX = 0.3;

/** 놓은 뒤 제자리로/바깥으로 미끄러지는 시간의 하한과 상한, 단위 ms. */
export const MIN_SETTLE_MS = 90;
export const MAX_SETTLE_MS = 260;

export interface Point {
  x: number;
  y: number;
}

/**
 * 진행 중인 터치 하나.
 *
 * `origin` 이 `null` 이면 **이 터치는 끝날 때까지 뒤로가기가 될 수 없다.** 엣지
 * 밖에서 시작했거나, 세로로 먼저 움직여 탈락했거나, 손가락이 둘이거나.
 */
export interface EdgeSwipeState {
  origin: Point | null;
  /** 이미 화면을 가져갔다. 두 번 가져가지 않기 위해서만 쓴다. */
  claimed: boolean;
}

export const IDLE: EdgeSwipeState = {origin: null, claimed: false};

export type EdgeSwipeInput =
  /** 손가락이 내려앉았다. `touches` 는 그 순간 화면에 있는 손가락 수. */
  | {kind: 'down'; touches: number; point: Point}
  | {kind: 'move'; point: Point}
  /** 뗐거나, 취소됐거나, 빼앗겼다 — 어느 쪽이든 이 터치는 끝났다. */
  | {kind: 'end'};

export interface EdgeSwipeStep {
  state: EdgeSwipeState;
  /** 이 단계에서 화면을 가져가는가. 딱 한 번만 true 다. */
  claims: boolean;
}

/** 시작점 하나로 결정된다: 이 터치가 애초에 뒤로가기가 될 수 있는가. */
export function startsAtEdge(x: number): boolean {
  return x >= 0 && x <= EDGE_WIDTH_PX;
}

/**
 * 제스처의 한 단계.
 *
 * `enabled` 가 false 면 아무것도 무장하지 않는다 — 위에 다른 화면이 덮여 있을
 * 때(스레드가 열린 대화)가 그 경우이고, 그 판정은 배선 쪽이 한다.
 */
export function edgeSwipeStep(
  state: EdgeSwipeState,
  input: EdgeSwipeInput,
  options: {enabled: boolean},
): EdgeSwipeStep {
  switch (input.kind) {
    case 'down': {
      // 손가락이 둘이면 이것은 확대이거나 다른 무엇이지 뒤로가기가 아니다.
      if (!options.enabled || input.touches > 1) return {state: IDLE, claims: false};
      if (!startsAtEdge(input.point.x)) return {state: IDLE, claims: false};
      return {state: {origin: input.point, claimed: false}, claims: false};
    }
    case 'move': {
      const {origin} = state;
      // 무장하지 않은 터치이거나 이미 가져간 뒤. 어느 쪽이든 판정할 것이 없다.
      if (origin === null || state.claimed) return {state, claims: false};
      if (!options.enabled) return {state: IDLE, claims: false};
      const dy = input.point.y - origin.y;
      // 세로가 먼저다 → 스크롤. 되돌아올 길 없음.
      if (Math.abs(dy) > SCROLL_LOCK_PX) return {state: IDLE, claims: false};
      const dx = input.point.x - origin.x;
      if (dx < ACTIVATE_PX) return {state, claims: false};
      if (dx <= Math.abs(dy) * DIRECTION_RATIO) return {state, claims: false};
      return {state: {origin, claimed: true}, claims: true};
    }
    case 'end':
      return {state: IDLE, claims: false};
  }
}

/**
 * 화면이 가 있어야 할 x — 손가락이 간 만큼, 그 이상도 이하도 아니다.
 *
 * 왼쪽으로는 가지 않는다(뒤로가기를 되감아 화면을 화면 밖 왼쪽으로 끌고 갈 이유가
 * 없다). 오른쪽으로도 화면 너비를 넘지 않는다.
 */
export function followX(dx: number, width: number): number {
  if (!(dx > 0)) return 0;
  return Math.min(dx, Math.max(0, width));
}

/** 손을 뗐다: 넘어가는가, 제자리로 돌아오는가. */
export function settles(
  travel: {dx: number; vx: number},
  width: number,
): 'back' | 'cancel' {
  // 되돌리는 방향으로 튕겼으면 거리와 무관하게 취소다 — 사람이 방금 "아니"라고
  // 말한 것을 거리를 근거로 뒤집지 않는다.
  if (travel.vx <= -FLICK_VX) return 'cancel';
  if (travel.vx >= FLICK_VX && travel.dx > 0) return 'back';
  return followX(travel.dx, width) >= width * COMPLETE_FRACTION ? 'back' : 'cancel';
}

/**
 * 남은 거리를 미끄러지는 데 쓸 시간, 단위 ms.
 *
 * 거의 다 끌고 온 손가락에 260ms 를 마저 쓰면 다 된 일이 굼떠 보이고, 5% 만 끌다
 * 놓은 화면을 90ms 만에 되돌리면 튕긴다. 남은 거리에 비례시키면 둘 다 없다.
 */
export function settleMs(remainingPx: number, width: number): number {
  if (!(width > 0)) return MIN_SETTLE_MS;
  const fraction = Math.min(1, Math.max(0, remainingPx / width));
  return Math.round(MIN_SETTLE_MS + (MAX_SETTLE_MS - MIN_SETTLE_MS) * fraction);
}

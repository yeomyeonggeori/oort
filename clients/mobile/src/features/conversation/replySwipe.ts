import {MOVE_TOLERANCE_PX} from '@momo/core/features/timeline/longPressModel';

import {rubberBand} from '../../design/sheetModel';

// =============================================================================
// 메시지 행을 오른쪽→왼쪽으로 밀면 그 자리에서 스레드 답글 (#4869) — **규칙만**.
// 배선(PanResponder·Animated·햅틱)은 `ReplySwipeContainer.tsx` 다.
//
// 규칙이 컴포넌트 밖에 있는 이유는 `nav/edgeSwipe.ts` 와 같다: 타이머·응답자에 붙은 규칙은 시험으로
// 재생할 수 없고, 재생할 수 없는 방어는 죽어도 아무도 모른다. 이 제스처는 세로 스크롤·길게 누르기·
// 링크/사진 누르기와 **같은 손가락을 두고 다투므로** 판정을 값으로 둬서 「가져가지 않았다」를
// 증명할 수 있어야 한다(`__tests__/replySwipe.test.ts`).
//
// ## 이 제스처가 지키는 단 하나의 약속: **시작 때 응답자를 잡지 않는다**
//
// #4645 의 시뮬레이터 실측(RN 0.86.2 소스 + iOS 26.5): iOS(Fabric)는 스크롤 뷰의 UIKit 조상 중 하나라도
// JS 응답자이면 그 터치의 네이티브 스크롤을 **시작도 못 하게** 막고, `onResponderGrant` 의 차단 값
// (`onShouldBlockNativeResponder`)은 iOS 에서 버려진다. 즉 「조상이 먼저 쥐고 스크롤은 살리기」는 안 된다.
// 그래서 이 제스처는 `down` 에서는 **시작점만 적고 절대 잡지 않으며**(`claims: false`), 이동이 오른쪽→왼쪽으로
// 뚜렷이 우세할 때 **딱 한 번** 잡는다. 시작 단계에서 잡는 쪽으로 바꾸면 이 파일의 시험이 먼저 빨개진다.
//
// ## 값과 근거 — 전부 이 목록에서만 정한다
//
// **가져가는 문턱 {@link REPLY_ACTIVATE_PX} = 코어 길게 누르기 허용치(10) + 2 = 12pt.**
//   길게 누르기는 시작점에서 `MOVE_TOLERANCE_PX`(10)를 넘게 움직이면 무장을 푼다. 이 제스처가 가져가는
//   문턱을 **그보다 위**에 두면 「가져간 손가락은 가져가는 순간 이미 길게 누르기가 아니었다」가 공짜로
//   참이 되어 두 제스처가 겹치는 구간이 아예 없다(`nav/edgeSwipe.ts` 의 `ACTIVATE_PX` 와 같은 근거이고,
//   코어 값이 바뀌는 날 같이 움직이도록 유도한다). 탭의 손떨림(수 pt)보다도 크다: 링크·사진·칩을 누르는
//   손가락은 이 문턱을 넘지 않으므로 그 눌림이 죽지 않는다.
//
// **방향 {@link REPLY_DIRECTION_RATIO} = 가로가 세로의 2배 초과(±26.6° 안).**
//   가장자리 뒤로가기(`edgeSwipe`)는 1.4 를 쓴다. 이쪽은 **행 전체**(가장자리 띠가 아니라 목록 한복판)가
//   세로 스크롤과 다투므로 더 엄격하다: 세로 스크롤 중의 손가락은 수직에서 15° 안쪽이 대부분(dx/dy < 0.27)이라
//   멀리 있고, 45° 대각선은 잡히지 않으며, 일부러 민 가로 쓸기는 수평에서 ±20° 안쪽(dy/dx < 0.36 → 비율 2.75
//   이상)이라 통과한다. 비율은 **엄격 초과**다(정확히 2배는 잡지 않는다).
//
// **세로 잠금 {@link REPLY_SCROLL_LOCK_PX} = 16pt (가져가기 전에 세로로 이만큼 간 터치는 영구 탈락).**
//   비율 판정만으로는 부족하다: 아래로 40pt 가다가 옆으로 100pt 가는 대각선 손가락은 어느 순간 비율을
//   통과한다. 스크롤 중에 행이 답글로 끌려가는 것은 이 배치가 고치려는 문제보다 나쁘므로 탈락에는
//   되돌아올 길을 두지 않는다(손을 떼야 다시 시작). 가져가는 문턱(12)보다 크게 둔다 — 같거나 작으면
//   정확히 대각선으로 들어온 손가락이 두 판정을 동시에 통과하고 이기는 쪽이 이벤트 순서라는 우연이 된다.
//
// **답글이 열리는 문턱 {@link REPLY_COMMIT_PX} = 64pt.**
//   눌림 영역(44)보다 커서 스치듯 민 손가락(대개 30~50pt)이 답글을 열지 않고, 엄지 한 번의 쓸기로
//   닿는다. 시트를 끌어 닫는 최소 거리(`SHEET_DISMISS_MIN_DISTANCE` 64)와 같은 값이라 앱에서 「일부러 한
//   동작」의 거리가 한 가지다. 햅틱(문턱 최초 통과)·아이콘(문턱에서 완전히 보임)·놓을 때의 판정이 **같은
//   거리 하나**를 읽는다 — 셋이 어긋나면 「울렸는데 안 열렸다」가 생긴다. 속도 판정은 없다: 이슈 계약이
//   「문턱 전에 놓으면 아무 일도 없다」이고, 튕김으로 짧게 열리는 길을 만들면 그 문장이 거짓이 된다.
//
// **따라가기.** 문턱까지는 손가락과 1:1(행이 손가락 밑에 붙어 있다 — 가져가는 순간 12pt 를 한 번에 가는 것이
// 첫 프레임에 뒤처졌다 따라붙는 것보다 낫다고 이미 가장자리 뒤로가기가 정한 선택이다), 문턱 뒤로는 시트와
// 같은 고무줄(`rubberBand`, 최대 24pt)이라 문턱이 손에 걸리는 곳으로 느껴진다. 오른쪽으로 되돌아가도 행은
// 원점 오른쪽으로 가지 않는다.
// =============================================================================

/** 가져가기까지 필요한 왼쪽 이동(pt). 위 머리말의 「가져가는 문턱」. */
export const REPLY_ACTIVATE_PX = MOVE_TOLERANCE_PX + 2;

/** 가져가기 전에 이만큼(pt) 세로로 움직인 터치는 영구 탈락이다. */
export const REPLY_SCROLL_LOCK_PX = 16;

/** 가로가 세로의 이 배를 **초과**해야 가져간다. */
export const REPLY_DIRECTION_RATIO = 2;

/** 이 거리(pt) 이상 밀면 문턱을 넘은 것이다: 햅틱 한 번 · 아이콘 · 놓으면 답글. */
export const REPLY_COMMIT_PX = 64;

/** 문턱을 넘은 뒤 고무줄이 더 보태는 최대(pt) — `rubberBand` 의 점근선과 같다. */
export const REPLY_OVERSHOOT_MAX_PX = 24;

export interface Point {
  x: number;
  y: number;
}

/**
 * 진행 중인 터치 하나.
 *
 * `origin` 이 `null` 이면 **이 터치는 끝날 때까지 답글 밀기가 될 수 없다**: 시작하지 않았거나(`down` 을
 * 못 봤다), 세로로 먼저 움직여 탈락했거나, 손가락이 둘이거나, 이 행이 밀 수 없는 행이다.
 */
export interface ReplySwipeState {
  origin: Point | null;
  /** 이미 가져갔다. 두 번 가져가지 않기 위해서만 쓴다. */
  claimed: boolean;
}

export const IDLE: ReplySwipeState = {origin: null, claimed: false};

export type ReplySwipeInput =
  /** 손가락이 내려앉았다. `touches` 는 그 순간 화면에 있는 손가락 수. */
  | {kind: 'down'; touches: number; point: Point}
  /** 손가락이 움직였다. `touches` 가 둘 이상이면(확대 등) 가져가지 않는다. */
  | {kind: 'move'; touches: number; point: Point}
  /** 뗐거나, 취소됐거나, 빼앗겼다 — 어느 쪽이든 이 터치는 끝났다. */
  | {kind: 'end'};

export interface ReplySwipeStep {
  state: ReplySwipeState;
  /** 이 단계에서 응답자를 가져가는가. 한 터치에 많아야 한 번, 그리고 **`move` 에서만** true 다. */
  claims: boolean;
}

/**
 * 제스처의 한 단계.
 *
 * `enabled` 가 false 면 아무것도 무장하지 않는다 — 밀 수 없는 행(시스템 줄·삭제된 메시지·승인 카드)과
 * 이 표면에 답글 입력칸이 없을 때가 그 경우이고, 그 판정은 배선 쪽이 한다.
 */
export function replySwipeStep(
  state: ReplySwipeState,
  input: ReplySwipeInput,
  options: {enabled: boolean},
): ReplySwipeStep {
  switch (input.kind) {
    case 'down': {
      // 손가락이 둘이면 이것은 확대이거나 다른 무엇이지 답글 밀기가 아니다.
      if (!options.enabled || input.touches > 1) return {state: IDLE, claims: false};
      // **시작에서는 절대 잡지 않는다** — 위 머리말의 단 하나의 약속.
      return {state: {origin: input.point, claimed: false}, claims: false};
    }
    case 'move': {
      const {origin} = state;
      // 무장하지 않은 터치이거나 이미 가져간 뒤. 어느 쪽이든 판정할 것이 없다.
      if (origin === null || state.claimed) return {state, claims: false};
      if (!options.enabled) return {state: IDLE, claims: false};
      // 둘째 손가락이 올라왔다: 이 이동은 확대의 것이다. 탈락시키지는 않는다(손가락이 하나로 돌아오면 이어진다).
      if (input.touches > 1) return {state, claims: false};
      const dx = input.point.x - origin.x;
      const dy = input.point.y - origin.y;
      // 세로가 먼저다 → 스크롤. 되돌아올 길 없음.
      if (Math.abs(dy) > REPLY_SCROLL_LOCK_PX) return {state: IDLE, claims: false};
      // 왼쪽으로(음수)만, 그리고 문턱만큼. 오른쪽으로 가는 손가락(iOS 뒤로 가기가 그쪽이다)은 영영 잡지 않는다.
      if (!(dx <= -REPLY_ACTIVATE_PX)) return {state, claims: false};
      // 가로가 세로보다 뚜렷이(2배 초과) 앞서야 한다.
      if (!(-dx > Math.abs(dy) * REPLY_DIRECTION_RATIO)) return {state, claims: false};
      return {state: {origin, claimed: true}, claims: true};
    }
    case 'end':
      return {state: IDLE, claims: false};
  }
}

/** 시작점에서 `dx` 만큼 간 손가락이 문턱 쪽으로 민 거리(pt, 왼쪽이 양수). 오른쪽은 0 이다. */
export function pulledPx(dx: number): number {
  return dx < 0 ? -dx : 0;
}

/**
 * 손가락이 `dx` 만큼 갔을 때 행이 가 있을 거리(pt, 왼쪽이 양수).
 *
 * 문턱까지 1:1, 그 뒤는 고무줄(최대 +{@link REPLY_OVERSHOOT_MAX_PX}). 오른쪽으로는 가지 않는다.
 */
export function replySwipeOffset(dx: number): number {
  const pulled = pulledPx(dx);
  if (pulled <= REPLY_COMMIT_PX) return pulled;
  return REPLY_COMMIT_PX + rubberBand(pulled - REPLY_COMMIT_PX);
}

/**
 * 문턱을 넘었는가 — 햅틱·아이콘·놓을 때 답글이 **모두 이 물음 하나**를 읽는다. 문턱에 정확히 닿은 것도 넘은
 * 것이다(64pt 에서 울리고 64pt 에서 놓으면 열린다).
 */
export function isReplyArmed(dx: number): boolean {
  return pulledPx(dx) >= REPLY_COMMIT_PX;
}

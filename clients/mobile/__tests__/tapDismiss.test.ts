import {LONG_PRESS_MS, MOVE_TOLERANCE_PX} from '@momo/core/features/timeline/longPressModel';

import {
  IDLE_TAP,
  TAP_MAX_MS,
  TAP_SLOP_PT,
  tapStep,
  type TapInput,
  type TapState,
} from '../src/features/conversation/tapDismiss';

// =============================================================================
// 대화 목록의 「탭」 판정 (#4614) — 이동 10pt 미만 · 250ms 미만(길게 누르기가 열리기 전; 이슈의 처음 300ms 는 10-27 에 정정) · 손가락 하나.
//
// 판정은 순수 함수라 제스처 시퀀스를 그대로 재생한다. 이 파일의 단정은 전부 **재생한 결과**(어느 단계에서 `tap` 이 참이 되나)를 읽는다 — 상수를 읽어 상수와 비교하지 않는다.
// 경계는 양쪽에서 잰다(문턱 바로 안 = 탭, 문턱 = 아님). 한쪽만 재면 문턱을 아무 데로 옮겨도 통과한다.
// =============================================================================

const down = (x: number, y: number, at: number, touches = 1): TapInput => ({
  kind: 'down',
  point: {x, y},
  at,
  touches,
});
const move = (x: number, y: number): TapInput => ({kind: 'move', point: {x, y}});
const up = (at: number, touches = 0): TapInput => ({kind: 'up', at, touches});
const cancel: TapInput = {kind: 'cancel'};

/** 시퀀스를 재생해 단계마다의 `tap` 을 돌려준다. 시작 상태를 줄 수 있다(손가락이 둘인 도중의 상태 등). */
function play(inputs: TapInput[], from: TapState = IDLE_TAP) {
  let state = from;
  const taps: boolean[] = [];
  for (const input of inputs) {
    const step = tapStep(state, input);
    state = step.state;
    taps.push(step.tap);
  }
  return {taps, state};
}

/** 마지막 단계(손 뗌)에서만 탭이 선다 — 다른 단계에서 선 탭은 이 판정의 오류다. */
const tappedAtTheEnd = (inputs: TapInput[]) => {
  const {taps} = play(inputs);
  expect(taps.slice(0, -1).every(tap => !tap)).toBe(true);
  return taps[taps.length - 1] === true;
};

describe('탭이다', () => {
  it('손가락 하나를 가만히 짧게 대었다 떼면 탭이다 — 뗀 단계에서', () => {
    expect(tappedAtTheEnd([down(100, 200, 1000), up(1080)])).toBe(true);
  });

  it('문턱 바로 안의 떨림은 탭이다 — 시작점에서 TAP_SLOP_PT 미만', () => {
    // 대조(아래 「아니다」의 첫 시험)와 한 쌍이다: 같은 시퀀스에서 거리만 문턱으로 옮기면 뒤집힌다.
    expect(tappedAtTheEnd([down(100, 200, 1000), move(100 + TAP_SLOP_PT - 0.5, 200), up(1080)])).toBe(true);
  });

  it('시간 문턱 바로 안(TAP_MAX_MS - 1)에 떼면 탭이다', () => {
    expect(tappedAtTheEnd([down(0, 0, 5000), up(5000 + TAP_MAX_MS - 1)])).toBe(true);
  });

  it('탭 한 번은 한 번만 센다 — 뗀 뒤 상태가 비어서 다음 손 뗌이 탭이 되지 않는다', () => {
    const {taps, state} = play([down(0, 0, 1000), up(1050), up(1100)]);
    expect(taps).toEqual([false, true, false]);
    expect(state).toEqual(IDLE_TAP);
  });

  it('연달아 두 번 탭하면 두 번 센다', () => {
    const {taps} = play([down(0, 0, 1000), up(1050), down(0, 0, 1400), up(1450)]);
    expect(taps).toEqual([false, true, false, true]);
  });
});

describe('탭이 아니다', () => {
  it('시작점에서 TAP_SLOP_PT 이상 움직이면 탭이 아니다 — 문턱 그 자체도 아니다(「미만」)', () => {
    expect(tappedAtTheEnd([down(100, 200, 1000), move(100 + TAP_SLOP_PT, 200), up(1080)])).toBe(false);
  });

  it('끌다가 시작점으로 돌아와도 탭이 아니다 — 한 번 끌기로 밝혀지면 끝까지 끌기다', () => {
    expect(tappedAtTheEnd([down(100, 200, 1000), move(100, 260), move(100, 200), up(1080)])).toBe(false);
  });

  it('거리는 직전 위치가 아니라 시작점에서 잰다 — 1pt 씩 밀어도 쌓이면 끌기다', () => {
    // 직전 위치 기준이면 열아홉 걸음 모두 「1pt 움직였다」라서 탭으로 남는다(`longPressModel.ts` 규칙 2 가 막는 길).
    const steps = Array.from({length: 19}, (_, index) => move(100 + (index + 1), 200));
    expect(tappedAtTheEnd([down(100, 200, 1000), ...steps, up(1080)])).toBe(false);
  });

  it('대각선도 시작점 거리로 잰다 — 가로 7 · 세로 7 은 약 9.9 로 탭, 가로 8 · 세로 8 은 약 11.3 으로 끌기', () => {
    expect(tappedAtTheEnd([down(0, 0, 1000), move(7, 7), up(1080)])).toBe(true);
    expect(tappedAtTheEnd([down(0, 0, 1000), move(8, 8), up(1080)])).toBe(false);
  });

  it('시간 문턱(TAP_MAX_MS)에 닿은 손은 탭이 아니다 — 「미만」', () => {
    expect(tappedAtTheEnd([down(0, 0, 5000), up(5000 + TAP_MAX_MS)])).toBe(false);
  });

  it('길게 누른 손도 탭이 아니다', () => {
    expect(tappedAtTheEnd([down(0, 0, 1000), up(1000 + 2 * TAP_MAX_MS)])).toBe(false);
  });

  it('길게 누르기가 시트를 여는 시간(LONG_PRESS_MS, 250ms)에 뗀 손은 탭이 아니다 — 시트를 연 손가락이 입력창까지 접지 않는다 (이슈의 처음 300ms 를 250ms 로 정정한 이유)', () => {
    // 상수가 아니라 **길게 누르기 쪽 상수**로 잰다: 탭 상한을 300 처럼 더 크게 못 박으면 250~299ms 에 뗀 손이 시트도 열고 탭도 된다.
    expect(tappedAtTheEnd([down(0, 0, 5000), up(5000 + LONG_PRESS_MS - 1)])).toBe(true);
    expect(tappedAtTheEnd([down(0, 0, 5000), up(5000 + LONG_PRESS_MS)])).toBe(false);
    expect(tappedAtTheEnd([down(0, 0, 5000), up(5000 + LONG_PRESS_MS + 40)])).toBe(false);
  });

  it('손가락이 둘이면 탭이 아니다 — 둘째가 닿으면 이 제스처는 깨진다', () => {
    expect(tappedAtTheEnd([down(0, 0, 1000), down(50, 0, 1010, 2), up(1060, 1), up(1070, 0)])).toBe(false);
  });

  // 아래 두 시험은 위 두 시험이 서로를 가리지 않게 **각 규칙을 단독 방어선**으로 세운다(둘째 손가락 규칙과 「손가락이 남은 채의 손 뗌」 규칙은 보통 같이 일하므로, 위 시퀀스는 둘 중
  // 하나만 지워도 통과한다 — 사보타주가 잡아낸 것이다).
  it('두 손가락이 한 프레임에 같이 떨어져도(손 뗌 이벤트 하나, 남은 손가락 0) 탭이 아니다 — 둘째 손가락이 닿은 것만으로 깨진다', () => {
    expect(tappedAtTheEnd([down(0, 0, 1000), down(50, 0, 1010, 2), up(1060, 0)])).toBe(false);
  });

  it('손가락이 남은 채 떼어지면 그 손 뗌은 탭이 아니다 — 남은 손가락이 닿는 것을 못 봤어도', () => {
    const {taps} = play([down(0, 0, 1000), up(1050, 1), up(1090, 0)]);
    expect(taps).toEqual([false, false, false]);
  });

  it('먼저 닿은 손가락을 먼저 떼도 탭이 아니다 — 남은 손가락이 마지막으로 떼어질 때까지 기다린다', () => {
    const {taps} = play([down(0, 0, 1000), down(50, 0, 1010, 2), up(1040, 1), up(1060, 0)]);
    expect(taps).toEqual([false, false, false, false]);
  });

  it('손가락이 둘이던 제스처가 끝난 뒤의 새 손가락은 다시 탭이 될 수 있다 — 깨짐이 다음 제스처로 새지 않는다', () => {
    const {taps} = play([
      down(0, 0, 1000),
      down(50, 0, 1010, 2),
      up(1040, 1),
      up(1060, 0),
      down(0, 0, 2000),
      up(2050),
    ]);
    expect(taps[taps.length - 1]).toBe(true);
  });

  it('시스템이 터치를 가져가면(취소) 탭이 아니고, 그 뒤 손 뗌도 탭이 아니다', () => {
    const {taps, state} = play([down(0, 0, 1000), cancel, up(1050)]);
    expect(taps).toEqual([false, false, false]);
    expect(state).toEqual(IDLE_TAP);
  });

  it('닿는 것을 못 본 손 뗌은 탭이 아니다', () => {
    expect(play([up(1000)]).taps).toEqual([false]);
  });

  it('손 뗌을 놓친 채 새 손가락이 닿으면 새로 시작한다 — 낡은 시작 시각이 새 탭을 느린 손으로 만들지 않는다', () => {
    // 첫 손가락의 끝을 놓쳤다(낡은 시작 1000). 한참 뒤(9000)의 새 손가락이 짧게 떼어지면 탭이다.
    expect(tappedAtTheEnd([down(0, 0, 1000), down(0, 0, 9000), up(9050)])).toBe(true);
  });
});

describe('상수', () => {
  it('시간 상한은 계약(250ms)이고 길게 누르기가 열리는 시간과 같다 — 시트가 열리는 손가락은 탭이 아니다', () => {
    expect(TAP_MAX_MS).toBe(250);
    expect(TAP_MAX_MS).toBe(LONG_PRESS_MS);
  });

  it('거리 문턱은 계약(10pt)이고 길게 누르기가 취소되는 움직임 문턱과 같은 값이다 — 한 손가락의 세 제스처가 한 경계를 나눠 쓴다', () => {
    expect(TAP_SLOP_PT).toBe(10);
    expect(TAP_SLOP_PT).toBe(MOVE_TOLERANCE_PX);
  });
});

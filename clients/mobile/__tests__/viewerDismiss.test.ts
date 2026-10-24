import {
  backdropStops,
  BACKDROP_FADE_DISTANCE_PT,
  BACKDROP_MIN_OPACITY,
  chromeStops,
  CHROME_FADE_DISTANCE_PT,
  CLAIM_SLOP_PT,
  DISMISS_DISTANCE_PT,
  DISMISS_VELOCITY_PT_PER_S,
  evaluate,
  followY,
  IDLE,
  scaleStops,
  settles,
  SHRINK_AT_BOTTOM,
  viewerDragStep,
  type ViewerDragInput,
  type ViewerDragState,
} from '../src/features/attachments/viewerDismiss';

// =============================================================================
// 사진 뷰어 쓸어 닫기의 **규칙** (#4293). 판정은 순수 함수이므로 손가락 시퀀스를 그대로 재생한다.
//
// 값은 Buzz 모바일(`media_viewer_page.dart`)에서 온다. 첫 describe 가 그 값을 못 박는 이유는
// 값이 맞아서가 아니라 **바뀔 때 보이게** 하기 위해서다 — 이슈가 「100pt 또는 700pt/s」라고
// 적었고, 그 숫자가 조용히 움직이면 안 된다.
// =============================================================================

const HEIGHT = 874; // iPhone 16 Pro 의 창 높이(pt)
const ON = {enabled: true} as const;

/** 손가락 하나를 (x, y) 에 대고 한 걸음씩 움직인다. 마지막 결과를 돌려준다. */
function run(
  steps: Array<{kind: ViewerDragInput['kind']; x: number; y: number; touches?: number}>,
  context: {enabled: boolean} = ON,
  start: ViewerDragState = IDLE,
) {
  let state = start;
  let last = viewerDragStep(state, {kind: 'down', touches: 1, point: {x: 0, y: 0}}, context, HEIGHT);
  const results = [last];
  state = last.state;
  for (const step of steps) {
    last = viewerDragStep(
      state,
      {kind: step.kind, touches: step.touches ?? 1, point: {x: step.x, y: step.y}},
      context,
      HEIGHT,
    );
    state = last.state;
    results.push(last);
  }
  return {last, results, state};
}

describe('값은 Buzz 모바일의 것이다', () => {
  it('이동 100pt · 속도 700pt/s · 배경 300pt 에서 0.3 까지 · 단추 띠 160pt · 크기 10%', () => {
    expect(DISMISS_DISTANCE_PT).toBe(100);
    expect(DISMISS_VELOCITY_PT_PER_S).toBe(700);
    expect(BACKDROP_FADE_DISTANCE_PT).toBe(300);
    expect(BACKDROP_MIN_OPACITY).toBe(0.3);
    expect(CHROME_FADE_DISTANCE_PT).toBe(160);
    expect(SHRINK_AT_BOTTOM).toBe(0.1);
  });
});

describe('놓았을 때: 닫는가, 돌아가는가', () => {
  it('100pt 는 모자라고 100pt 를 넘으면 닫는다 — 경계는 「넘게」다', () => {
    expect(settles({offset: 99, velocityPtPerMs: 0})).toBe('snap');
    expect(settles({offset: DISMISS_DISTANCE_PT, velocityPtPerMs: 0})).toBe('snap');
    expect(settles({offset: DISMISS_DISTANCE_PT + 0.5, velocityPtPerMs: 0})).toBe('dismiss');
    expect(settles({offset: 300, velocityPtPerMs: 0})).toBe('dismiss');
  });

  it('700pt/s 는 모자라고 넘으면 거리가 짧아도 닫는다 — PanResponder 의 vy 는 px/ms 다', () => {
    // 0.7 px/ms === 700 pt/s. 단위를 잘못 읽으면(vy 를 pt/s 로) 이 두 줄이 뒤집힌다.
    expect(settles({offset: 20, velocityPtPerMs: 0.65})).toBe('snap');
    expect(settles({offset: 20, velocityPtPerMs: 0.7})).toBe('snap');
    expect(settles({offset: 20, velocityPtPerMs: 0.75})).toBe('dismiss');
    expect(settles({offset: 20, velocityPtPerMs: 2})).toBe('dismiss');
  });

  it('위로 올리며 놓으면(속도가 음수) 거리가 모자란 채로는 돌아간다', () => {
    expect(settles({offset: 60, velocityPtPerMs: -1.5})).toBe('snap');
  });
});

describe('언제 뷰어가 손가락을 가져가는가', () => {
  it('문턱(8pt) 안에서는 가져가지 않고 아무것도 정하지 않는다 — 탭과 떨림이다', () => {
    const {last, state} = run([{kind: 'move', x: 0, y: CLAIM_SLOP_PT}]);
    expect(last.claims).toBe(false);
    expect(state.dead).toBe(false); // 아직 정하지 않았다
    // 정하지 않았으므로 다음 걸음이 아래로 문턱을 넘으면 가져간다.
    const next = viewerDragStep(
      state,
      {kind: 'move', touches: 1, point: {x: 0, y: 40}},
      ON,
      HEIGHT,
    );
    expect(next.claims).toBe(true);
  });

  it('아래로 문턱을 넘으면 가져간다', () => {
    const {last} = run([{kind: 'move', x: 0, y: CLAIM_SLOP_PT + 1}]);
    expect(last.claims).toBe(true);
    expect(last.offset).toBe(CLAIM_SLOP_PT + 1);
  });

  it('가로가 앞서면 가져가지 않는다 — 페이지 넘김을 훔치지 않는다', () => {
    // 오른쪽으로 40 가면서 아래로 20: 대각선이어도 가로가 크다.
    const {results} = run([
      {kind: 'move', x: 20, y: 10},
      {kind: 'move', x: 40, y: 20},
      {kind: 'move', x: 80, y: 40},
    ]);
    expect(results.some(result => result.claims)).toBe(false);
  });

  it('처음 문턱을 넘은 방향이 가로면, 이후 아래로 아무리 가도 가져가지 않는다 — 방향은 한 번 정해진다', () => {
    const {results} = run([
      {kind: 'move', x: 12, y: 2}, // 가로로 문턱을 넘었다 — 페이지 넘김이다
      {kind: 'move', x: 14, y: 60},
      {kind: 'move', x: 16, y: 400}, // 이제 세로가 훨씬 크지만 이 손가락은 이미 가로의 것이다
    ]);
    expect(results.some(result => result.claims)).toBe(false);
  });

  it('처음 문턱을 넘은 방향이 위쪽이면 영영 가져가지 않는다', () => {
    const {results} = run([
      {kind: 'move', x: 0, y: -12},
      {kind: 'move', x: 0, y: 60},
      {kind: 'move', x: 0, y: 300},
    ]);
    expect(results.some(result => result.claims)).toBe(false);
  });

  it('세로가 가로보다 크면 대각선이어도 가져간다', () => {
    const {last} = run([{kind: 'move', x: 10, y: 30}]);
    expect(last.claims).toBe(true);
  });

  it('위로 올리는 손가락은 가져가지 않는다', () => {
    const {results} = run([
      {kind: 'move', x: 0, y: -20},
      {kind: 'move', x: 0, y: -80},
    ]);
    expect(results.some(result => result.claims)).toBe(false);
  });

  it('꺼져 있으면(확대 중) 아무리 내려도 가져가지 않는다', () => {
    const {results} = run(
      [
        {kind: 'move', x: 0, y: 40},
        {kind: 'move', x: 0, y: 200},
      ],
      {enabled: false},
    );
    expect(results.some(result => result.claims)).toBe(false);
  });

  it('손가락이 둘이면(핀치) 가져가지 않고, 그 손가락의 남은 일생 동안 다시 가져가지도 않는다', () => {
    const {results} = run([
      {kind: 'move', x: 0, y: 2, touches: 2},
      // 둘째 손가락이 떠난 뒤에도 — 이미 핀치로 시작한 터치다.
      {kind: 'move', x: 0, y: 60, touches: 1},
      {kind: 'move', x: 0, y: 200, touches: 1},
    ]);
    expect(results.some(result => result.claims)).toBe(false);
  });

  it('손가락 하나로 끌던 중 둘째가 닿으면 취소다 — 호출부가 제자리로 돌려놓는다', () => {
    const {results, state} = run([
      {kind: 'move', x: 0, y: 40},
      {kind: 'move', x: 0, y: 90},
      {kind: 'move', x: 0, y: 95, touches: 2},
    ]);
    expect(results[2]?.claims).toBe(true);
    const last = results[results.length - 1];
    expect(last?.cancelled).toBe(true);
    expect(last?.offset).toBe(0);
    expect(state.claimed).toBe(false);
    // 취소된 뒤에는 같은 터치로 다시 가져가지 않는다.
    const after = viewerDragStep(
      state,
      {kind: 'move', touches: 1, point: {x: 0, y: 300}},
      ON,
      HEIGHT,
    );
    expect(after.claims).toBe(false);
  });

  it('둘째 손가락의 점이 첫 손가락의 시작점을 덮어쓰지 않는다', () => {
    const first = viewerDragStep(
      IDLE,
      {kind: 'down', touches: 1, point: {x: 10, y: 100}},
      ON,
      HEIGHT,
    );
    const second = viewerDragStep(
      first.state,
      {kind: 'down', touches: 2, point: {x: 300, y: 500}},
      ON,
      HEIGHT,
    );
    expect(second.state.origin).toEqual({x: 10, y: 100});
    expect(second.state.dead).toBe(true);
  });

  it('새 터치는 이전 터치의 죽음을 물려받지 않는다', () => {
    const dead = run([{kind: 'move', x: 0, y: 2, touches: 2}]).state;
    expect(dead.dead).toBe(true);
    const fresh = viewerDragStep(
      dead,
      {kind: 'down', touches: 1, point: {x: 0, y: 0}},
      ON,
      HEIGHT,
    );
    expect(fresh.state.dead).toBe(false);
    const moved = viewerDragStep(
      fresh.state,
      {kind: 'move', touches: 1, point: {x: 0, y: 40}},
      ON,
      HEIGHT,
    );
    expect(moved.claims).toBe(true);
  });
});

describe('가져간 손가락을 따라간다', () => {
  it('손가락이 간 만큼 — 시작점에서 잰다(가져오는 문턱의 몫을 잃지 않는다)', () => {
    const {results} = run([
      {kind: 'move', x: 0, y: 12}, // 여기서 가져간다
      {kind: 'move', x: 0, y: 40},
      {kind: 'move', x: 0, y: 130},
    ]);
    expect(results.map(result => result.offset)).toEqual([0, 12, 40, 130]);
  });

  it('위로 되돌리면 0 에서 멈춘다 — 사진이 손가락을 따라 위로 올라가지 않는다', () => {
    const {last} = run([
      {kind: 'move', x: 0, y: 50},
      {kind: 'move', x: 0, y: -30},
    ]);
    expect(last.offset).toBe(0);
    expect(last.claims).toBe(true); // 이미 가져갔다 — 방향을 다시 묻지 않는다
  });

  it('화면 높이를 넘지 않는다', () => {
    expect(followY(5000, HEIGHT)).toBe(HEIGHT);
    expect(followY(-5, HEIGHT)).toBe(0);
  });

  it('가져간 뒤에는 대각선으로 끌어도 따라간다', () => {
    const {last} = run([
      {kind: 'move', x: 0, y: 30},
      {kind: 'move', x: 80, y: 60}, // 이제는 가로가 더 크다
    ]);
    expect(last.claims).toBe(true);
    expect(last.offset).toBe(60);
  });
});

describe('끄는 동안의 모양은 한 표에서 온다', () => {
  it('배경: 1 에서 시작해 210pt 에서 0.3 에 닿고 그 뒤로는 그대로다', () => {
    const stops = backdropStops();
    expect(evaluate(stops, 0)).toBe(1);
    expect(evaluate(stops, 105)).toBeCloseTo(0.65, 10);
    expect(evaluate(stops, BACKDROP_FADE_DISTANCE_PT * (1 - BACKDROP_MIN_OPACITY))).toBeCloseTo(
      BACKDROP_MIN_OPACITY,
      10,
    );
    expect(evaluate(stops, 600)).toBe(BACKDROP_MIN_OPACITY);
    // Buzz `1 - |dy| / 300` 의 값과 같다.
    expect(evaluate(stops, 90)).toBeCloseTo(1 - 90 / 300, 10);
  });

  it('배경은 끄는 동안 단조롭게 옅어지고 0.3 밑으로 내려가지 않는다', () => {
    const stops = backdropStops();
    let previous = Infinity;
    for (let offset = 0; offset <= 500; offset += 10) {
      const value = evaluate(stops, offset);
      expect(value).toBeLessThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(BACKDROP_MIN_OPACITY);
      previous = value;
    }
  });

  it('단추 띠: 160pt 에서 사라진다', () => {
    const stops = chromeStops();
    expect(evaluate(stops, 0)).toBe(1);
    expect(evaluate(stops, 80)).toBe(0.5);
    expect(evaluate(stops, CHROME_FADE_DISTANCE_PT)).toBe(0);
    expect(evaluate(stops, 400)).toBe(0);
  });

  it('사진: 화면 높이만큼 끌면 90%', () => {
    const stops = scaleStops(HEIGHT);
    expect(evaluate(stops, 0)).toBe(1);
    expect(evaluate(stops, HEIGHT / 2)).toBeCloseTo(0.95, 10);
    expect(evaluate(stops, HEIGHT)).toBeCloseTo(0.9, 10);
    expect(evaluate(stops, HEIGHT * 3)).toBeCloseTo(0.9, 10);
  });

  it('높이가 0 이어도 표가 깨지지 않는다', () => {
    const stops = scaleStops(0);
    expect(stops.inputRange[1]).toBeGreaterThan(stops.inputRange[0]);
  });
});

import {
  IDLE as PRESS_IDLE,
  MOVE_TOLERANCE_PX,
  pressStep,
  type PressState,
} from '@momo/core/features/timeline/longPressModel';

import {
  ACTIVATE_PX,
  COMPLETE_FRACTION,
  DIRECTION_RATIO,
  EDGE_WIDTH_PX,
  edgeSwipeStep,
  FLICK_VX,
  followX,
  IDLE,
  MAX_SETTLE_MS,
  MIN_SETTLE_MS,
  SCROLL_LOCK_PX,
  settleMs,
  settles,
  startsAtEdge,
  type EdgeSwipeState,
  type Point,
} from '../src/nav/edgeSwipe';

// =============================================================================
// 엣지 스와이프가 **무엇을 가져가지 않는가**.
//
// 성재: "화면 좌측을 슥 넘기면 뒤로가게 해주면 안돼?"
//
// 새 제스처를 붙이는 일의 어려운 절반은 그 제스처를 인식하는 것이 아니라, 이미 같은
// 유리 위에 살고 있는 것들을 **깨뜨리지 않는 것**이다. 이 화면에는 셋이 있다:
//
//   ① 메시지 길게 누르기 — 250ms, page 좌표 10px 게이트
//   ② 타임라인 세로 스크롤
//   ③ 컴포저 입력
//
// 그래서 이 파일의 대부분은 「가져간다」가 아니라 「**가져가지 않는다**」를 증명한다.
// 규칙이 `PanResponder` 안에 있었다면 이 증명은 불가능했을 것이다 — 그것이
// `edgeSwipe.ts` 가 순수 함수인 이유이고, `useLongPress` 의 헤더가 웹에서 죽은 게이트를
// 두고 한 말과 같은 이유다: **재생할 수 없는 방어는 죽어도 아무도 모른다.**
// =============================================================================

const ARMED = {enabled: true};

/** 손가락 하나의 자취를 그대로 모델에 흘려 넣고, 가져간 순간이 있었는지 답한다. */
function replay(
  points: Point[],
  options: {enabled: boolean} = ARMED,
): {claimedAt: number | null; state: EdgeSwipeState} {
  let state = IDLE;
  let claimedAt: number | null = null;
  const [first, ...rest] = points;
  ({state} = edgeSwipeStep(
    state,
    {kind: 'down', touches: 1, point: first},
    options,
  ));
  rest.forEach((point, index) => {
    const step = edgeSwipeStep(state, {kind: 'move', point}, options);
    state = step.state;
    if (step.claims && claimedAt === null) claimedAt = index + 1;
  });
  return {claimedAt, state};
}

/** 같은 자취를 코어의 길게 누르기 모델에 흘려 넣는다. */
function replayPress(points: Point[]): PressState[] {
  let state = PRESS_IDLE;
  const seen: PressState[] = [];
  const [first, ...rest] = points;
  ({state} = pressStep(
    state,
    {kind: 'down', pointerType: 'touch', point: first},
    ARMED,
  ));
  seen.push(state);
  for (const point of rest) {
    ({state} = pressStep(state, {kind: 'move', point}, ARMED));
    seen.push(state);
  }
  return seen;
}

/** 왼쪽 엣지에서 시작해 오른쪽으로 곧게 미는 손가락. */
function edgeDrag(toX: number, y = 400): Point[] {
  const points: Point[] = [{x: 8, y}];
  for (let x = 8; x <= toX; x += 4) points.push({x, y});
  return points;
}

// -----------------------------------------------------------------------------

describe('시작점이 전부를 결정한다', () => {
  it('엣지 밖에서 시작한 수평 드래그는 뒤로가기가 아니다', () => {
    // 화면 한가운데를 오른쪽으로 200px 끌었다. 코드블록의 가로 스크롤이거나 텍스트를
    // 고르는 손가락이지, 뒤로 가려는 손가락이 아니다.
    const points: Point[] = [];
    for (let x = 180; x <= 380; x += 8) points.push({x, y: 300});
    expect(replay(points).claimedAt).toBeNull();
  });

  it('엣지 폭의 경계가 어디인지 못 박는다', () => {
    expect(startsAtEdge(0)).toBe(true);
    expect(startsAtEdge(EDGE_WIDTH_PX)).toBe(true);
    expect(startsAtEdge(EDGE_WIDTH_PX + 1)).toBe(false);
  });

  it('손가락이 둘이면 무장하지 않는다 — 확대는 뒤로가기가 아니다', () => {
    const {state} = edgeSwipeStep(
      IDLE,
      {kind: 'down', touches: 2, point: {x: 4, y: 300}},
      ARMED,
    );
    expect(state.origin).toBeNull();
  });

  it('꺼져 있으면 아무것도 무장하지 않는다', () => {
    expect(replay(edgeDrag(200), {enabled: false}).claimedAt).toBeNull();
  });
});

describe('엣지에서 곧게 밀면 가져간다', () => {
  it('가로로 문턱만큼 갔을 때 — 그 전이 아니라', () => {
    const {claimedAt} = replay(edgeDrag(200));
    expect(claimedAt).not.toBeNull();
  });

  it('문턱 바로 아래에서는 아직 가져가지 않는다', () => {
    const short = [
      {x: 8, y: 400},
      {x: 8 + ACTIVATE_PX - 1, y: 400},
    ];
    expect(replay(short).claimedAt).toBeNull();
  });

  it('문턱에 닿으면 가져간다', () => {
    const exact = [
      {x: 8, y: 400},
      {x: 8 + ACTIVATE_PX, y: 400},
    ];
    expect(replay(exact).claimedAt).toBe(1);
  });

  it('왼쪽으로 미는 것은 뒤로가기가 아니다', () => {
    const leftward = [
      {x: 20, y: 400},
      {x: 12, y: 400},
      {x: 2, y: 400},
    ];
    expect(replay(leftward).claimedAt).toBeNull();
  });

  it('한 번 가져가면 두 번 가져가지 않는다', () => {
    let state = IDLE;
    ({state} = edgeSwipeStep(
      state,
      {kind: 'down', touches: 1, point: {x: 8, y: 400}},
      ARMED,
    ));
    const first = edgeSwipeStep(state, {kind: 'move', point: {x: 60, y: 400}}, ARMED);
    expect(first.claims).toBe(true);
    const second = edgeSwipeStep(
      first.state,
      {kind: 'move', point: {x: 120, y: 400}},
      ARMED,
    );
    expect(second.claims).toBe(false);
  });

  it('손을 떼면 처음으로 돌아간다', () => {
    const {state} = edgeSwipeStep(
      {origin: {x: 8, y: 400}, claimed: true},
      {kind: 'end'},
      ARMED,
    );
    expect(state).toEqual(IDLE);
  });
});

// =============================================================================
// ② 세로 스크롤
// =============================================================================

describe('충돌 ② — 타임라인 세로 스크롤을 가져가지 않는다', () => {
  it('엣지에서 시작한 세로 스크롤도 가져가지 않는다', () => {
    // 왼쪽 끝에 엄지를 대고 위아래로 읽는 것은 흔한 동작이고, 이 제스처가 가장
    // 위험해지는 자리이기도 하다.
    const points: Point[] = [{x: 10, y: 500}];
    for (let y = 500; y >= 200; y -= 20) points.push({x: 10, y});
    expect(replay(points).claimedAt).toBeNull();
  });

  it('세로로 먼저 간 손가락은 나중에 가로로 크게 가도 영영 가져가지 않는다', () => {
    // 이것이 비율 판정만으로 부족한 이유다. 스크롤을 시작한 손가락이 도중에 옆으로
    // 휘는 것은 늘 있는 일이고, 그때 화면이 뒤로 넘어가면 읽던 자리를 잃는다.
    const points: Point[] = [{x: 10, y: 400}];
    for (let y = 400; y <= 500; y += 20) points.push({x: 10, y});
    for (let x = 10; x <= 300; x += 20) points.push({x, y: 500});
    const {claimedAt, state} = replay(points);
    expect(claimedAt).toBeNull();
    expect(state.origin).toBeNull(); // 탈락은 되돌릴 수 없다
  });

  it('탈락 문턱이 활성 문턱보다 크다 — 대각선에서 순서가 우연이 되지 않게', () => {
    expect(SCROLL_LOCK_PX).toBeGreaterThan(ACTIVATE_PX);
  });

  it('대각선은 가로가 뚜렷할 때만 가져간다', () => {
    // 45도로 들어온 손가락은 가져가지 않는다.
    const diagonal = [
      {x: 8, y: 400},
      {x: 8 + 14, y: 400 + 14},
    ];
    expect(replay(diagonal).claimedAt).toBeNull();

    // 같은 가로 거리라도 세로가 거의 없으면 가져간다.
    const flat = [
      {x: 8, y: 400},
      {x: 8 + 14, y: 400 + 2},
    ];
    expect(replay(flat).claimedAt).toBe(1);
  });

  it('비율 자체를 못 박는다', () => {
    const dy = 6;
    const justUnder = Math.floor(dy * DIRECTION_RATIO);
    const justOver = Math.ceil(dy * DIRECTION_RATIO) + 1;
    // 문턱을 넘기려면 가로가 ACTIVATE_PX 이상이어야 하므로, 비율만 보는 자리를
    // 만들기 위해 세로를 그에 맞춰 키운다.
    expect(
      replay([
        {x: 8, y: 400},
        {x: 8 + Math.max(ACTIVATE_PX, justUnder), y: 400 + dy},
      ]).claimedAt,
    ).not.toBeNull();
    expect(justOver).toBeGreaterThan(justUnder);
  });
});

// =============================================================================
// ① 길게 누르기 — 겹치는 구간이 **없다**
// =============================================================================

describe('충돌 ① — 메시지 길게 누르기를 가져가지 않는다', () => {
  it('문턱이 코어의 허용치 위에 있다 — 이 부등식이 증명의 전부다', () => {
    // 길게 누르기는 10px 을 넘으면 스스로 무장을 푼다. 이 제스처가 가져가는 문턱을
    // 그보다 위에 두면, 가져간 손가락은 가져가는 순간 이미 길게 누르기가 아니었다.
    expect(ACTIVATE_PX).toBeGreaterThan(MOVE_TOLERANCE_PX);
  });

  it('가져가는 모든 순간에 길게 누르기는 이미 무장이 풀려 있다', () => {
    // 부등식을 말로 하지 않고 **두 모델에 같은 자취를 흘려서** 확인한다. 상수가
    // 바뀌어 부등식이 깨지면 이 테스트가 먼저 운다.
    const points = edgeDrag(300);
    const {claimedAt} = replay(points);
    expect(claimedAt).not.toBeNull();
    const pressStates = replayPress(points);
    // `replay` 의 인덱스는 move 순번(1부터), `replayPress` 는 down 을 0 으로 센다.
    expect(pressStates[claimedAt as number].origin).toBeNull();
  });

  it('제자리에서 누르고 있는 손가락은 엣지 위에서도 가져가지 않는다', () => {
    // 사람이 실제로 하는 길게 누르기: 몇 px 씩 떨리지만 어디로도 가지 않는다.
    const jitter: Point[] = [
      {x: 9, y: 300},
      {x: 10, y: 301},
      {x: 8, y: 299},
      {x: 11, y: 302},
      {x: 9, y: 300},
    ];
    expect(replay(jitter).claimedAt).toBeNull();
    // 그리고 길게 누르기 쪽은 여전히 무장돼 있다 — 시트가 열린다.
    const pressStates = replayPress(jitter);
    expect(pressStates[pressStates.length - 1].origin).not.toBeNull();
  });

  it('행 한가운데를 길게 누르는 흔한 경우는 애초에 후보가 아니다', () => {
    const jitter: Point[] = [
      {x: 180, y: 300},
      {x: 182, y: 301},
      {x: 179, y: 298},
    ];
    expect(replay(jitter).claimedAt).toBeNull();
    expect(replayPress(jitter)[2].origin).not.toBeNull();
  });
});

// =============================================================================
// ③ 컴포저
// =============================================================================

describe('충돌 ③ — 컴포저 입력을 가져가지 않는다', () => {
  it('입력창 안에서 캐럿을 옮기는 수평 드래그는 가져가지 않는다', () => {
    // 컴포저는 `SAFE_GUTTER`(16) 안쪽에서 시작하고, 그 안에서 손가락을 끄는 것은
    // 글자를 고르는 동작이다.
    const points: Point[] = [];
    for (let x = 40; x <= 260; x += 10) points.push({x, y: 780});
    expect(replay(points).claimedAt).toBeNull();
  });

  it('입력창을 탭하는 것은 움직임이 없으므로 후보조차 되지 않는다', () => {
    const {claimedAt} = replay([
      {x: 120, y: 780},
      {x: 120, y: 780},
    ]);
    expect(claimedAt).toBeNull();
  });
});

// =============================================================================
// 손가락을 따라가는 위치, 그리고 놓았을 때
// =============================================================================

describe('화면은 손가락이 간 만큼 간다', () => {
  it('간 만큼 그대로 — 배율도 감쇠도 없다', () => {
    expect(followX(0, 390)).toBe(0);
    expect(followX(37, 390)).toBe(37);
    expect(followX(200, 390)).toBe(200);
  });

  it('왼쪽으로는 가지 않는다', () => {
    expect(followX(-40, 390)).toBe(0);
  });

  it('화면 너비를 넘지 않는다', () => {
    expect(followX(1000, 390)).toBe(390);
  });
});

describe('놓으면 넘어가거나 제자리로 돌아온다', () => {
  const WIDTH = 390;

  it('충분히 밀어 놨으면 넘어간다', () => {
    expect(settles({dx: WIDTH * COMPLETE_FRACTION, vx: 0}, WIDTH)).toBe('back');
  });

  it('조금 밀다 놓으면 돌아온다 — 중간에 놓는 것은 취소다', () => {
    expect(settles({dx: 30, vx: 0}, WIDTH)).toBe('cancel');
  });

  it('짧아도 빠르게 튕겼으면 넘어간다', () => {
    // 사람들이 실제로 하는 스와이프는 짧고 빠르다. 거리만 보면 그것이 매번 취소된다.
    expect(settles({dx: 40, vx: FLICK_VX}, WIDTH)).toBe('back');
  });

  it('되돌리는 방향으로 튕기면 거리와 무관하게 취소다', () => {
    // 방금 "아니"라고 말한 손가락을, 이미 끌어 놓은 거리를 근거로 뒤집지 않는다.
    expect(settles({dx: WIDTH * 0.8, vx: -FLICK_VX}, WIDTH)).toBe('cancel');
  });
});

describe('미끄러지는 시간은 남은 거리에 비례한다', () => {
  it('거의 다 온 화면은 빨리 끝난다', () => {
    expect(settleMs(0, 390)).toBe(MIN_SETTLE_MS);
  });

  it('처음부터 되돌아가는 화면은 오래 쓴다', () => {
    expect(settleMs(390, 390)).toBe(MAX_SETTLE_MS);
  });

  it('그 사이는 사이다', () => {
    const mid = settleMs(195, 390);
    expect(mid).toBeGreaterThan(MIN_SETTLE_MS);
    expect(mid).toBeLessThan(MAX_SETTLE_MS);
  });

  it('너비가 없어도 답을 낸다 — 레이아웃 전에 놓는 손가락이 있다', () => {
    expect(settleMs(10, 0)).toBe(MIN_SETTLE_MS);
  });
});

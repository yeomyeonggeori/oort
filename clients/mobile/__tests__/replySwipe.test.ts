import {MOVE_TOLERANCE_PX} from '@momo/core/features/timeline/longPressModel';

import {TOUCH_TARGET} from '../src/design/tokens';
import {
  IDLE,
  REPLY_ACTIVATE_PX,
  REPLY_COMMIT_PX,
  REPLY_DIRECTION_RATIO,
  REPLY_OVERSHOOT_MAX_PX,
  REPLY_SCROLL_LOCK_PX,
  isReplyArmed,
  replySwipeOffset,
  replySwipeStep,
  type ReplySwipeState,
} from '../src/features/conversation/replySwipe';

// =============================================================================
// 밀어서 답글(#4869)의 **판정** — 시작 때는 절대 잡지 않고, 오른쪽→왼쪽이 뚜렷이 우세할 때만 한 번 잡는다.
//
// 이 파일이 지키는 것은 「잡았다」가 아니라 **「잡지 않았다」**다: 세로 스크롤·짧은 이동(링크·사진·칩 누르기, 길게 누르기)·
// 왼→오(iOS 뒤로 가기)·두 손가락은 어떤 순서로 와도 응답자를 가져가지 않는다. 각 단정은 일부러 깨 보았다(PR 본문의 사보타주 표).
// =============================================================================

const START = {x: 300, y: 400};
const at = (dx: number, dy = 0) => ({x: START.x + dx, y: START.y + dy});

/** 한 터치를 재생한다: `down` 한 번 + `move` 여러 번. 각 `move` 가 잡았는지를 돌려준다. */
function play(
  moves: ReadonlyArray<{x: number; y: number; touches?: number}>,
  options: {enabled?: boolean; touches?: number} = {},
) {
  const enabled = options.enabled ?? true;
  let state: ReplySwipeState = IDLE;
  const down = replySwipeStep(
    state,
    {kind: 'down', touches: options.touches ?? 1, point: START},
    {enabled},
  );
  state = down.state;
  const claims: boolean[] = [];
  for (const move of moves) {
    const step = replySwipeStep(
      state,
      {kind: 'move', touches: move.touches ?? 1, point: move},
      {enabled},
    );
    state = step.state;
    claims.push(step.claims);
  }
  return {downClaims: down.claims, claims};
}

/** 처음 잡은 move 의 번호(없으면 null). */
const firstClaim = (claims: boolean[]) => {
  const index = claims.indexOf(true);
  return index === -1 ? null : index;
};

describe('판정 표 — 오→왼 문턱을 넘은 가로 쓸기만 잡는다', () => {
  it.each([
    ['오→왼, 가져가는 문턱(12pt)만큼', [at(-REPLY_ACTIVATE_PX)], 0],
    ['오→왼, 문턱에 1pt 모자람', [at(-REPLY_ACTIVATE_PX + 1)], null],
    ['짧은 이동(탭 떨림 — 링크·사진·칩을 누르는 손)', [at(-3, 2), at(-5, -2), at(-4, 1)], null],
    ['세로 우세(스크롤)', [at(-4, 30), at(-14, 44)], null],
    ['왼→오(iOS 뒤로 가기 방향) — 얼마나 멀리 가도 잡지 않는다', [at(30), at(80), at(220)], null],
    ['세로로 먼저 갔다가 옆으로 — 되돌아올 길이 없는 영구 탈락', [at(-2, 30), at(-200, 30), at(-300, 0)], null],
    ['천천히 나눠서 문턱을 넘는다', [at(-5), at(-9), at(-13)], 2],
    ['둘째 손가락이 있는 동안은 잡지 않고, 하나로 돌아오면 이어진다', [{...at(-40), touches: 2}, at(-41)], 1],
  ] as const)('%s', (_label, moves, expected) => {
    expect(firstClaim(play(moves).claims)).toBe(expected);
  });

  it('시작에서는 어떤 점·손가락 수에서도 잡지 않는다 — 시작 응답자를 쥐면 iOS 의 네이티브 스크롤이 죽는다 (#4645)', () => {
    for (const touches of [1, 2, 3]) {
      for (const point of [START, at(-500), at(500, 700), {x: 0, y: 0}]) {
        const step = replySwipeStep(IDLE, {kind: 'down', touches, point}, {enabled: true});
        expect(step.claims).toBe(false);
      }
    }
    expect(play([]).downClaims).toBe(false);
  });

  it('밀 수 없는 행(enabled 거짓)과 둘째 손가락으로 시작한 터치는 어떤 이동도 잡지 않는다', () => {
    const swipe = [at(-60), at(-120), at(-200)];
    expect(firstClaim(play(swipe, {enabled: false}).claims)).toBeNull();
    expect(firstClaim(play(swipe, {touches: 2}).claims)).toBeNull();
    expect(firstClaim(play(swipe).claims)).toBe(0); // 대조: 같은 쓸기가 밀 수 있는 행에서는 잡힌다
  });

  it('한 터치에 한 번만 잡는다 — 잡은 뒤의 이동과 손을 뗀 뒤는 다시 잡지 않는다', () => {
    const {claims} = play([at(-20), at(-60), at(-90)]);
    expect(claims).toEqual([true, false, false]);
    const ended = replySwipeStep(
      {origin: START, claimed: true},
      {kind: 'end'},
      {enabled: true},
    );
    expect(ended.state).toBe(IDLE);
  });
});

describe('경계 ±1 — 값이 한 칸만 움직여도 빨개진다', () => {
  it('가져가는 문턱: 11 은 아니고 12 는 맞다', () => {
    expect(firstClaim(play([at(-(REPLY_ACTIVATE_PX - 1))]).claims)).toBeNull();
    expect(firstClaim(play([at(-REPLY_ACTIVATE_PX)]).claims)).toBe(0);
  });

  it('방향: 가로가 세로의 정확히 2배는 아니고, 2배를 넘으면 맞다 (dy 16 에서)', () => {
    const dy = REPLY_SCROLL_LOCK_PX; // 잠금 문턱 안쪽에서 비율만 잰다
    const edge = dy * REPLY_DIRECTION_RATIO;
    expect(firstClaim(play([at(-edge, dy)]).claims)).toBeNull();
    expect(firstClaim(play([at(-(edge + 1), dy)]).claims)).toBe(0);
    // 위쪽으로 드리프트(−dy)도 같은 비율이다.
    expect(firstClaim(play([at(-edge, -dy)]).claims)).toBeNull();
    expect(firstClaim(play([at(-(edge + 1), -dy)]).claims)).toBe(0);
  });

  it('세로 잠금: 16 까지는 아직 후보이고 17 은 영구 탈락이다', () => {
    // 같은 dx(−100)로 잡히는지: 잠기지 않았다면 이 dx 는 어느 dy 에서도 비율을 통과한다.
    expect(firstClaim(play([at(-2, REPLY_SCROLL_LOCK_PX), at(-100, REPLY_SCROLL_LOCK_PX)]).claims)).toBe(1);
    expect(firstClaim(play([at(-2, REPLY_SCROLL_LOCK_PX + 1), at(-100, 0)]).claims)).toBeNull();
  });
});

describe('따라가기와 문턱 — 햅틱·아이콘·놓을 때의 답글이 같은 거리 하나를 읽는다', () => {
  it.each([
    [-(REPLY_COMMIT_PX - 1), false],
    [-REPLY_COMMIT_PX, true], // 문턱에 정확히 닿은 것도 넘은 것이다
    [-(REPLY_COMMIT_PX + 1), true],
    [-300, true],
    [0, false],
    [40, false], // 오른쪽으로 되돌아간 손가락은 문턱에서 멀어진다
  ])('dx %i → 문턱 넘음 %s', (dx, armed) => {
    expect(isReplyArmed(dx)).toBe(armed);
  });

  it('문턱까지 1:1, 오른쪽은 0, 문턱 뒤는 고무줄로 상한 안에서 계속 늘어난다', () => {
    expect(replySwipeOffset(-30)).toBe(30);
    expect(replySwipeOffset(-REPLY_COMMIT_PX)).toBe(REPLY_COMMIT_PX);
    expect(replySwipeOffset(0)).toBe(0);
    expect(replySwipeOffset(80)).toBe(0); // 행은 원점 오른쪽으로 가지 않는다
    let previous = REPLY_COMMIT_PX;
    for (const pulled of [70, 100, 160, 400, 5000]) {
      const offset = replySwipeOffset(-pulled);
      expect(offset).toBeGreaterThanOrEqual(previous);
      expect(offset).toBeLessThan(REPLY_COMMIT_PX + REPLY_OVERSHOOT_MAX_PX);
      expect(offset).toBeGreaterThan(REPLY_COMMIT_PX);
      previous = offset;
    }
  });

  it('상수가 근거와 묶여 있다 — 값이 따로 놀면 이 단정이 먼저 빨개진다', () => {
    // 가져가는 문턱은 길게 누르기 허용치 위: 가져간 손가락은 이미 길게 누르기가 아니다.
    expect(REPLY_ACTIVATE_PX).toBeGreaterThan(MOVE_TOLERANCE_PX);
    // 세로 잠금은 가져가는 문턱 위: 같으면 대각선이 두 판정을 동시에 통과해 이기는 쪽이 이벤트 순서가 된다.
    expect(REPLY_SCROLL_LOCK_PX).toBeGreaterThan(REPLY_ACTIVATE_PX);
    // 답글이 열리는 거리는 눌림 영역(44)보다 크다: 스치듯 민 손가락이 답글을 열지 않는다.
    expect(REPLY_COMMIT_PX).toBeGreaterThan(TOUCH_TARGET);
    // 가로가 세로보다 뚜렷이: 1(대각선)을 넘고 가장자리 뒤로가기(1.4)보다 엄격하다.
    expect(REPLY_DIRECTION_RATIO).toBeGreaterThan(1.4);
  });
});

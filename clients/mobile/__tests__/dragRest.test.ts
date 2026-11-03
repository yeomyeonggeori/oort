import {
  DRAG_REST_PT,
  DragRestKind,
  IDLE_DRAG_REST,
  dragRestStep,
  type DragRestInput,
  type DragRestState,
} from '../src/features/conversation/dragRest';

// =============================================================================
// 대화 목록을 아래로 끌면 입력창이 쉰다 (#4665) — **언제** 쉬는가의 판정.
//
// 손가락이 목록을 끌며 아래로 48pt 누적되면 쉰다. 위로 한 번 가면 누적 0, 손을 뗀 뒤의 관성·목록이 끌지 않는 손가락은 쉬게 하지 않는다, 한 제스처에 한 번.
// 끌기 시작 알림(`onScrollBeginDrag`)보다 **앞선** 아래 이동도 같은 규칙으로 쌓아 두었다가 알림이 오는 순간 문턱이면 쉰다(#5088 — JS 가 바쁠 때 합쳐진 `touchMove` 가 알림 앞에 몰려 온다).
//
// 판정은 순수 함수라 제스처 시퀀스를 그대로 재생한다. 이 파일의 단정은 전부 **재생한 결과**(어느 단계에서 `rest` 가 참이 되나)를 읽는다 — 경계는 숫자(47·48)로 적고
// 상수를 읽어 상수와 비교하지 않는다(상수를 옮기면 이 시험이 빨개진다). 상수 자체는 맨 아래에서 계약 값으로 못 박는다.
// =============================================================================

const down = (y: number, touches = 1): DragRestInput => ({kind: DragRestKind.Down, y, touches});
const move = (y: number): DragRestInput => ({kind: DragRestKind.Move, y});
const up = (touches = 0): DragRestInput => ({kind: DragRestKind.Up, touches});
const cancel: DragRestInput = {kind: DragRestKind.Cancel};
const dragBegin: DragRestInput = {kind: DragRestKind.DragBegin};
const dragEnd: DragRestInput = {kind: DragRestKind.DragEnd};

/** 시퀀스를 재생해 **쉬라고 한 단계의 번호**(0부터)를 모두 돌려준다. 시작 상태를 줄 수 있다. */
function play(inputs: DragRestInput[], from: DragRestState = IDLE_DRAG_REST) {
  let state = from;
  const restAt: number[] = [];
  inputs.forEach((input, index) => {
    const step = dragRestStep(state, input);
    state = step.state;
    if (step.rest) restAt.push(index);
  });
  return {restAt, state};
}

/** 손가락이 (y=300) 에 닿고 목록이 끌리기 시작한 뒤 — 이 앞에서 시작하는 시퀀스들의 공통 머리. */
const DRAG_HEAD: DragRestInput[] = [down(300), dragBegin];

describe('아래로 48pt 누적 — 경계', () => {
  it('47pt 에서는 쉬지 않는다 — 한 걸음으로도 잘게 나눠서도', () => {
    expect(play([...DRAG_HEAD, move(347)]).restAt).toEqual([]);
    const small = Array.from({length: 47}, (_, index) => move(301 + index)); // 1pt 씩 47번 = 47pt
    expect(play([...DRAG_HEAD, ...small]).restAt).toEqual([]);
  });

  it('48pt 에서 쉰다 — 문턱 그 자체도 쉰다(「이상」), 그 단계에서', () => {
    // 위 시험과 한 쌍이다: 같은 시퀀스에서 거리만 1pt 늘리면 뒤집힌다.
    expect(play([...DRAG_HEAD, move(348)]).restAt).toEqual([2]);
    const small = Array.from({length: 48}, (_, index) => move(301 + index));
    expect(play([...DRAG_HEAD, ...small]).restAt).toEqual([2 + 47]); // 마지막(48번째) 걸음에서
  });

  it('한 번에 크게 넘어도 쉰다 — 빠른 스와이프는 걸음이 커서 문턱을 건너뛴다', () => {
    expect(play([...DRAG_HEAD, move(500)]).restAt).toEqual([2]);
  });

  it('끌기가 시작되기 전의 아래 움직임도 쌓인다 — 끌기 시작 알림이 오면 그 거리에 이어서 센다 (#5088)', () => {
    // 손가락이 20pt 내려간 뒤에야 목록이 끌리기 시작했다. 그 20pt 는 담겨 있고(옛 판은 버렸다), 이어서 27pt 더 가면 합 47pt 다.
    expect(play([down(300), move(320), dragBegin, move(347)]).restAt).toEqual([]); // 20 + 27 = 47pt
    expect(play([down(300), move(320), dragBegin, move(348)]).restAt).toEqual([3]); // 20 + 28 = 48pt
  });

  it('끌기 시작 알림이 이동보다 늦게 와도 쉰다 — 이미 쌓인 것이 문턱이면 알림이 오는 그 단계에서 (#5088)', () => {
    // 합쳐진 `touchMove` 하나가 알림 앞에 몰려 온 모양(JS 가 바쁠 때 빠른 스와이프가 보내는 순서): 닿음 → 이동(한 번에 크게) → 끌기 시작.
    expect(play([down(300), move(347), dragBegin]).restAt).toEqual([]); // 47pt: 알림이 와도 안 쉰다
    expect(play([down(300), move(348), dragBegin]).restAt).toEqual([2]); // 48pt: 알림이 오는 순간 쉰다
    expect(play([down(300), move(422), dragBegin]).restAt).toEqual([2]); // 122pt(화면 14%): 빠른 스와이프 전부가 알림 앞에 왔다
    // 알림이 와도 47pt 면 다음 1pt 에서 쉰다 — 쌓아 둔 47pt 에 이어진다.
    expect(play([down(300), move(347), dragBegin, move(348)]).restAt).toEqual([3]);
  });
});

describe('위로 한 번 가면 누적 0', () => {
  it('40pt 내려갔다 1pt 만 올라와도 처음부터 다시 센다 — 다시 47pt 는 안 쉬고 48pt 에 쉰다', () => {
    const wander = [...DRAG_HEAD, move(340), move(339)]; // 40pt 쌓고 1pt 위로 → 0
    expect(play([...wander, move(386)]).restAt).toEqual([]); // 339 → 386 = 47pt
    expect(play([...wander, move(387)]).restAt).toEqual([wander.length]); // 339 → 387 = 48pt
  });

  it('대조: 올라온 적이 없으면 같은 걸음으로 이미 쉬었을 거리다 — 위로 한 번이 누적을 지웠다', () => {
    // 40pt + 8pt = 48pt. 위 시험은 같은 8pt 를 더해도(339 → 347) 쉬지 않는다.
    expect(play([...DRAG_HEAD, move(340), move(348)]).restAt).toEqual([3]);
    expect(play([...DRAG_HEAD, move(340), move(339), move(347)]).restAt).toEqual([]);
  });

  it('같은 높이(가로로만 움직임)는 누적을 쌓지도 지우지도 않는다', () => {
    const sideways = [...DRAG_HEAD, move(340), move(340), move(340)];
    expect(play([...sideways, move(347)]).restAt).toEqual([]); // 340 → 347 = 7 → 합 47
    expect(play([...sideways, move(348)]).restAt).toEqual([sideways.length]); // 합 48
  });

  it('끌기 시작 전에도 위로 한 번 가면 쌓아 둔 것이 0 이다 — 알림이 와도 다시 48pt 가 되어야 쉰다 (#5088)', () => {
    const wander = [down(300), move(340), move(339)]; // 40pt 쌓고 1pt 위로 → 0 (끌기는 아직 시작 전)
    expect(play([...wander, move(386), dragBegin]).restAt).toEqual([]); // 339 → 386 = 47pt
    expect(play([...wander, move(386), dragBegin, move(387)]).restAt).toEqual([wander.length + 2]); // 알림 뒤 1pt 더 → 48pt
    expect(play([...wander, move(387), dragBegin]).restAt).toEqual([wander.length + 1]); // 339 → 387 = 48pt, 알림에서
    // 대조: 올라온 적이 없으면 같은 걸음으로 알림에서 이미 쉬었을 거리다 — 위로 한 번이 쌓아 둔 것을 지웠다.
    expect(play([down(300), move(340), move(348), dragBegin]).restAt).toEqual([3]);
  });

  it('위로 훑는 손은 끌기 시작 알림이 와도 쉬지 않는다 — 계속 위로 가는 한 쌓인 것이 없다 (#5088)', () => {
    expect(play([down(500), move(480), move(400), move(300), dragBegin, move(200)]).restAt).toEqual([]);
    // 합쳐진 이동 하나(500 → 200, 위로 300pt)가 알림 앞에 와도 같다.
    expect(play([down(500), move(200), dragBegin, move(100)]).restAt).toEqual([]);
  });
});

describe('관성 중에는 부르지 않는다 — 손가락이 목록을 끌 때만 센다', () => {
  it('목록이 손가락에 끌리지 않으면 손가락이 아무리 멀리 내려가도 쉬게 하지 않는다 — 쌓아 둘 뿐이다', () => {
    // 끌기 시작 알림(`onScrollBeginDrag`)이 없다 — 목록 밖 응답자가 가져간 제스처·관성 중 막 닿은 손가락의 움직임.
    expect(play([down(300), move(400), move(600), move(900)]).restAt).toEqual([]);
  });

  it('손을 뗀 뒤의 관성은 세지 않는다 — 손 뗌이 제스처를 비워서, 던진 목록이 멀리 미끄러져도(손가락 없음) 쌓인 것이 없다', () => {
    // 30pt 끌고 뗐다. 관성 동안 목록이 수백 pt 가도 손가락은 닿아 있지 않으므로 터치 이벤트가 없다 — 이 판정에는 끌기 끝 알림만 온다.
    const flick = [...DRAG_HEAD, move(330), up(), dragEnd];
    const {restAt, state} = play(flick);
    expect(restAt).toEqual([]);
    // 손 뗌이 이 제스처를 비웠다: 끌기·누적·위치 어느 것도 남지 않는다 — 비우지 않으면 다음 손가락이 낡은 30pt 와 끌기 상태를 이어받는다.
    expect(state).toEqual(IDLE_DRAG_REST);
    // 대조: 그 직후 닿은 손가락이 목록이 끌리기 전에 100pt 움직여도(관성을 멈추려는 손) 낡은 누적과 합쳐 쉬지 않는다.
    expect(play([...flick, down(300), move(400)]).restAt).toEqual([]);
  });

  it('관성 중에 닿은 새 손가락은 목록이 끌리기 전에는 쉬게 하지 않고, 목록이 끌리기 시작하면 닿은 뒤의 거리를 센다 — 앞 제스처의 30pt 는 이어받지 않는다', () => {
    const afterFlick = [...DRAG_HEAD, move(330), up(), dragEnd]; // 앞 제스처: 30pt 끌고 뗐다
    // 새 손가락이 닿아 100pt 움직였지만 목록은 아직 끌기를 알리지 않았다.
    expect(play([...afterFlick, down(300), move(400)]).restAt).toEqual([]);
    // 목록이 끌기를 알리면 그동안 쌓인 100pt 가 이미 문턱이다 — 그 자리에서 쉰다(#5088: 같은 제스처의 앞선 이동이다).
    const caught = [...afterFlick, down(300), move(400)];
    expect(play([...caught, dragBegin]).restAt).toEqual([caught.length]);
    // 대조: 닿은 뒤 47pt 만 움직였으면 알림이 와도 안 쉬고 48pt 가 되는 이동에서 쉰다. 앞 제스처의 30pt 를 이어받았다면 알림에서 이미 쉬었다.
    const slow = [...afterFlick, down(300), move(347), dragBegin];
    expect(play(slow).restAt).toEqual([]);
    expect(play([...slow, move(348)]).restAt).toEqual([slow.length]);
  });

  it('손을 떼면 끌기 끝 알림이 아직 안 와도 끌기는 끝난다 — 관성을 멈추려 곧바로 닿은 손가락은 알림이 늦어도 쉬게 하지 않는다', () => {
    // 손 뗌 뒤 `onScrollEndDrag` 가 오기 전에 새 손가락이 닿아 100pt 움직였다 — 손을 뗀 순간 끌기는 끝났다(알림이 곧 오든 늦든 같다).
    expect(play([...DRAG_HEAD, move(330), up(), down(300), move(400)]).restAt).toEqual([]);
  });

  it('끌기 끝 알림이 먼저 와도(손가락은 아직 닿아 있다) 그 뒤의 움직임은 세지 않는다', () => {
    expect(play([...DRAG_HEAD, move(330), dragEnd, move(430), move(530)]).restAt).toEqual([]);
  });

  it('한 손가락이 끌기를 끝냈다 다시 시작하면 0 에서 새로 센다 — 앞의 누적을 이어받지 않는다', () => {
    const restarted = [...DRAG_HEAD, move(340), dragEnd, dragBegin]; // 40pt 쌓고 끌기가 끊겼다 다시 시작
    expect(play([...restarted, move(387)]).restAt).toEqual([]); // 340 → 387 = 47pt (이어받으면 87pt 로 이미 쉬었다)
    expect(play([...restarted, move(388)]).restAt).toEqual([restarted.length]); // 48pt
  });

});

describe('한 제스처에 한 번 · 손가락 하나', () => {
  it('쉬라고 한 뒤 계속 끌어도 다시 알리지 않는다 — 뗄 때까지 한 번', () => {
    expect(play([...DRAG_HEAD, move(348), move(600), move(900), move(1500)]).restAt).toEqual([2]);
    // 끌기 시작 알림에서 쉬었어도 같다(#5088): 그 뒤의 이동도, 끌기 시작 알림이 한 번 더 와도 다시 알리지 않는다.
    expect(play([down(300), move(400), dragBegin, move(500), move(900)]).restAt).toEqual([2]);
    expect(play([down(300), move(400), dragBegin, dragBegin]).restAt).toEqual([2]);
  });

  it('앞 제스처의 끝(손 뗌)을 놓친 채 새 손가락이 닿으면 쌓아 둔 것을 이어받지 않는다 — 닿는 순간 0 에서 시작한다 (#5088)', () => {
    // 40pt 쌓다 손 뗌을 놓쳤다(취소도 없었다). 새 손가락이 닿아 끌기가 시작되고 47pt 를 갔다 — 이어받았다면 합 87pt 라 알림에서 이미 쉬었다.
    const missedUp = [down(300), move(340), down(300)];
    expect(play([...missedUp, dragBegin, move(347)]).restAt).toEqual([]);
    expect(play([...missedUp, dragBegin, move(348)]).restAt).toEqual([missedUp.length + 1]);
  });

  it('손을 뗀 뒤의 새 제스처는 다시 쉰다', () => {
    const first = [...DRAG_HEAD, move(348), up(), dragEnd];
    const second = [down(300), dragBegin, move(348)];
    expect(play([...first, ...second]).restAt).toEqual([2, first.length + 2]);
  });

  it('손가락이 둘이면 세지 않는다 — 둘째가 닿으면 이 제스처는 깨지고, 마지막 손가락이 떼어질 때까지 이어진다', () => {
    expect(play([down(300), down(300, 2), dragBegin, move(500)]).restAt).toEqual([]);
    // 첫 손가락이 먼저 떨어져도(남은 1) 깨진 채다.
    expect(play([...DRAG_HEAD, move(330), down(300, 2), up(1), move(500)]).restAt).toEqual([]);
    // 대조: 깨진 제스처가 끝난 뒤의 새 손가락은 다시 센다.
    const afterBroken = [...DRAG_HEAD, down(300, 2), up(1), up(0), dragEnd];
    expect(play([...afterBroken, down(300), dragBegin, move(348)]).restAt).toEqual([afterBroken.length + 2]);
  });

  it('손가락이 남은 채 하나가 떼어지면 그 제스처는 세지 않는다 — 둘째가 닿는 것을 못 봤어도', () => {
    expect(play([...DRAG_HEAD, move(330), up(1), move(500)]).restAt).toEqual([]);
  });

  it('손가락이 둘이었던 제스처는 끌기 시작 알림이 와도 쉬지 않는다 — 문턱을 넘는 거리가 이미 쌓여 있었어도 (#5088)', () => {
    // 쌓아 둔 100pt 가 문턱을 넘었지만 둘째 손가락이 닿았다(확대·두 손가락 스크롤) — 알림에서 쉬면 안 된다.
    expect(play([down(300), move(400), down(300, 2), dragBegin]).restAt).toEqual([]);
    // 둘째가 닿는 것을 못 보고 하나가 떼어져도(남은 1) 같다.
    expect(play([down(300), move(400), up(1), dragBegin]).restAt).toEqual([]);
  });

  it('시스템이 터치를 가져가면(취소) 쌓인 것을 비운다 — 취소 뒤의 움직임은 닿는 것을 못 본 움직임이다', () => {
    // 취소가 끌기·누적·위치를 모두 비운다.
    expect(play([...DRAG_HEAD, move(340), cancel]).state).toEqual(IDLE_DRAG_REST);
    // 대조: 40pt 쌓였다 취소됐으면 그 뒤 끌기가 다시 시작돼도 이어받지 않는다 — 이어받았다면 20pt 만 더 가도 쉬었다.
    expect(play([...DRAG_HEAD, move(340), cancel, dragBegin, move(500), move(520)]).restAt).toEqual([]);
    // 취소 뒤 끌기 시작 알림 없이 닿는 것을 못 본 손가락이 멀리 가도 쉬지 않는다.
    const {restAt, state} = play([...DRAG_HEAD, move(330), cancel, move(500), move(600)]);
    expect(restAt).toEqual([]);
    expect(state.lastY).toBe(600); // 위치는 적지만(첫 위치) 끌기는 꺼진 채다
    expect(state.dragging).toBe(false);
  });
});

describe('아직 모르는 것을 쌓지 않는다', () => {
  it('닿는 것을 못 본 이동은 첫 위치만 적는다 — 어디서 왔는지 모르는 거리는 쌓지 않는다', () => {
    // 끌기는 이미 시작됐고 손가락이 닿는 것만 못 봤다: 첫 이동은 위치만 적고, 그다음 걸음부터 센다.
    expect(play([dragBegin, move(300), move(347)]).restAt).toEqual([]);
    expect(play([dragBegin, move(300), move(348)]).restAt).toEqual([2]);
  });

  it('숫자가 아닌 높이는 읽지 않는다 — 앞 위치가 그대로라 다음 걸음이 거리를 이어 잰다', () => {
    expect(play([...DRAG_HEAD, move(Number.NaN), move(348)]).restAt).toEqual([3]);
    // 닿는 높이를 못 읽었으면 닿는 것을 못 본 것과 같다: 첫 이동은 위치만 적고 그다음 걸음(300 → 348)부터 센다.
    expect(play([down(Number.NaN), dragBegin, move(300), move(348)]).restAt).toEqual([3]);
  });
});

describe('상수', () => {
  it('누적 문턱은 owner 결정(10-27, Buzz 값)인 48pt 다 — 바꾸려면 이 줄과 위 경계 시험을 함께 고친다', () => {
    expect(DRAG_REST_PT).toBe(48);
  });
});

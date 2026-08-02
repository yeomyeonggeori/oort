import { describe, expect, it } from "vitest";
import {
  IDLE,
  MOVE_TOLERANCE_PX,
  pressStep,
  type PressEffect,
  type PressInput,
  type PressState,
} from "./longPressModel";

// =============================================================================
// 이 훅에는 1라운드에 테스트가 하나도 없었고, 그래서 "스크롤은 누르기가
// 아니다"가 죽은 코드로 머물러 있는 것을 아무도 몰랐다. 여기서 재는 것은
// 결과가 아니라 **게이트가 돌았다는 사실**이다.
// =============================================================================

/**
 * 타이머를 대신하는 아주 작은 드라이버.
 *
 * `arm`이면 타이머가 걸린 것으로, `disarm`이면 풀린 것으로 친다. 시퀀스 끝에서
 * 여전히 걸려 있으면 그 제스처는 시트를 연다.
 */
function play(
  inputs: PressInput[],
  options: { enabled?: boolean } = {}
): { opens: boolean; effects: PressEffect[]; state: PressState } {
  let state = IDLE;
  let armed = false;
  const effects: PressEffect[] = [];
  for (const input of inputs) {
    const step = pressStep(state, input, { enabled: options.enabled ?? true });
    state = step.state;
    effects.push(step.effect);
    if (step.effect === "arm") armed = true;
    if (step.effect === "disarm") armed = false;
  }
  return { opens: armed, effects, state };
}

const touchDown = (x = 100, y = 200): PressInput => ({
  kind: "down",
  pointerType: "touch",
  point: { x, y },
});

const move = (x: number, y: number): PressInput => ({
  kind: "move",
  point: { x, y },
});

describe("pressStep: 무엇이 길게 누르기인가", () => {
  it("손가락이 가만히 있으면 시트가 열린다", () => {
    expect(play([touchDown(), move(100, 200)]).opens).toBe(true);
  });

  it("손 떨림(3px)은 누르기를 취소하지 않는다", () => {
    expect(play([touchDown(), move(102, 202), move(101, 199)]).opens).toBe(true);
  });

  it("손을 떼면 타이머가 풀린다", () => {
    expect(play([touchDown(), { kind: "end" }]).opens).toBe(false);
  });

  it("두 번째 누르기는 첫 번째의 타이머를 대체한다", () => {
    // 대체하지 않으면 손을 뗀 메시지의 시트가 나중에 열린다.
    const { effects } = play([touchDown(), touchDown(300, 400)]);
    expect(effects).toEqual(["arm", "arm"]);
  });
});

describe("규칙 1, 터치만 무장한다", () => {
  it("마우스 누르기는 무장하지 않는다", () => {
    const { opens, effects } = play([
      { kind: "down", pointerType: "mouse", point: { x: 1, y: 1 } },
      move(1, 1),
    ]);
    expect(opens).toBe(false);
    expect(effects[0]).toBe("disarm");
  });

  it("펜도 아니다", () => {
    expect(
      play([{ kind: "down", pointerType: "pen", point: { x: 1, y: 1 } }]).opens
    ).toBe(false);
  });

  it("열 것이 없는 행(enabled=false)은 터치에도 무장하지 않는다", () => {
    expect(play([touchDown()], { enabled: false }).opens).toBe(false);
  });
});

describe("규칙 2, 스크롤은 누르기가 아니다", () => {
  it("한 번에 크게 끌면 취소된다", () => {
    expect(play([touchDown(100, 200), move(100, 260)]).opens).toBe(false);
  });

  /**
   * **1라운드가 놓친 바로 그 제스처.**
   *
   * 브라우저의 slop 임계 아래에서 천천히 끌다 멈추는 손가락은 `pointercancel`을
   * 만들지 않는다. 3px씩 다섯 번이면 어느 한 걸음도 10px을 넘지 않지만 시작점
   * 에서는 15px 떨어져 있다 — 직전 위치 기준으로 쟀다면 다섯 번 다 통과했을
   * 시퀀스이고, 그게 읽으려고 문지른 화면에서 시트가 열리던 경로다.
   */
  it("직전 위치가 아니라 시작점에서 잰다: 3px씩 다섯 번은 스크롤이다", () => {
    const { opens } = play([
      touchDown(100, 200),
      move(100, 203),
      move(100, 206),
      move(100, 209),
      move(100, 212),
      move(100, 215),
    ]);
    expect(opens).toBe(false);
  });

  it("대각선 8px+8px은 축별로는 통과하지만 실제 거리는 11px이다", () => {
    // 축마다 따로 재면 통과하는 대각선 끌기. 손가락은 대각선으로도 스크롤한다.
    const { opens } = play([touchDown(100, 200), move(108, 208)]);
    expect(Math.hypot(8, 8)).toBeGreaterThan(MOVE_TOLERANCE_PX);
    expect(opens).toBe(false);
  });

  it("취소된 뒤의 움직임은 다시 무장시키지 않는다", () => {
    const { opens } = play([
      touchDown(100, 200),
      move(100, 300),
      move(100, 201), // 손가락이 시작점 근처로 돌아와도 이 제스처는 끝났다
    ]);
    expect(opens).toBe(false);
  });

  it("무장 전의 움직임은 아무 일도 하지 않는다", () => {
    const { effects } = play([move(1, 1)]);
    expect(effects).toEqual(["none"]);
  });
});

describe("시트가 열린 뒤", () => {
  it("타이머가 울리면 상태가 비고, 이어지는 움직임은 무해하다", () => {
    const { opens, state } = play([
      touchDown(),
      { kind: "fire" },
      move(999, 999),
    ]);
    expect(state.origin).toBeNull();
    // `fire`는 disarm이 아니다: 타이머는 이미 스스로 울렸다.
    expect(opens).toBe(true);
  });
});

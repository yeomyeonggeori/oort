import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SETTLE_SRC = readFileSync(
  new URL("../../scripts/capture-intro-settle.mjs", import.meta.url),
  "utf8"
);
const CAPTURE_SRC = readFileSync(
  new URL("../../scripts/capture-screens.mjs", import.meta.url),
  "utf8"
);

type PoseSample = {
  vis: string | null;
  intro: { top: number; height: number } | null;
  scrollTop: number | null;
  now: unknown;
};

type SettleMod = {
  SETTLE_STABLE_FRAMES: number;
  SETTLE_FRAME_CEILING: number;
  introPoseKey: (sample: PoseSample) => string | null;
  tickIntroSettle: (
    state: { key: string | null; stable: number },
    sample: PoseSample,
    stableNeed: number
  ) => boolean;
};

const settle = new Function(
  `${SETTLE_SRC.replaceAll("export const", "const").replaceAll("export function", "function")}
return {
  SETTLE_STABLE_FRAMES,
  SETTLE_FRAME_CEILING,
  introPoseKey,
  tickIntroSettle,
};`
)() as SettleMod;

const {
  SETTLE_FRAME_CEILING,
  SETTLE_STABLE_FRAMES,
  introPoseKey,
  tickIntroSettle,
} = settle;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function driftingFrames(count: number): PoseSample[] {
  return Array.from({ length: count }, (_, i) => ({
    vis: i === 0 ? "hidden" : "visible",
    intro: { top: 85 + i * 8, height: 154 },
    scrollTop: i * 12,
    now: {},
  }));
}

function settledFrames(count: number): PoseSample[] {
  return Array.from({ length: count }, () => ({
    vis: "visible",
    intro: { top: 85, height: 154 },
    scrollTop: 0,
    now: {},
  }));
}

describe("capture intro settle predicate", () => {
  it("a still-moving intro (hidden list or drifting scrollTop) does not settle", () => {
    const state = { key: null as string | null, stable: 0 };
    let settledAt = -1;
    driftingFrames(SETTLE_FRAME_CEILING).forEach((sample, i) => {
      if (tickIntroSettle(state, sample, SETTLE_STABLE_FRAMES) && settledAt < 0) {
        settledAt = i;
      }
    });
    expect(settledAt).toBe(-1);
  });

  it("a stable visible intro settles as soon as SETTLE_STABLE_FRAMES consecutive poses hold", () => {
    const state = { key: null as string | null, stable: 0 };
    let settledAt = -1;
    settledFrames(10).forEach((sample, i) => {
      if (tickIntroSettle(state, sample, SETTLE_STABLE_FRAMES) && settledAt < 0) {
        settledAt = i;
      }
    });
    expect(settledAt).toBe(SETTLE_STABLE_FRAMES);
    expect(SETTLE_FRAME_CEILING).toBe(60);
  });

  it("S8: gut vis and scrollTop from the key (keep the comment) and a moving scene falsely settles; the real key does not", () => {
    function guttedKey(sample: PoseSample): string | null {
      // (1) item-list 가 hidden 이 아님 (initialItemFinalLocationReached)
      if (!sample.now || !sample.intro || sample.intro.height <= 0) return null;
      return `${Math.round(sample.intro.top)}:${Math.round(sample.intro.height)}`;
    }
    function tickGutted(
      state: { key: string | null; stable: number },
      sample: PoseSample
    ): boolean {
      const key = guttedKey(sample);
      if (key === null) {
        state.key = null;
        state.stable = 0;
        return false;
      }
      if (key === state.key) state.stable += 1;
      else {
        state.key = key;
        state.stable = 0;
      }
      return state.stable >= SETTLE_STABLE_FRAMES;
    }
    const gutted = { key: null as string | null, stable: 0 };
    const real = { key: null as string | null, stable: 0 };
    const visLocked = Array.from({ length: 12 }, (_, i) => ({
      vis: "visible" as const,
      intro: { top: 85, height: 154 },
      scrollTop: i * 40,
      now: {},
    }));
    expect(visLocked.some((sample) => tickGutted(gutted, sample))).toBe(true);
    expect(
      visLocked.some((sample) =>
        tickIntroSettle(real, sample, SETTLE_STABLE_FRAMES)
      )
    ).toBe(false);
    expect(introPoseKey(visLocked[3]!)).toContain(":visible");
    expect(introPoseKey(visLocked[3]!)).toMatch(/:\d+:visible$/);
  });

  it("capture-screens executes the shared tick, not a copy of the state machine", () => {
    const body = stripComments(CAPTURE_SRC);
    expect(body).toMatch(/tickIntroSettle\.toString\(\)/);
    expect(body).toMatch(/introPoseKey\.toString\(\)/);
    expect(body).toMatch(/SETTLE_STABLE_FRAMES/);
    expect(body).toMatch(/SETTLE_FRAME_CEILING/);
    expect(body).not.toMatch(/INTRO_SETTLE_FRAME_CEILING/);
    expect(body).not.toMatch(/minFrames/);
    expect(body).not.toMatch(/for \(let i = 0; i < 180/);
    expect(body).toMatch(/pinPageWallClock/);
    expect(body).not.toMatch(/setFixedTime/);
  });
});

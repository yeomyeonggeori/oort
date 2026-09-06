/**
 * Capture-lane intro settle predicate (#2050 R2 H-3 / B-2).
 *
 * Shared between `capture-screens.mjs` (page.evaluate receives the function
 * source) and the behavioral guard. Gutting vis / scrollTop from the key
 * while keeping a comment is exactly S8 — the tests below that import this
 * module go red, and a moving intro no longer aborts.
 */

/** Consecutive frames the pose must hold before the lane proceeds. */
export const SETTLE_STABLE_FRAMES = 3;

/** Abort ceiling for every timeline scene except nonempty intro. Base value. */
export const SETTLE_FRAME_CEILING = 60;

/**
 * Nonempty-intro ceiling. The predicate first holds at frame 3 on a settled
 * scene (R1 instrumentation: 1 unique pose from frame 0). Same 60 as the
 * prior lane; not a sleep — the loop exits as soon as SETTLE_STABLE_FRAMES
 * consecutive matches land.
 */
export const INTRO_SETTLE_FRAME_CEILING = 60;

/**
 * @param {{
 *   vis: string | null,
 *   intro: { top: number, height: number } | null,
 *   scrollTop: number | null,
 *   now: unknown,
 * }} sample
 * @returns {string | null}
 */
export function introPoseKey(sample) {
  if (sample.vis === "hidden") return null;
  if (!sample.now || !sample.intro || sample.intro.height <= 0) return null;
  return (
    `${Math.round(sample.intro.top)}:${Math.round(sample.intro.height)}:` +
    `${Math.round(sample.scrollTop ?? 0)}:${sample.vis}`
  );
}

/**
 * @param {{ key: string | null, stable: number }} state
 * @param {Parameters<typeof introPoseKey>[0]} sample
 * @param {number} stableNeed
 * @returns {boolean} true once `stableNeed` consecutive matching poses hold
 */
export function tickIntroSettle(state, sample, stableNeed) {
  const key = introPoseKey(sample);
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
  return state.stable >= stableNeed;
}

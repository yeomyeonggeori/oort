/**
 * Capture-lane wall-clock policy (#2050 R3 M-4).
 *
 * `pinPageWallClock` freezes `Date` on every capture page, so elapsed-time
 * gates (`ApprovalActions` `CONFIRM_GUARD_MS`) can never open. Scenes that
 * must let time pass opt into `clock: "flowing"`; everything else is
 * `fixed`. A fixed-clock scene that clicks a time-gated control aborts
 * with a sentence naming the gate.
 */

/** Product testids whose click is an elapsed-time gate under Date.now(). */
export const TIME_GATED_TEST_IDS = ["inbox-approval-confirm"];

/**
 * Scene registry. Default is `fixed`. Only named entries may flow.
 * `welcome-backstop` uses `page.clock.install` + `fastForward(120s)`.
 *
 * @type {Record<string, "fixed" | "flowing">}
 */
export const CAPTURE_SCENE_CLOCK = {
  "welcome-backstop": "flowing",
};

let activeScene = "default";

/** @param {string} name */
export function setActiveCaptureScene(name) {
  activeScene = name;
}

export function activeCaptureScene() {
  return activeScene;
}

/** @param {string} sceneName */
export function clockForScene(sceneName) {
  return CAPTURE_SCENE_CLOCK[sceneName] ?? "fixed";
}

/**
 * @param {string} sceneName
 * @param {string} testId
 */
export function abortIfFixedClockClicksTimeGate(sceneName, testId) {
  if (clockForScene(sceneName) !== "fixed") return;
  if (!TIME_GATED_TEST_IDS.includes(testId)) return;
  throw new Error(
    `CAPTURE ABORT: scene "${sceneName}" is clock:fixed; time-gated control [${testId}] cannot open CONFIRM_GUARD_MS under a frozen Date`
  );
}

/**
 * Wrap Playwright `page.getByTestId` so `.click()` (including `.first()` /
 * `.last()` / `.nth()` chains) is the machine. `waitFor` is not a click.
 *
 * @param {import("playwright").Page} page
 */
export function wrapPageTimeGateClicks(page) {
  const orig = page.getByTestId.bind(page);
  page.getByTestId = (testId, ...rest) =>
    wrapLocatorClicks(orig(testId, ...rest), String(testId));
  return page;
}

/**
 * @param {import("playwright").Locator} locator
 * @param {string} testId
 */
function wrapLocatorClicks(locator, testId) {
  const origClick = locator.click.bind(locator);
  locator.click = async (...args) => {
    abortIfFixedClockClicksTimeGate(activeCaptureScene(), testId);
    return origClick(...args);
  };
  for (const chain of ["first", "last", "nth"]) {
    const orig = locator[chain].bind(locator);
    locator[chain] = (...args) => wrapLocatorClicks(orig(...args), testId);
  }
  return locator;
}

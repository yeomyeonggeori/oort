/**
 * Capture-lane wall-clock policy (#2050 R4 M-4).
 *
 * `pinPageWallClock` freezes `Date` on every capture page, so elapsed-time
 * gates (`ApprovalActions` `CONFIRM_GUARD_MS`) can never open. Scenes that
 * must let time pass opt into `clock: "flowing"`; everything else is
 * `fixed`. A fixed-clock scene that clicks a time-gated control aborts
 * with a sentence naming the scene and the control.
 *
 * The control registry is the product export `TIME_GATED_CONTROLS` next
 * to `CONFIRM_GUARD_MS`. Scene clicks go through `sceneClick`; wrap also
 * intercepts `page.locator(...).click()` so the R3 S9 bypass cannot pass.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APPROVAL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/features/timeline/ApprovalActions.tsx"
);

/** @param {string} src */
export function parseTimeGatedControls(src) {
  const match = src.match(
    /export const TIME_GATED_CONTROLS\s*=\s*\[([\s\S]*?)\]\s*as const/
  );
  if (!match) {
    throw new Error(
      "TIME_GATED_CONTROLS export missing from ApprovalActions.tsx"
    );
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1]);
}

export const TIME_GATED_CONTROLS = parseTimeGatedControls(
  readFileSync(APPROVAL_PATH, "utf8")
);

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

/** @param {unknown} selector */
export function testIdFromSelector(selector) {
  if (typeof selector !== "string") return "";
  const attr = selector.match(/\[data-testid=(['"]?)([^'"\]]+)\1\]/);
  if (attr) return attr[2];
  const internal = selector.match(/internal:testid=([^\s)]+)/);
  if (internal) return internal[1];
  return "";
}

/**
 * @param {unknown} locator
 * @param {string} [known]
 */
export function testIdFromLocator(locator, known = "") {
  if (known) return known;
  return testIdFromSelector(String(locator));
}

/**
 * @param {string} sceneName
 * @param {string} testId
 */
export function abortIfFixedClockClicksTimeGate(sceneName, testId) {
  if (clockForScene(sceneName) !== "fixed") return;
  if (!testId || !TIME_GATED_CONTROLS.includes(testId)) return;
  throw new Error(
    `CAPTURE ABORT: scene "${sceneName}" is clock:fixed; time-gated control [${testId}] cannot open CONFIRM_GUARD_MS under a frozen Date`
  );
}

/**
 * Every capture-scene click. Consults `TIME_GATED_CONTROLS` under
 * `clock: "fixed"`. `page` is the Playwright page that owns `locator`.
 *
 * @param {import("playwright").Page} page
 * @param {import("playwright").Locator} locator
 * @param {import("playwright").LocatorClickOptions} [options]
 */
export async function sceneClick(page, locator, options) {
  if (!page) {
    throw new Error("sceneClick requires the Playwright page");
  }
  abortIfFixedClockClicksTimeGate(
    activeCaptureScene(),
    testIdFromLocator(locator)
  );
  return locator.click(options);
}

/**
 * Wrap Playwright locator factories so `.click()` is the machine even
 * when scene code is sabotaged with a raw `page.locator(...).click()`.
 *
 * @param {import("playwright").Page} page
 */
export function wrapPageTimeGateClicks(page) {
  wrapFactory(page, "getByTestId", (testId) => String(testId));
  wrapFactory(page, "locator", (selector) => testIdFromSelector(selector));
  wrapFactory(page, "getByRole", () => "");
  wrapFactory(page, "getByText", () => "");
  wrapFactory(page, "getByLabel", () => "");
  return page;
}

/**
 * @param {import("playwright").Page} page
 * @param {string} name
 * @param {(...args: unknown[]) => string} testIdOf
 */
function wrapFactory(page, name, testIdOf) {
  if (typeof page[name] !== "function") return;
  const orig = page[name].bind(page);
  page[name] = (...args) => wrapLocatorClicks(orig(...args), testIdOf(...args));
}

/**
 * @param {import("playwright").Locator} locator
 * @param {string} testId
 */
function wrapLocatorClicks(locator, testId) {
  const origClick = locator.click.bind(locator);
  locator.click = async (...args) => {
    abortIfFixedClockClicksTimeGate(
      activeCaptureScene(),
      testIdFromLocator(locator, testId)
    );
    return origClick(...args);
  };
  for (const chain of [
    "first",
    "last",
    "nth",
    "locator",
    "filter",
    "and",
    "or",
    "getByTestId",
    "getByRole",
    "getByText",
    "getByLabel",
  ]) {
    if (typeof locator[chain] !== "function") continue;
    const orig = locator[chain].bind(locator);
    locator[chain] = (...args) => {
      const nextId =
        chain === "getByTestId"
          ? String(args[0])
          : chain === "locator"
            ? testIdFromSelector(args[0]) || testId
            : testId;
      return wrapLocatorClicks(orig(...args), nextId);
    };
  }
  return locator;
}

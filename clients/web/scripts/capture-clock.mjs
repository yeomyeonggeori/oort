/**
 * Capture-lane wall-clock policy (#2050 R4 M-4 / R6 H-1).
 *
 * `pinPageWallClock` freezes `Date` on every capture page, so elapsed-time
 * gates (`ApprovalActions` `CONFIRM_GUARD_MS`) can never open. Scenes that
 * must let time pass opt into `clock: "flowing"`; everything else is
 * `fixed`. A fixed-clock scene that clicks a time-gated control aborts
 * with a sentence naming the scene and the control.
 *
 * The control registry is the product export `TIME_GATED_CONTROLS`,
 * derived from `timeGatedTestId` next to `CONFIRM_GUARD_MS` — the
 * interactive element the guard actually gates (the `-commit` button),
 * not the `-confirm` container. Scene clicks go through `sceneClick`;
 * wrap also intercepts `page.locator(...).click()`,
 * `keyboard.press("Enter"|" ")`, `mouse.down()`/`up()`, and
 * `locator.press` so click-equivalents cannot open a time gate under a
 * frozen Date. `beginCaptureScene` is set at scene start so pre-shot
 * interactions are judged by the right scene; `clockForScene` reads
 * that same name.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APPROVAL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/features/timeline/ApprovalActions.tsx"
);

/** @param {string} src */
export function parseTimeGatedControlSuffix(src) {
  const match = src.match(
    /(?:const|export const) TIME_GATED_CONTROL_SUFFIX\s*=\s*"([^"]+)"/
  );
  if (!match) {
    throw new Error(
      "TIME_GATED_CONTROL_SUFFIX missing from ApprovalActions.tsx"
    );
  }
  return match[1];
}

/** @param {string} src */
export function parseTimeGatedControls(src) {
  const suffix = parseTimeGatedControlSuffix(src);
  const match = src.match(
    /export const TIME_GATED_CONTROLS\s*=\s*\[([\s\S]*?)\]\s*as const/
  );
  if (!match) {
    throw new Error(
      "TIME_GATED_CONTROLS export missing from ApprovalActions.tsx"
    );
  }
  const prefixes = [
    ...match[1].matchAll(/timeGatedTestId\("([^"]+)"\)/g),
  ].map((hit) => hit[1]);
  if (prefixes.length === 0) {
    throw new Error(
      "TIME_GATED_CONTROLS must list timeGatedTestId(...) entries"
    );
  }
  return prefixes.map((prefix) => `${prefix}-${suffix}`);
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

/**
 * Scene identity for the time-gate. Call at scene start, before any
 * click/key/mouse, so pre-shot interactions are named by this scene.
 * `clockForScene()` with no argument reads the same name.
 *
 * @param {string} name
 */
export function beginCaptureScene(name) {
  setActiveCaptureScene(name);
  return clockForScene();
}

export function activeCaptureScene() {
  return activeScene;
}

/** @param {string} [sceneName] */
export function clockForScene(sceneName = activeScene) {
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
 * Shot filename → capture scene name. `approvals-confirm-light.png` and
 * `press-triplet-row-rest-dark-390.png` both lose the scheme (and optional
 * `-390`) so the abort sentence names the artefact stem the lane sets.
 *
 * @param {unknown} path
 */
export function sceneNameFromShotPath(path) {
  if (typeof path !== "string" || !path) return "default";
  const base = path.split(/[/\\]/).pop() ?? "";
  const stem = base.replace(/\.png$/i, "");
  return stem.replace(/-390$/, "").replace(/-(light|dark)$/, "") || "default";
}

function isActivateKey(key) {
  return key === "Enter" || key === " " || key === "Space";
}

/**
 * Serialized into the capture page so scene code never writes `new MouseEvent`.
 */
export function installCaptureMouseEventDispatch() {
  window.__oortDispatchMouseEvent = (target, type, init = {}) => {
    if (target == null) return;
    target.dispatchEvent(new MouseEvent(type, init));
  };
}

export async function readFocusedTestId(page) {
  if (typeof page?.evaluate !== "function") return "";
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof Element)) return "";
    return (
      el.getAttribute("data-testid") ||
      el.closest("[data-testid]")?.getAttribute("data-testid") ||
      ""
    );
  });
}

async function readTestIdAt(page, point) {
  if (typeof page?.evaluate !== "function") return "";
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!(el instanceof Element)) return "";
    return (
      el.getAttribute("data-testid") ||
      el.closest("[data-testid]")?.getAttribute("data-testid") ||
      ""
    );
  }, point);
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
 * Enter/Space on a focused control. Same time-gate as `sceneClick`.
 *
 * @param {import("playwright").Page} page
 * @param {string} key
 * @param {import("playwright").KeyboardPressOptions} [options]
 */
export async function sceneKeyboardPress(page, key, options) {
  if (!page) {
    throw new Error("sceneKeyboardPress requires the Playwright page");
  }
  if (isActivateKey(key)) {
    abortIfFixedClockClicksTimeGate(
      activeCaptureScene(),
      await readFocusedTestId(page)
    );
  }
  return page.keyboard.press(key, options);
}

/**
 * @param {import("playwright").Page} page
 * @param {import("playwright").MouseClickOptions} [options]
 */
export async function sceneMouseDown(page, options) {
  if (!page) {
    throw new Error("sceneMouseDown requires the Playwright page");
  }
  abortIfFixedClockClicksTimeGate(
    activeCaptureScene(),
    await readTestIdAt(page, page.__oortMouse ?? { x: 0, y: 0 })
  );
  return page.mouse.down(options);
}

/**
 * @param {import("playwright").Page} page
 * @param {import("playwright").MouseClickOptions} [options]
 */
export async function sceneMouseUp(page, options) {
  if (!page) {
    throw new Error("sceneMouseUp requires the Playwright page");
  }
  abortIfFixedClockClicksTimeGate(
    activeCaptureScene(),
    await readTestIdAt(page, page.__oortMouse ?? { x: 0, y: 0 })
  );
  return page.mouse.up(options);
}

/**
 * Node-side gate + dispatch for an in-page `MouseEvent`. The gated test
 * id is read from the element the event will land on — callers pass the
 * Playwright locator (or `"document"`), not a hand-written test id.
 *
 * @param {import("playwright").Page} page
 * @param {import("playwright").Locator | "document"} locator
 * @param {string} type
 * @param {MouseEventInit} [init]
 */
export async function sceneDispatchMouseEvent(page, locator, type, init = {}) {
  if (!page) {
    throw new Error("sceneDispatchMouseEvent requires the Playwright page");
  }
  let testId = "";
  if (locator === "document") {
    testId = await page.evaluate(() => {
      const el = document.documentElement;
      return (
        el.getAttribute("data-testid") ||
        el.closest("[data-testid]")?.getAttribute("data-testid") ||
        ""
      );
    });
  } else if (locator && typeof locator.evaluate === "function") {
    testId = await locator.evaluate((el) => {
      if (!(el instanceof Element)) return "";
      return (
        el.getAttribute("data-testid") ||
        el.closest("[data-testid]")?.getAttribute("data-testid") ||
        ""
      );
    });
  }
  abortIfFixedClockClicksTimeGate(activeCaptureScene(), testId);
  if (locator === "document") {
    await page.evaluate(({ type, init }) => {
      window.__oortDispatchMouseEvent?.(document, type, init);
    }, { type, init });
    return;
  }
  if (locator && typeof locator.evaluate === "function") {
    await locator.evaluate(
      (el, packed) => {
        window.__oortDispatchMouseEvent?.(el, packed.type, packed.init);
      },
      { type, init }
    );
  }
}

/**
 * Wrap Playwright locator factories so `.click()` is the machine even
 * when scene code is sabotaged with a raw `page.locator(...).click()`.
 *
 * @param {import("playwright").Page} page
 */
export async function wrapPageTimeGateClicks(page) {
  wrapFactory(page, "getByTestId", (testId) => String(testId));
  wrapFactory(page, "locator", (selector) => testIdFromSelector(selector));
  wrapFactory(page, "getByRole", () => "");
  wrapFactory(page, "getByText", () => "");
  wrapFactory(page, "getByLabel", () => "");
  wrapKeyboardActivate(page);
  wrapMouseButtons(page);
  if (typeof page.addInitScript === "function") {
    await page.addInitScript(installCaptureMouseEventDispatch);
  }
  return page;
}

/**
 * @param {import("playwright").Page} page
 */
function wrapKeyboardActivate(page) {
  if (!page.keyboard || typeof page.keyboard.press !== "function") return;
  const orig = page.keyboard.press.bind(page.keyboard);
  page.keyboard.press = async (key, ...args) => {
    if (isActivateKey(key)) {
      abortIfFixedClockClicksTimeGate(
        activeCaptureScene(),
        await readFocusedTestId(page)
      );
    }
    return orig(key, ...args);
  };
}

/**
 * @param {import("playwright").Page} page
 */
function wrapMouseButtons(page) {
  if (!page.mouse || typeof page.mouse.down !== "function") return;
  page.__oortMouse = { x: 0, y: 0 };
  if (typeof page.mouse.move === "function") {
    const origMove = page.mouse.move.bind(page.mouse);
    page.mouse.move = async (x, y, ...rest) => {
      page.__oortMouse = { x, y };
      return origMove(x, y, ...rest);
    };
  }
  const origDown = page.mouse.down.bind(page.mouse);
  const origUp = page.mouse.up.bind(page.mouse);
  page.mouse.down = async (...args) => {
    abortIfFixedClockClicksTimeGate(
      activeCaptureScene(),
      await readTestIdAt(page, page.__oortMouse ?? { x: 0, y: 0 })
    );
    return origDown(...args);
  };
  page.mouse.up = async (...args) => {
    abortIfFixedClockClicksTimeGate(
      activeCaptureScene(),
      await readTestIdAt(page, page.__oortMouse ?? { x: 0, y: 0 })
    );
    return origUp(...args);
  };
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
  if (typeof locator.click === "function") {
    const origClick = locator.click.bind(locator);
    locator.click = async (...args) => {
      abortIfFixedClockClicksTimeGate(
        activeCaptureScene(),
        testIdFromLocator(locator, testId)
      );
      return origClick(...args);
    };
  }
  if (typeof locator.press === "function") {
    const origPress = locator.press.bind(locator);
    locator.press = async (key, ...args) => {
      if (isActivateKey(key)) {
        abortIfFixedClockClicksTimeGate(
          activeCaptureScene(),
          testIdFromLocator(locator, testId)
        );
      }
      return origPress(key, ...args);
    };
  }
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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CLOCK_SRC = readFileSync(
  new URL("../../scripts/capture-clock.mjs", import.meta.url),
  "utf8"
);
const CAPTURE_SRC = readFileSync(
  new URL("../../scripts/capture-screens.mjs", import.meta.url),
  "utf8"
);

type ClockMod = {
  TIME_GATED_TEST_IDS: string[];
  clockForScene: (sceneName: string) => "fixed" | "flowing";
  setActiveCaptureScene: (name: string) => void;
  activeCaptureScene: () => string;
  abortIfFixedClockClicksTimeGate: (sceneName: string, testId: string) => void;
  wrapPageTimeGateClicks: (page: {
    getByTestId: (testId: string) => {
      click: (...args: unknown[]) => Promise<unknown>;
      first: (...args: unknown[]) => unknown;
      last: (...args: unknown[]) => unknown;
      nth: (...args: unknown[]) => unknown;
    };
  }) => unknown;
};

const clock = new Function(
  `${CLOCK_SRC.replaceAll("export const", "const").replaceAll("export function", "function")}
return {
  TIME_GATED_TEST_IDS,
  clockForScene,
  setActiveCaptureScene,
  activeCaptureScene,
  abortIfFixedClockClicksTimeGate,
  wrapPageTimeGateClicks,
};`
)() as ClockMod;

const {
  TIME_GATED_TEST_IDS,
  clockForScene,
  setActiveCaptureScene,
  activeCaptureScene,
  abortIfFixedClockClicksTimeGate,
  wrapPageTimeGateClicks,
} = clock;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("capture clock scene registry", () => {
  it("welcome-backstop is flowing; every other scene is fixed", () => {
    expect(clockForScene("welcome-backstop")).toBe("flowing");
    expect(clockForScene("approvals-confirm")).toBe("fixed");
    expect(clockForScene("chat")).toBe("fixed");
    expect(TIME_GATED_TEST_IDS).toContain("inbox-approval-confirm");
  });

  it("fixed-clock scene clicking inbox-approval-confirm aborts naming CONFIRM_GUARD_MS", () => {
    setActiveCaptureScene("approvals-confirm");
    expect(activeCaptureScene()).toBe("approvals-confirm");
    expect(() =>
      abortIfFixedClockClicksTimeGate("approvals-confirm", "inbox-approval-confirm")
    ).toThrow(
      /CAPTURE ABORT: scene "approvals-confirm" is clock:fixed; time-gated control \[inbox-approval-confirm\] cannot open CONFIRM_GUARD_MS/
    );
    setActiveCaptureScene("default");
  });

  it("welcome-backstop is flowing so the same click is allowed", () => {
    expect(() =>
      abortIfFixedClockClicksTimeGate("welcome-backstop", "inbox-approval-confirm")
    ).not.toThrow();
  });

  it("scratch: wrapPageTimeGateClicks aborts a confirm click in a fixed-clock scene", async () => {
    setActiveCaptureScene("chat");
    const clicks: string[] = [];
    const makeLocator = (testId: string) => {
      const locator = {
        click: async () => {
          clicks.push(testId);
        },
        first() {
          return locator;
        },
        last() {
          return locator;
        },
        nth() {
          return locator;
        },
      };
      return locator;
    };
    const page = {
      getByTestId: (testId: string) => makeLocator(String(testId)),
    };
    wrapPageTimeGateClicks(page);
    await expect(page.getByTestId("inbox-approval-confirm").click()).rejects.toThrow(
      /CAPTURE ABORT: scene "chat" is clock:fixed; time-gated control \[inbox-approval-confirm\] cannot open CONFIRM_GUARD_MS/
    );
    expect(clicks).toEqual([]);
    setActiveCaptureScene("welcome-backstop");
    await page.getByTestId("inbox-approval-confirm").click();
    expect(clicks).toEqual(["inbox-approval-confirm"]);
    setActiveCaptureScene("default");
  });

  it("capture-screens wraps getByTestId clicks and marks welcome-backstop flowing", () => {
    const body = stripComments(CAPTURE_SRC);
    expect(body).toMatch(/wrapPageTimeGateClicks/);
    expect(body).toMatch(/setActiveCaptureScene\("welcome-backstop"\)/);
    expect(body).toMatch(/pinPageWallClock/);
  });
});

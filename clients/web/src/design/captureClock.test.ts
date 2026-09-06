import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { TIME_GATED_CONTROLS as PRODUCT_CONTROLS } from "@/features/timeline/ApprovalActions";

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLOCK_SRC = readFileSync(
  new URL("../../scripts/capture-clock.mjs", import.meta.url),
  "utf8"
);
const CAPTURE_SRC = readFileSync(
  new URL("../../scripts/capture-screens.mjs", import.meta.url),
  "utf8"
);
const APPROVAL_SRC = readFileSync(
  new URL("../features/timeline/ApprovalActions.tsx", import.meta.url),
  "utf8"
);

type ClockMod = {
  TIME_GATED_CONTROLS: string[];
  clockForScene: (sceneName: string) => "fixed" | "flowing";
  setActiveCaptureScene: (name: string) => void;
  activeCaptureScene: () => string;
  abortIfFixedClockClicksTimeGate: (sceneName: string, testId: string) => void;
  testIdFromSelector: (selector: unknown) => string;
  sceneClick: (
    page: unknown,
    locator: { click: (...args: unknown[]) => Promise<unknown> },
    options?: unknown
  ) => Promise<unknown>;
  wrapPageTimeGateClicks: (page: Record<string, unknown>) => Promise<unknown>;
  sceneNameFromShotPath: (path: unknown) => string;
};

function loadClock(): ClockMod {
  const rewritten = CLOCK_SRC.replace(/import [^\n]+\n/g, "")
    .replace(/const APPROVAL_PATH = [\s\S]*?;\n\n/, "")
    .replace(
      /export const TIME_GATED_CONTROLS = parseTimeGatedControls\(\s*readFileSync\(APPROVAL_PATH, "utf8"\)\s*\);/,
      `const TIME_GATED_CONTROLS = parseTimeGatedControls(${JSON.stringify(APPROVAL_SRC)});`
    )
    .replaceAll("export const", "const")
    .replaceAll("export async function", "async function")
    .replaceAll("export function", "function");
  return new Function(
    `${rewritten}
return {
  TIME_GATED_CONTROLS,
  clockForScene,
  setActiveCaptureScene,
  activeCaptureScene,
  abortIfFixedClockClicksTimeGate,
  testIdFromSelector,
  sceneClick,
  wrapPageTimeGateClicks,
  sceneNameFromShotPath,
};`
  )() as ClockMod;
}

const clock = loadClock();
const {
  TIME_GATED_CONTROLS,
  clockForScene,
  setActiveCaptureScene,
  activeCaptureScene,
  abortIfFixedClockClicksTimeGate,
  testIdFromSelector,
  sceneClick,
  wrapPageTimeGateClicks,
  sceneNameFromShotPath,
} = clock;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walkTsFiles(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walkTsFiles(path, into);
      continue;
    }
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
    if (name.endsWith(".d.ts")) continue;
    into.push(path);
  }
  return into;
}

function confirmTestIdsInGuardFile(source: string): string[] {
  const file = ts.createSourceFile(
    "file.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "data-testid") {
      const init = node.initializer;
      if (init && ts.isStringLiteral(init) && init.text.endsWith("-confirm")) {
        ids.push(init.text);
      }
      if (
        init &&
        ts.isJsxExpression(init) &&
        init.expression &&
        ts.isStringLiteral(init.expression) &&
        init.expression.text.endsWith("-confirm")
      ) {
        ids.push(init.expression.text);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "getByTestId" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.endsWith("-confirm")
    ) {
      ids.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return ids;
}

function fileUsesGuardMs(source: string, path: string): boolean {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let uses = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && /_GUARD_MS$/.test(node.text)) uses = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return uses;
}

function jsxAttrStringLiterals(
  source: string,
  component: string,
  attr: string
): string[] {
  const file = ts.createSourceFile(
    "file.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText() === component) {
        for (const property of node.attributes.properties) {
          if (!ts.isJsxAttribute(property)) continue;
          if (property.name.getText() !== attr) continue;
          const init = property.initializer;
          if (init && ts.isStringLiteral(init)) values.push(init.text);
          if (
            init &&
            ts.isJsxExpression(init) &&
            init.expression &&
            ts.isStringLiteral(init.expression)
          ) {
            values.push(init.expression.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

function makeLocator(selector: string) {
  const locator = {
    click: async () => {
      clicks.push(selector);
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
    locator() {
      return locator;
    },
    filter() {
      return locator;
    },
    and() {
      return locator;
    },
    or() {
      return locator;
    },
    getByTestId() {
      return locator;
    },
    getByRole() {
      return locator;
    },
    getByText() {
      return locator;
    },
    getByLabel() {
      return locator;
    },
    toString() {
      return `locator('${selector}')`;
    },
  };
  return locator;
}

const clicks: string[] = [];

describe("capture clock scene registry", () => {
  it("welcome-backstop is flowing; every other scene is fixed", () => {
    expect(clockForScene("welcome-backstop")).toBe("flowing");
    expect(clockForScene("approvals-confirm")).toBe("fixed");
    expect(clockForScene("chat")).toBe("fixed");
    expect(TIME_GATED_CONTROLS).toContain("inbox-approval-confirm");
    expect(TIME_GATED_CONTROLS).toEqual([...PRODUCT_CONTROLS]);
  });

  it("every *_GUARD_MS usage site in clients/web/src registers its control", () => {
    const files = walkTsFiles(WEB_SRC);
    const usageIds = new Set<string>();
    const prefixes = new Set<string>(["approval"]);
    for (const path of files) {
      const src = readFileSync(path, "utf8");
      if (src.includes("ApprovalActions")) {
        for (const prefix of jsxAttrStringLiterals(
          src,
          "ApprovalActions",
          "testIdPrefix"
        )) {
          prefixes.add(prefix);
        }
      }
      if (!fileUsesGuardMs(src, path)) continue;
      for (const id of confirmTestIdsInGuardFile(src)) {
        usageIds.add(id);
      }
    }
    for (const prefix of prefixes) {
      usageIds.add(`${prefix}-confirm`);
    }
    expect([...usageIds].sort()).toEqual([...PRODUCT_CONTROLS].sort());
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

  it("page.locator data-testid click aborts in a fixed-clock scene", async () => {
    setActiveCaptureScene("approvals-confirm");
    expect(testIdFromSelector("[data-testid=inbox-approval-confirm]")).toBe(
      "inbox-approval-confirm"
    );
    clicks.length = 0;
    const page = {
      getByTestId: (testId: string) => makeLocator(`[data-testid=${testId}]`),
      locator: (selector: string) => makeLocator(selector),
      getByRole: () => makeLocator("role"),
      getByText: () => makeLocator("text"),
      getByLabel: () => makeLocator("label"),
    };
    await wrapPageTimeGateClicks(page);
    await expect(
      (page.locator("[data-testid=inbox-approval-confirm]") as { click: () => Promise<unknown> }).click()
    ).rejects.toThrow(
      /CAPTURE ABORT: scene "approvals-confirm" is clock:fixed; time-gated control \[inbox-approval-confirm\] cannot open CONFIRM_GUARD_MS/
    );
    expect(clicks).toEqual([]);
    await expect(
      sceneClick(page, page.locator("[data-testid=inbox-approval-confirm]"))
    ).rejects.toThrow(
      /CAPTURE ABORT: scene "approvals-confirm" is clock:fixed; time-gated control \[inbox-approval-confirm\] cannot open CONFIRM_GUARD_MS/
    );
    setActiveCaptureScene("welcome-backstop");
    await (page.locator("[data-testid=inbox-approval-confirm]") as { click: () => Promise<unknown> }).click();
    expect(clicks).toEqual(["[data-testid=inbox-approval-confirm]"]);
    setActiveCaptureScene("default");
  });

  it("capture-screens routes clicks through sceneClick and names welcome-backstop flowing", () => {
    const body = stripComments(CAPTURE_SRC);
    expect(body).toMatch(/sceneClick/);
    expect(body).toMatch(/wrapPageTimeGateClicks/);
    expect(body).toMatch(/setActiveCaptureScene\("welcome-backstop"\)/);
    expect(body).toMatch(/setActiveCaptureScene\(sceneNameFromShotPath/);
    expect(body).toMatch(/pinPageWallClock/);
    expect(sceneNameFromShotPath("/tmp/approvals-confirm-light.png")).toBe(
      "approvals-confirm"
    );
    expect(sceneNameFromShotPath("/tmp/welcome-backstop-dark.png")).toBe(
      "welcome-backstop"
    );
  });

  it("capture-screens scene code has no raw click-equivalents", () => {
    const body = stripComments(CAPTURE_SRC);
    expect(body.match(/\.click\s*\(/g)).toBeNull();
    expect(body.match(/\.mouse\.down\s*\(/g)).toBeNull();
    expect(body.match(/\.mouse\.up\s*\(/g)).toBeNull();
    expect(body.match(/keyboard\.press\s*\(\s*["'](Enter| |Space)["']/g)).toBeNull();
    expect(body.match(/new MouseEvent/g)).toBeNull();
  });

  it("raw keyboard Enter on a focused time-gated control aborts in a fixed scene", async () => {
    setActiveCaptureScene("approvals-confirm");
    const presses: string[] = [];
    const page = {
      evaluate: async () => "inbox-approval-confirm",
      keyboard: {
        press: async (key: string) => {
          presses.push(key);
        },
      },
      getByTestId: (testId: string) => makeLocator(`[data-testid=${testId}]`),
      locator: (selector: string) => makeLocator(selector),
      getByRole: () => makeLocator("role"),
      getByText: () => makeLocator("text"),
      getByLabel: () => makeLocator("label"),
    };
    await wrapPageTimeGateClicks(page);
    await expect(
      (page.keyboard.press as (key: string) => Promise<unknown>)("Enter")
    ).rejects.toThrow(
      /CAPTURE ABORT: scene "approvals-confirm" is clock:fixed; time-gated control \[inbox-approval-confirm\] cannot open CONFIRM_GUARD_MS/
    );
    expect(presses).toEqual([]);
    setActiveCaptureScene("default");
  });
});

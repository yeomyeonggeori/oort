import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  TIME_GATED_CONTROLS as PRODUCT_CONTROLS,
  timeGatedTestId,
} from "@/features/timeline/ApprovalActions";

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
  clockForScene: (sceneName?: string) => "fixed" | "flowing";
  setActiveCaptureScene: (name: string) => void;
  beginCaptureScene: (name: string) => "fixed" | "flowing";
  activeCaptureScene: () => string;
  abortIfFixedClockClicksTimeGate: (sceneName: string, testId: string) => void;
  testIdFromSelector: (selector: unknown) => string;
  sceneClick: (
    page: unknown,
    locator: { click: (...args: unknown[]) => Promise<unknown> },
    options?: unknown
  ) => Promise<unknown>;
  sceneDispatchMouseEvent: (
    page: unknown,
    locator: unknown,
    type: string,
    init?: unknown
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
  beginCaptureScene,
  activeCaptureScene,
  abortIfFixedClockClicksTimeGate,
  testIdFromSelector,
  sceneClick,
  sceneDispatchMouseEvent,
  wrapPageTimeGateClicks,
  sceneNameFromShotPath,
};`
  )() as ClockMod;
}

const clock = loadClock();
const {
  TIME_GATED_CONTROLS,
  clockForScene,
  beginCaptureScene,
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

const EVENT_ATTRS = new Set([
  "onClick",
  "onKeyDown",
  "onKeyUp",
  "onPointerDown",
  "onPointerUp",
  "onMouseDown",
  "onMouseUp",
  "onSubmit",
]);

function nodeUsesGuardMs(node: ts.Node): boolean {
  let uses = false;
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && /_GUARD_MS$/.test(child.text)) uses = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return uses;
}

function collectGatedFunctionNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    if (isFn && nodeUsesGuardMs(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        names.add(parent.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

function handlerIsGated(
  expr: ts.Expression | undefined,
  gatedFns: Set<string>
): boolean {
  if (!expr) return false;
  let gated = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && /_GUARD_MS$/.test(node.text)) gated = true;
    if (ts.isIdentifier(node) && gatedFns.has(node.text)) gated = true;
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return gated;
}

function testIdFromJsxAttr(init: ts.JsxAttribute["initializer"]): string | null {
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const expr = init.expression;
    if (ts.isStringLiteral(expr)) return expr.text;
    if (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "timeGatedTestId" &&
      expr.arguments[0] &&
      ts.isStringLiteral(expr.arguments[0])
    ) {
      return timeGatedTestId(expr.arguments[0].text);
    }
  }
  return null;
}

function gatedInteractiveTestIds(source: string): string[] {
  const file = ts.createSourceFile(
    "file.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const gatedFns = collectGatedFunctionNames(file);
  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      let gated = false;
      let testId: string | null = null;
      for (const property of node.attributes.properties) {
        if (!ts.isJsxAttribute(property)) continue;
        const name = property.name.getText();
        if (EVENT_ATTRS.has(name)) {
          const init = property.initializer;
          if (
            init &&
            ts.isJsxExpression(init) &&
            handlerIsGated(init.expression ?? undefined, gatedFns)
          ) {
            gated = true;
          }
        }
        if (name === "data-testid") {
          testId = testIdFromJsxAttr(property.initializer);
        }
      }
      if (gated && testId) ids.push(testId);
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
  return nodeUsesGuardMs(file);
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

const COMMIT_ABORT =
  /CAPTURE ABORT: scene "approvals-confirm" is clock:fixed; time-gated control \[agent-permission-commit\] cannot open CONFIRM_GUARD_MS/;

describe("capture clock scene registry", () => {
  it("welcome-backstop is flowing; every other scene is fixed", () => {
    expect(clockForScene("welcome-backstop")).toBe("flowing");
    expect(clockForScene("approvals-confirm")).toBe("fixed");
    expect(clockForScene("chat")).toBe("fixed");
    expect(TIME_GATED_CONTROLS).toContain(timeGatedTestId("agent-permission"));
    expect(TIME_GATED_CONTROLS).toEqual([...PRODUCT_CONTROLS]);
  });

  it("every *_GUARD_MS usage site in clients/web/src registers its control", () => {
    const files = walkTsFiles(WEB_SRC);
    const usageIds = new Set<string>();
    for (const path of files) {
      const src = readFileSync(path, "utf8");
      if (!fileUsesGuardMs(src, path)) continue;
      for (const id of gatedInteractiveTestIds(src)) {
        usageIds.add(id);
      }
    }
    // #3819: ApprovalActions 호출자는 더는 시간 게이트가 걸린 컨트롤을 세우지 않으므로
    // 호출자 접두사를 레지스트리에 요구하지 않는다. 남은 사용처(작업 세션 권한 카드)는
    // `*_GUARD_MS` 를 읽는 파일에서 곧바로 찾는다.
    expect([...usageIds].sort()).toEqual([...PRODUCT_CONTROLS].sort());
  });

  it("fixed-clock scene clicking agent-permission-commit aborts naming CONFIRM_GUARD_MS", () => {
    beginCaptureScene("approvals-confirm");
    expect(activeCaptureScene()).toBe("approvals-confirm");
    expect(clockForScene()).toBe("fixed");
    expect(() =>
      abortIfFixedClockClicksTimeGate(
        "approvals-confirm",
        timeGatedTestId("agent-permission")
      )
    ).toThrow(COMMIT_ABORT);
  });

  it("welcome-backstop is flowing so the same click is allowed", () => {
    expect(() =>
      abortIfFixedClockClicksTimeGate(
        "welcome-backstop",
        timeGatedTestId("agent-permission")
      )
    ).not.toThrow();
  });

  it("page.locator data-testid click aborts in a fixed-clock scene", async () => {
    beginCaptureScene("approvals-confirm");
    expect(testIdFromSelector("[data-testid=agent-permission-commit]")).toBe(
      "agent-permission-commit"
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
      (
        page.locator("[data-testid=agent-permission-commit]") as {
          click: () => Promise<unknown>;
        }
      ).click()
    ).rejects.toThrow(COMMIT_ABORT);
    expect(clicks).toEqual([]);
    await expect(
      sceneClick(page, page.locator("[data-testid=agent-permission-commit]"))
    ).rejects.toThrow(COMMIT_ABORT);
    beginCaptureScene("welcome-backstop");
    await (
      page.locator("[data-testid=agent-permission-commit]") as {
        click: () => Promise<unknown>;
      }
    ).click();
    expect(clicks).toEqual(["[data-testid=agent-permission-commit]"]);
  });

  it("capture-screens routes clicks through sceneClick and names welcome-backstop flowing", () => {
    const body = stripComments(CAPTURE_SRC);
    expect(body).toMatch(/sceneClick/);
    expect(body).toMatch(/wrapPageTimeGateClicks/);
    expect(body).toMatch(/beginScene\("welcome-backstop"\)/);
    expect(body).toMatch(/beginScene\("approvals-confirm"\)/);
    expect(body).toMatch(/beginCaptureScene/);
    expect(body).toMatch(/pinPageWallClock/);
    expect(sceneNameFromShotPath("/tmp/approvals-confirm-light.png")).toBe(
      "approvals-confirm"
    );
    expect(sceneNameFromShotPath("/tmp/welcome-backstop-dark.png")).toBe(
      "welcome-backstop"
    );
  });

  it("sets the active scene at scene start, not inside page.screenshot", () => {
    const wrapMatch = CAPTURE_SRC.match(
      /function wrapPageShotGuard\([\s\S]*?\nfunction /
    );
    expect(wrapMatch?.[0] ?? "").not.toMatch(/setActiveCaptureScene|beginCaptureScene|beginScene/);
    expect(CAPTURE_SRC).toMatch(/beginScene\("approvals-confirm"\)/);
    beginCaptureScene("approvals-confirm");
    expect(activeCaptureScene()).toBe("approvals-confirm");
    expect(clockForScene()).toBe("fixed");
  });

  it("capture-screens scene code has no raw click-equivalents", () => {
    const body = stripComments(CAPTURE_SRC);
    expect(body.match(/\.click\s*\(/g)).toBeNull();
    expect(body.match(/\.mouse\.down\s*\(/g)).toBeNull();
    expect(body.match(/\.mouse\.up\s*\(/g)).toBeNull();
    expect(body.match(/keyboard\.press\s*\(\s*["'](Enter| |Space)["']/g)).toBeNull();
    expect(body.match(/new MouseEvent/g)).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("./useTimeline.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("./ThreadPanel.tsx", import.meta.url), "utf8");
const shell = readFileSync(
  new URL("../chat/ChatShell.tsx", import.meta.url),
  "utf8"
);

function jsxTagName(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement
): string {
  return node.tagName.getText();
}

function expressionReaches(expr: ts.Expression, valueIncludes: string): boolean {
  if (ts.isParenthesizedExpression(expr)) {
    return expressionReaches(expr.expression, valueIncludes);
  }
  if (ts.isConditionalExpression(expr)) {
    const cond = expr.condition;
    if (cond.kind === ts.SyntaxKind.FalseKeyword) {
      return expressionReaches(expr.whenFalse, valueIncludes);
    }
    if (cond.kind === ts.SyntaxKind.TrueKeyword) {
      return expressionReaches(expr.whenTrue, valueIncludes);
    }
    return (
      expressionReaches(expr.whenTrue, valueIncludes) ||
      expressionReaches(expr.whenFalse, valueIncludes)
    );
  }
  return expr.getText().includes(valueIncludes);
}

function initializerReaches(
  init: ts.JsxAttribute["initializer"],
  valueIncludes: string
): boolean {
  if (!init) return false;
  if (ts.isJsxExpression(init) && init.expression) {
    return expressionReaches(init.expression, valueIncludes);
  }
  return init.getText().includes(valueIncludes);
}

/** Live JSX attribute bindings. Comments, string occurrences, and
 *  constant-false `cond ? fn : undefined` branches do not count. */
function jsxBindingCount(
  source: string,
  component: string,
  attr: string,
  valueIncludes: string
): number {
  const file = ts.createSourceFile(
    "ChatShell.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (jsxTagName(node) === component) {
        for (const property of node.attributes.properties) {
          if (!ts.isJsxAttribute(property)) continue;
          if (property.name.getText() !== attr) continue;
          if (initializerReaches(property.initializer, valueIncludes)) count += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

function identifierCallCount(source: string, name: string): number {
  const file = ts.createSourceFile(
    "useTimeline.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

describe("arrival wiring — mutations of the seam go red", () => {
  it("Timeline 은 isPlayEntrance(id) 만 넘기고 true 로 고정하지 않는다", () => {
    expect(timeline).toContain(
      "playEntrance={isPlayEntrance?.(item.message.id) ?? false}"
    );
    expect(timeline).not.toMatch(/playEntrance=\{true\}/);
  });

  it("Timeline 은 onEntranceConsumed 를 행 id 에 묶는다", () => {
    expect(timeline).toContain("onEntranceConsumed={");
    expect(timeline).toContain("onEntranceConsumed(item.message.id)");
  });

  it("ChatShell holds Timeline isPlayEntrance through the welcome stage; ThreadPanel keeps the unwrapped store fn", () => {
    expect(shell).toContain("const pinArrivalGrant = timeline.pinArrivalGrant");
    expect(shell).toContain("pinArrivalGrant(welcome.holdEntranceId)");
    expect(jsxBindingCount(shell, "Timeline", "isPlayEntrance", "isPlayEntrance")).toBe(
      1
    );
    expect(
      jsxBindingCount(shell, "ThreadPanel", "isPlayEntrance", "timeline.isPlayEntrance")
    ).toBe(1);
    expect(
      jsxBindingCount(
        shell,
        "Timeline",
        "onEntranceConsumed",
        "timeline.consumeEntrance"
      )
    ).toBe(1);
    expect(
      jsxBindingCount(
        shell,
        "ThreadPanel",
        "onEntranceConsumed",
        "timeline.consumeEntrance"
      )
    ).toBe(1);
    expect(
      jsxBindingCount(
        shell,
        "Timeline",
        "capUnmountedArrivals",
        "timeline.capUnmountedArrivals"
      )
    ).toBe(1);
    expect(
      jsxBindingCount(
        shell,
        "ThreadPanel",
        "capUnmountedArrivals",
        "timeline.capUnmountedArrivals"
      )
    ).toBe(0);
  });

  it("constant-false ternary 결속은 죽은 분기로 센다", () => {
    const dead = `<Timeline onEntranceConsumed={false ? timeline.consumeEntrance : undefined} isPlayEntrance={false ? timeline.isPlayEntrance : undefined} />`;
    expect(
      jsxBindingCount(dead, "Timeline", "onEntranceConsumed", "timeline.consumeEntrance")
    ).toBe(0);
    expect(
      jsxBindingCount(dead, "Timeline", "isPlayEntrance", "timeline.isPlayEntrance")
    ).toBe(0);
    const live = `<Timeline onEntranceConsumed={timeline.consumeEntrance} />`;
    expect(
      jsxBindingCount(live, "Timeline", "onEntranceConsumed", "timeline.consumeEntrance")
    ).toBe(1);
  });

  it("ThreadPanel 은 루트와 답글에 playEntrance 를 잇는다", () => {
    expect(panel).toContain("playEntrance={isPlayEntrance?.(root.id) ?? false}");
    expect(panel).toContain("playEntrance={isPlayEntrance?.(reply.id) ?? false}");
  });

  it("useTimeline REST 기본 meta 는 rest/rest 이고 리플레이는 live 로 안 바꾼다", () => {
    expect(identifierCallCount(hook, "capArrivalSetKeeping")).toBe(3);
  });

  it("Timeline leftover sweep 는 배치 전 at-bottom 을 쓴다", () => {
    expect(timeline).toContain("atBottomBeforeBatch");
    expect(timeline).toContain("pendingBottomBatchRef");
    expect(timeline).toContain("capUnmountedArrivals?.()");
  });
});

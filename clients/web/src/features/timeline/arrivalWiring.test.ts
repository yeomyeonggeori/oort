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

/** Live JSX attribute bindings. Comments and string occurrences do not count. */
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
          const init = property.initializer;
          if (init && init.getText().includes(valueIncludes)) count += 1;
        }
      }
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

  it("ChatShell 은 Timeline 과 ThreadPanel 에 같은 두 props 를 각각 잇는다", () => {
    expect(
      jsxBindingCount(shell, "Timeline", "isPlayEntrance", "timeline.isPlayEntrance")
    ).toBe(1);
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

  it("ThreadPanel 은 루트와 답글에 playEntrance 를 잇는다", () => {
    expect(panel).toContain("playEntrance={isPlayEntrance?.(root.id) ?? false}");
    expect(panel).toContain("playEntrance={isPlayEntrance?.(reply.id) ?? false}");
  });

  it("useTimeline REST 기본 meta 는 rest/rest 이고 리플레이는 live 로 안 바꾼다", () => {
    expect(hook).toContain(
      '} = { provenance: "rest", eventType: "rest" }'
    );
    expect(hook).toContain(
      'provenance: replayGate.isReplaying() ? "replay" : "live",'
    );
    expect(hook).toContain(
      "alreadyHeld: heldIdsRef.current.has(key),"
    );
    expect(hook).toContain("const reducedMotion = prefersReducedMotion();");
    expect(hook).toContain(
      "if (play === 1) playOnMountRef.current.add(key);"
    );
    expect(hook).toContain("playOnMountRef.current = new Set();");
    expect(hook).toContain(
      "capArrivalSet(playOnMountRef.current, MAX_PENDING_ARRIVAL_GRANTS);"
    );
    expect(hook).not.toMatch(
      /capArrivalSet\(playOnMountRef\.current, MAX_PENDING_ARRIVAL_GRANTS\);\s*\}, \[state\.messages\]/
    );
  });

  it("Timeline 은 바닥이 아닐 때만 leftover grant 를 쓸어 낸다", () => {
    expect(timeline).toContain("if (atBottom) return;");
    expect(timeline).toContain("capUnmountedArrivals?.()");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("./useTimeline.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("./ThreadPanel.tsx", import.meta.url), "utf8");
const shell = readFileSync(
  new URL("../chat/ChatShell.tsx", import.meta.url),
  "utf8"
);

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
    const grants = shell.split("isPlayEntrance={timeline.isPlayEntrance}");
    expect(grants.length - 1).toBe(2);
    const consumed = shell.split(
      "onEntranceConsumed={timeline.consumeEntrance}"
    );
    expect(consumed.length - 1).toBe(2);
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
  });
});

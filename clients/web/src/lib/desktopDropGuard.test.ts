import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installDesktopDropGuard } from "./desktopDropGuard";

// 노드의 EventTarget은 버블 트리가 없다. 한 대상에 등록 순서로 리스너를 건다:
// 먼저 건 「드롭 영역」이 문서 안쪽의 핸들러, 나중에 건 가드가 window 끝이다.

function dragEvent(type: "dragover" | "drop", dropEffect = "copy") {
  const event = new Event(type, { cancelable: true });
  const dataTransfer = { types: ["Files"], dropEffect };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return { event, dataTransfer };
}

describe("installDesktopDropGuard (#2671)", () => {
  it("받는 곳 없는 dragover는 「놓을 수 없음」으로 답하고 기본 동작을 막는다", () => {
    const target = new EventTarget();
    installDesktopDropGuard(target);
    const { event, dataTransfer } = dragEvent("dragover");
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");
  });

  it("받는 곳 없는 drop은 기본 동작(창이 그 파일로 이동)을 막는다", () => {
    const target = new EventTarget();
    installDesktopDropGuard(target);
    const { event } = dragEvent("drop");
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("드롭 영역이 먼저 가져간 끌기는 건드리지 않는다", () => {
    const target = new EventTarget();
    // 컴포저 드롭 영역처럼: 파일이면 preventDefault하고 copy로 답한다.
    target.addEventListener("dragover", (event) => {
      event.preventDefault();
      (event as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect =
        "copy";
    });
    installDesktopDropGuard(target);
    const { event, dataTransfer } = dragEvent("dragover", "move");
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("copy");
  });

  it("해제하면 더는 막지 않는다", () => {
    const target = new EventTarget();
    const uninstall = installDesktopDropGuard(target);
    uninstall();
    const { event, dataTransfer } = dragEvent("dragover");
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
  });

  it("main.tsx가 데스크탑 셸에서만 설치한다", () => {
    const main = readFileSync(fileURLToPath(new URL("../main.tsx", import.meta.url)), "utf8");
    expect(main).toContain("if (IS_TAURI) installDesktopDropGuard(window);");
  });
});

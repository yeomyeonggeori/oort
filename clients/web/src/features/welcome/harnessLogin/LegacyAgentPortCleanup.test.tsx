// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #3567: 앱 시작에 한 번, 데스크탑에서만 셸의 정리 명령을 부른다. 웹 탭은 셸이 없어 부르지 않는다.

const shell = vi.hoisted(() => ({
  desktop: true,
  retire: vi.fn(async () => ({ outcome: "cleaned" as const, removedMcp: true })),
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => shell.desktop,
  agentPortRetireLegacy: shell.retire,
}));

import { LegacyAgentPortCleanup } from "./LegacyAgentPortCleanup";

describe("LegacyAgentPortCleanup (#3567)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    shell.retire.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("asks the shell once on the desktop and draws nothing", async () => {
    shell.desktop = true;
    await act(async () => root.render(<LegacyAgentPortCleanup />));
    expect(shell.retire).toHaveBeenCalledTimes(1);
    expect(host.innerHTML).toBe("");
  });

  it("never calls the shell from a browser tab", async () => {
    shell.desktop = false;
    await act(async () => root.render(<LegacyAgentPortCleanup />));
    expect(shell.retire).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GitReadResult } from "@momo/core/features/workbench/gitRead";
import { usePaneGit } from "./usePaneGit";

// hook이 언마운트되면 큐를 멈춘다: 끝나지 않은 명령이 나중에 돌아와도 다음 명령을
// 쏘지 않고 setState도 없다(검수 #2951 H1·M6).

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("usePaneGit", () => {
  it("언마운트 뒤 돌아온 답은 다음 명령도 상태 갱신도 만들지 않는다", async () => {
    const pending: Array<(r: GitReadResult) => void> = [];
    const calls: string[] = [];
    const read = (command: string, pty: number) => {
      calls.push(`${command}:${pty}`);
      return new Promise<GitReadResult>((resolve) => pending.push(resolve));
    };
    const renders = vi.fn();
    function Probe() {
      const facts = usePaneGit([["p1", 1], ["p2", 2], ["p3", 3]], { read });
      renders(facts.size);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    expect(calls).toEqual(["g1:1", "g1:2"]);
    const before = renders.mock.calls.length;
    act(() => root.unmount());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      for (const resolve of pending.splice(0)) resolve({ outcome: "ok", value: { kind: "repo", name: "momo" } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls).toEqual(["g1:1", "g1:2"]);
    expect(renders.mock.calls.length).toBe(before);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

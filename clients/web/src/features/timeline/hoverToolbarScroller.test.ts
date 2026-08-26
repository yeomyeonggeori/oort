// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { closestToolbarScrollContainer } from "./hoverToolbarModel";

describe("closestToolbarScrollContainer", () => {
  it("스레드 자체 스크롤러를 바깥 타임라인보다 먼저 고른다", () => {
    const timeline = document.createElement("div");
    timeline.setAttribute("data-virtuoso-scroller", "");
    const thread = document.createElement("div");
    thread.setAttribute("data-message-scroll-container", "");
    const toolbar = document.createElement("div");
    thread.append(toolbar);
    timeline.append(thread);

    expect(closestToolbarScrollContainer(toolbar)).toBe(thread);
  });

  it("표식이 없어도 가장 가까운 세로 overflow 경계를 찾는다", () => {
    const outer = document.createElement("div");
    outer.setAttribute("data-virtuoso-scroller", "");
    const inner = document.createElement("div");
    const toolbar = document.createElement("div");
    inner.append(toolbar);
    outer.append(inner);

    const computedStyle = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) =>
        ({ overflowY: element === inner ? "auto" : "visible" }) as CSSStyleDeclaration
      );

    expect(closestToolbarScrollContainer(toolbar)).toBe(inner);
    computedStyle.mockRestore();
  });
});

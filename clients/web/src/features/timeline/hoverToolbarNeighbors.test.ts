// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { neighborTextRects, toolbarNeighbors } from "./hoverToolbarModel";

describe("이웃 글자 재기 (#5179)", () => {
  it("앞·뒤 한 칸은 같은 목록 안에서 문서 순서로 센다(행과 시스템 줄)", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div><article data-testid="timeline-message" id="a"></article></div>' +
      '<div data-testid="system-line" id="b"></div>' +
      '<div><article data-testid="timeline-message" id="c"></article></div>';
    const row = root.querySelector("#c") as Element;
    expect(toolbarNeighbors(row, root).prev?.id).toBe("b");
    expect(toolbarNeighbors(row, root).next).toBeNull();
    expect(toolbarNeighbors(root.querySelector("#a") as Element, root).next?.id).toBe("b");
    expect(toolbarNeighbors(document.createElement("article"), root)).toEqual({ prev: null, next: null });
  });

  it("행은 머리 줄·본문이 든 data-row-body 의 글 노드 줄 조각을, 시스템 줄은 줄 자신의 글을 잰다", () => {
    const row = document.createElement("article");
    row.setAttribute("data-testid", "timeline-message");
    row.innerHTML =
      '<span>거터 시각</span><div data-row-body><div><span>이름</span><time>오후 3:00</time></div><p>본문입니다</p></div>';
    const line = document.createElement("div");
    line.setAttribute("data-testid", "system-line");
    line.innerHTML = "<p>줄입니다</p>";
    const original = Range.prototype.getClientRects;
    // 글 노드마다 한 조각(여러 줄이면 줄마다 한 조각)을 돌려주는 엔진을 흉내 낸다. 거터 시각은 data-row-body 밖이라 안 나와야 한다.
    Range.prototype.getClientRects = function fake(this: Range) {
      const text = this.toString();
      const rect = { left: 10, right: 10 + text.length * 10, top: 0, bottom: 18, width: text.length * 10, height: 18 };
      return [rect] as unknown as DOMRectList;
    };
    try {
      expect(neighborTextRects(row).map((r) => r.right - r.left)).toEqual([20, 70, 50]);
      expect(neighborTextRects(line).map((r) => r.right - r.left)).toEqual([40]);
      expect(neighborTextRects(null)).toEqual([]);
    } finally {
      Range.prototype.getClientRects = original;
    }
  });

  it("레이아웃을 못 재는 환경(Range.getClientRects 가 없는 jsdom)에서는 빈 목록이다", () => {
    const line = document.createElement("div");
    line.setAttribute("data-testid", "system-line");
    line.innerHTML = "<p>줄입니다</p>";
    expect(typeof Range.prototype.getClientRects).not.toBe("function");
    expect(neighborTextRects(line)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  emptyExpressionFavorites,
  isExpressionFavorite,
  MAX_EXPRESSION_FAVORITES,
  restoreExpressionFavorites,
  toggleExpressionFavorite,
} from "./favorites";

// 즐겨찾기 (owner 2026-11-07, #5453): 이 기기 · 이 워크스페이스 · 이 사람 기준의 로컬 목록. 서버 계약은 없다 - 값의 모양과 바꾸는 법만 잰다.

const empty = emptyExpressionFavorites("ws-1", "me-1");

describe("toggleExpressionFavorite — 없으면 끝에 더하고 있으면 뺀다", () => {
  it("고른 차례로 쌓이고, 다시 누르면 그것만 빠진다", () => {
    const one = toggleExpressionFavorite(empty, "a");
    const two = toggleExpressionFavorite(one, "b");
    expect(two.ids).toEqual(["a", "b"]);
    expect(isExpressionFavorite(two, "a")).toBe(true);
    const back = toggleExpressionFavorite(two, "a");
    expect(back.ids).toEqual(["b"]);
    expect(isExpressionFavorite(back, "a")).toBe(false);
    // 원본은 바뀌지 않는다(저장소에 쓰기 전 값이 흔들리지 않는다).
    expect(two.ids).toEqual(["a", "b"]);
    expect(empty.ids).toEqual([]);
  });
  it("빈 id는 건드리지 않고, 한도를 넘으면 가장 먼저 고른 것부터 밀려난다", () => {
    expect(toggleExpressionFavorite(empty, "")).toBe(empty);
    let full = empty;
    for (let i = 0; i < MAX_EXPRESSION_FAVORITES + 3; i += 1) full = toggleExpressionFavorite(full, `id-${i}`);
    expect(full.ids).toHaveLength(MAX_EXPRESSION_FAVORITES);
    expect(full.ids[0]).toBe("id-3");
    expect(full.ids.at(-1)).toBe(`id-${MAX_EXPRESSION_FAVORITES + 2}`);
  });
});

describe("restoreExpressionFavorites — 저장소의 값은 믿지 않는다", () => {
  const saved = { v: 1, workspaceId: "ws-1", memberId: "me-1", ids: ["a", "b"] };
  it("같은 워크스페이스·같은 사람의 값만 돌아온다", () => {
    expect(restoreExpressionFavorites(saved, "ws-1", "me-1").ids).toEqual(["a", "b"]);
    // 다른 사람·다른 워크스페이스의 값은 같은 기기에서도 보이지 않는다.
    expect(restoreExpressionFavorites(saved, "ws-1", "me-2").ids).toEqual([]);
    expect(restoreExpressionFavorites(saved, "ws-2", "me-1").ids).toEqual([]);
  });
  it("깨진 값은 빈 목록이고, 같은 id와 문자열이 아닌 것은 거른다", () => {
    for (const bad of [null, undefined, 1, "x", [], { v: 2, workspaceId: "ws-1", memberId: "me-1", ids: ["a"] }, { ...saved, ids: "a" }]) {
      expect(restoreExpressionFavorites(bad, "ws-1", "me-1").ids).toEqual([]);
    }
    expect(restoreExpressionFavorites({ ...saved, ids: ["a", "a", "", 3, null, "b"] }, "ws-1", "me-1").ids).toEqual(["a", "b"]);
  });
  it("한도보다 긴 저장값은 나중에 고른 쪽을 남긴다", () => {
    const ids = Array.from({ length: MAX_EXPRESSION_FAVORITES + 5 }, (_, i) => `id-${i}`);
    const restored = restoreExpressionFavorites({ ...saved, ids }, "ws-1", "me-1");
    expect(restored.ids).toHaveLength(MAX_EXPRESSION_FAVORITES);
    expect(restored.ids[0]).toBe("id-5");
  });
});

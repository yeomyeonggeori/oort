import { describe, expect, it } from "vitest";
import { nextRovingIndex } from "./rowFocus";

// 행 하나가 키보드에 얼마를 청구하는가를 정하는 산수. 위아래는 타임라인의
// 스크롤이므로 이 함수는 좌우만 안다.
describe("nextRovingIndex", () => {
  it("→는 다음으로 가고 끝에서 처음으로 돈다", () => {
    expect(nextRovingIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextRovingIndex(2, 3, "ArrowRight")).toBe(0);
  });

  it("←는 이전으로 가고 처음에서 끝으로 돈다", () => {
    expect(nextRovingIndex(2, 3, "ArrowLeft")).toBe(1);
    expect(nextRovingIndex(0, 3, "ArrowLeft")).toBe(2);
  });

  it("위아래는 이 그룹의 키가 아니다: 타임라인이 스크롤해야 한다", () => {
    expect(nextRovingIndex(0, 3, "ArrowDown")).toBeNull();
    expect(nextRovingIndex(0, 3, "ArrowUp")).toBeNull();
  });

  it("Home·End도 넘긴다: 스크롤 컨테이너의 처음과 끝이 먼저다", () => {
    expect(nextRovingIndex(1, 3, "Home")).toBeNull();
    expect(nextRovingIndex(1, 3, "End")).toBeNull();
  });

  it("Enter·Tab·문자는 그대로 통과시킨다", () => {
    for (const key of ["Enter", " ", "Tab", "a", "Escape"]) {
      expect(nextRovingIndex(0, 2, key)).toBeNull();
    }
  });

  it("컨트롤이 하나뿐인 행에서는 제자리다", () => {
    expect(nextRovingIndex(0, 1, "ArrowRight")).toBe(0);
    expect(nextRovingIndex(0, 1, "ArrowLeft")).toBe(0);
  });

  it("빈 그룹은 아무 데도 가지 않는다", () => {
    expect(nextRovingIndex(0, 0, "ArrowRight")).toBeNull();
  });
});

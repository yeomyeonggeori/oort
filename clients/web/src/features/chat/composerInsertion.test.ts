import { describe, expect, it } from "vitest";
import {
  insertAtComposerSelection,
  insertMentionTriggerAtComposerSelection,
} from "./composerInsertion";

describe("컴포저 캐럿 삽입 (#1688)", () => {
  it("surrogate pair 이모지 뒤로 UTF-16 캐럿을 옮긴다", () => {
    expect(
      insertAtComposerSelection("앞뒤", { start: 1, end: 1 }, "🎉")
    ).toEqual({ value: "앞🎉뒤", caret: 3 });
  });

  it("선택한 문자열을 바꾸고 삽입 끝에 둔다", () => {
    expect(
      insertAtComposerSelection("배포 보류", { start: 3, end: 5 }, "✅")
    ).toEqual({ value: "배포 ✅", caret: 4 });
  });

  it("역전되거나 범위를 벗어난 선택을 본문 안으로 가둔다", () => {
    expect(
      insertAtComposerSelection("확인", { start: 20, end: 1 }, "👀")
    ).toEqual({ value: "확👀", caret: 3 });
  });

  it("[@]는 현재 선택을 @로 바꾸고 자동완성이 읽을 캐럿을 돌려준다 (#1749)", () => {
    expect(
      insertMentionTriggerAtComposerSelection("배포 담당자", {
        start: 3,
        end: 6,
      })
    ).toEqual({ value: "배포 @", caret: 4 });
  });
});

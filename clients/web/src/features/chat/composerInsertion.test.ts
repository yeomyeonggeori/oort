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

  it("[@]는 선택을 지우지 않고 선택 끝에서 멘션을 시작한다 (#1749)", () => {
    expect(
      insertMentionTriggerAtComposerSelection("배포 담당자", {
        start: 3,
        end: 6,
      })
    ).toEqual({ value: "배포 담당자 @", caret: 8 });
  });

  it.each([
    ["문장 끝", "배포 로그 확인해주세요", 12, "배포 로그 확인해주세요 @", 14],
    ["한글 단어 뒤", "안녕하세요", 5, "안녕하세요 @", 7],
    ["영문 단어 뒤", "deploy", 6, "deploy @", 8],
    ["문장부호 뒤", "확인,", 3, "확인, @", 5],
    ["[@] 연타", "@", 1, "@ @", 3],
    ["공백 뒤", "배포 확인", 3, "배포 @확인", 4],
    ["줄 시작", "확인", 0, "@확인", 1],
  ])("[@]는 %s 캐럿에서 멘션 경계를 만든다", (_name, value, caret, next, nextCaret) => {
    expect(
      insertMentionTriggerAtComposerSelection(value, {
        start: caret,
        end: caret,
      })
    ).toEqual({ value: next, caret: nextCaret });
  });
});

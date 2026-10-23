import { describe, expect, it } from "vitest";
import { AVATAR_EDITOR_COPY } from "./avatarEditor";
import { AVATAR_ENTRY_COPY } from "./avatarEditorCopy";

// 아바타 편집기의 말 (#4261): 웹 대화상자와 폰이 같은 문장을 읽는다. 문체는 해요체이고 대시·사과가 없다.

const sentences = (table: Record<string, unknown>): string[] =>
  Object.values(table).flatMap((value) =>
    typeof value === "string" ? [value] : value && typeof value === "object" ? sentences(value as Record<string, unknown>) : []
  );

describe("아바타 편집기 문구", () => {
  const all = [...sentences(AVATAR_ENTRY_COPY), ...sentences(AVATAR_EDITOR_COPY)];

  it("비어 있는 말이 없고 대시(—, –)가 없다", () => {
    expect(all.length).toBeGreaterThan(30);
    for (const text of all) {
      expect(text.trim(), text).not.toBe("");
      expect(text, text).not.toMatch(/[—–]/);
    }
  });

  it("설명·오류 문장은 해요체이고 사과하지 않는다", () => {
    const prose = all.filter((text) => text.length > 14 && /[가-힣]/.test(text));
    for (const text of prose) {
      expect(text, text).toMatch(/(요|세요|어요|해요)\.$/);
      expect(text, text).not.toMatch(/죄송|습니다|합니다/);
    }
  });

  it("진행 낱말은 「명사 + 중」 꼴이거나 고유어 어간이다", () => {
    expect(AVATAR_EDITOR_COPY.saving).toBe("올리는 중");
    expect(AVATAR_EDITOR_COPY.resetBusy).toBe("되돌리는 중");
    expect(AVATAR_ENTRY_COPY.opening).toBe("여는 중");
    for (const text of all) expect(text, text).not.toMatch(/[가-힣]하는 중/);
  });

  it("실패 문장은 다음 행동을 말한다", () => {
    for (const key of [
      "emojiLowContrast",
      "presetLowContrast",
      "emojiBlank",
      "drawFailed",
      "resetFailed",
      "photoReadFailed",
      "uploadFailed",
      "uploadTooOften",
      "photoUnusable",
    ] as const) {
      expect(AVATAR_EDITOR_COPY[key], key).toMatch(/골라 주세요|다시 시도|확인하고|확인해 주세요/);
    }
    expect(AVATAR_ENTRY_COPY.loadFailed).toMatch(/다시 시도/);
  });

  it("그려 올리는 이모지·코메토 오류는 「프로필 사진」·한도 숫자로 말하지 않는다 (사진 문장과 분리)", () => {
    for (const key of ["uploadFailed", "uploadTooOften", "drawFailed"] as const) {
      expect(AVATAR_EDITOR_COPY[key], key).not.toMatch(/프로필 사진|5MB|4096px/);
    }
    expect(AVATAR_EDITOR_COPY.photoUnusable).toMatch(/4096px/);
  });

  it("안내 문장은 사진만 말하지 않고 서로 같은 문장을 되풀이하지 않는다", () => {
    expect(AVATAR_EDITOR_COPY.description).not.toMatch(/사진이 없으면/);
    expect(AVATAR_ENTRY_COPY.hint).not.toMatch(/사진이 없으면/);
    expect(AVATAR_ENTRY_COPY.hint).not.toContain(AVATAR_EDITOR_COPY.description);
    expect(AVATAR_EDITOR_COPY.description).not.toContain(AVATAR_ENTRY_COPY.hint);
  });

  it("이모지 패널(컴포저와 공용)에 넘기는 문장은 해요체이고 합쇼체가 없다", () => {
    const panel = sentences(AVATAR_EDITOR_COPY.emojiPanel);
    expect(panel.length).toBe(5);
    for (const text of panel) {
      expect(text, text).not.toMatch(/습니다|하세요|여세요/);
    }
    expect(AVATAR_EDITOR_COPY.emojiPanel.error).toMatch(/요\.$/);
    expect(AVATAR_EDITOR_COPY.emojiPanel.offline).toMatch(/요\.$/);
  });

  it("열기 자리의 말과 편집기 본체의 말은 같은 사실을 같은 낱말로 말한다 (단추·제목)", () => {
    expect(AVATAR_ENTRY_COPY.open).toBe(AVATAR_EDITOR_COPY.title);
  });
});

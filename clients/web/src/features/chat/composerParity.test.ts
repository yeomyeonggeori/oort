import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PICKER_EMOJI } from "@/features/emoji/EmojiPickerDialog";
import { insertMention, mentionQueryAt } from "./MentionAutocomplete";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const channel = source("./Composer.tsx");
const thread = source("../timeline/ThreadComposer.tsx");
const actions = source("../timeline/MessageActions.tsx");
const picker = source("../emoji/EmojiPickerDialog.tsx");
const tokens = source("../../design/tokens.css");

function spacing(step: string): number {
  const match = tokens.match(
    new RegExp(`^\\s*--spacing-${step}:\\s*([\\d.]+)px;`, "m")
  );
  if (!match) throw new Error(`tokens.css에 --spacing-${step}가 없다`);
  return Number(match[1]);
}

describe("컴포저 공용 표면 (#1688)", () => {
  it("반응·채널·스레드가 한 이모지 피커를 쓴다", () => {
    expect(actions).not.toContain("PICKER_EMOJI");
    expect(actions).not.toContain("ReactionPickerDialog");
    expect(channel).toContain("<EmojiPickerDialog");
    expect(thread).toContain("<EmojiPickerDialog");
    expect(picker).toContain("purpose: keyof typeof COPY");
    expect(new Set(PICKER_EMOJI).size).toBe(32);
  });

  it("피커는 programmatic dialog 한 패턴만 쓴다", () => {
    expect(picker).toContain("<Dialog open={open} onOpenChange={onOpenChange}>");
    expect(picker).toContain("opener={opener}");
    expect(picker).not.toMatch(/<DialogTrigger|import[^;]+DialogTrigger/);
    expect(channel).toContain("emoji.openPicker(event.currentTarget)");
    expect(thread).toContain("emoji.openPicker(event.currentTarget)");
  });

  it("채널과 스레드가 같은 멘션 목록·첨부 트레이를 쓴다", () => {
    for (const composer of [channel, thread]) {
      expect(composer).toContain("useMentionAutocomplete");
      expect(composer).toContain("<MentionAutocompleteList");
      expect(composer).toContain("<AttachButton");
      expect(composer).toContain("<AttachmentTray");
    }
  });

  it("멘션은 현재 토큰만 바꾸고 삽입 뒤에 캐럿을 둔다", () => {
    const value = "배포 전에 @her 확인";
    const caret = "배포 전에 @her".length;
    const query = mentionQueryAt(value, caret);
    expect(query).not.toBeNull();
    expect(insertMention(value, caret, query!, "hermes")).toEqual({
      value: "배포 전에 @hermes  확인",
      caret: "배포 전에 @hermes ".length,
    });
  });
});

describe("컴포저 스페이싱 폴리시 (#1688)", () => {
  it("px-6은 form p-3과 textarea px-3의 합이다", () => {
    expect(spacing("6")).toBe(spacing("3") + spacing("3"));
    expect(channel).toMatch(/<form[^>]+className="[^"]*\bp-3\b[^"]*"/s);
    expect(channel).toMatch(
      /data-testid="composer-input"[\s\S]*?className="[^"]*\bpx-3\b[^"]*\bpy-2\b[^"]*"/
    );
    expect(channel).toContain('data-testid="composer-hint"');
    expect(channel).toContain('"px-6 pb-2 text-meta text-ink-muted"');
  });

  it("스레드도 같은 입력 인셋과 닫힌 간격 단계만 쓴다", () => {
    expect(thread).toContain('<div className="p-3">');
    expect(thread).toMatch(
      /data-testid="thread-composer-input"[\s\S]*?className="[^"]*\bpx-3\b[^"]*\bpy-2\b[^"]*"/
    );
    expect(spacing("3")).toBe(12);
    expect(spacing("6")).toBe(24);
  });
});

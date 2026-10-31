import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// 설정의 대화 미리보기가 **타임라인과 같은 값**을 읽는가 (AP-2a #4189, 이슈 AC 4).
//
// 미리보기는 눌러 보는 사람에게 「이렇게 보여요」라고 말한다. 그 상자가 실제 대화와 다른 간격·아바타를
// 손으로 그리면 말이 거짓이 된다. 렌더 시험(`AppearanceSection.test.tsx`)은 클래스가 붙었는지를 보고,
// 이 파일은 그 클래스가 **타임라인 행이 읽는 같은 상수**에서 오는지를 소스에서 잰다.
// =============================================================================

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (rel: string) =>
  strip(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

const preview = read("./ConversationPreview.tsx");
const messageRow = read("../../timeline/MessageRow.tsx");
const messageBody = read("../../timeline/MessageBody.tsx");
const unfurlCards = read("../../timeline/UnfurlCards.tsx");

/** `import { A, B } from "<module>"`에서 이름들을 꺼낸다. */
function importedFrom(source: string, module: string): string[] {
  const found = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`).exec(source);
  return found ? found[1]!.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

describe("대화 미리보기가 타임라인과 같은 값을 읽는다", () => {
  it("행 패딩·아바타 크기·거터를 타임라인 행과 같은 spacing 모듈의 상수로 받는다", () => {
    const fromSpacing = importedFrom(preview, "@/features/timeline/spacing");
    expect(fromSpacing.sort()).toEqual(
      [
        "MESSAGE_AVATAR_GUTTER_CLASS",
        "MESSAGE_AVATAR_SIZE_CLASS",
        "ROW_CONTINUATION_PAD_CLASS",
        "ROW_GROUP_START_PAD_CLASS",
      ].sort()
    );
    // 타임라인 행도 같은 상수를 읽는다(받는 쪽의 부분집합이 아니라 같은 이름이어야 한다).
    const rowImports = importedFrom(messageRow, "./spacing");
    for (const name of fromSpacing) expect(rowImports, name).toContain(name);
  });

  it("마크다운 글은 타임라인과 같은 MessageBody가 그린다 — 문단·목록 간격이 거기서 나온다", () => {
    expect(preview).toContain("<MessageBody");
    expect(importedFrom(preview, "@/features/timeline/MessageBody").sort()).toEqual(["MESSAGE_BODY_CLASS", "MessageBody"]);
    // 링크 줄도 타임라인 본문과 같은 글자·줄 높이 상수를 읽는다(손으로 `leading-*`를 적지 않는다).
    expect(preview).toContain("MESSAGE_BODY_CLASS");
    expect(preview.match(/\bleading-[a-z]+\b/g)).toBeNull();
    // MessageBody가 문단·목록 간격을 밀도 상수로 읽는다(미리보기가 따로 간격을 적지 않는 근거).
    expect(importedFrom(messageBody, "./spacing")).toEqual(
      expect.arrayContaining(["MESSAGE_LIST_ITEM_GAP_CLASS", "MESSAGE_PROSE_GAP_CLASS"])
    );
  });

  it("손으로 적은 행 패딩·아바타 한 변·거터 폭이 없다", () => {
    // 상자 자신의 패딩(`px-4 pb-3 pt-3`)은 행 패딩이 아니다. 행은 `py-<숫자>`나 이름 패딩을 직접 적지 못한다.
    expect(preview.match(/\bp[tby]-row(?:-head)?(?![\w-])/g)).toBeNull();
    expect(preview.match(/\bpy-\d\b/g)).toBeNull();
    expect(preview.match(/\b(?:size|w)-8\b/g)).toBeNull();
    expect(preview.match(/\bsize-message-avatar\b|\bw-message-avatar\b/g)).toBeNull();
  });

  it("아바타와 본문 사이는 타임라인 행과 같은 gap-2이고, 머리/이어지는 행 분기가 타임라인과 같은 방향이다", () => {
    // #4324: 줄 가로 여백이 바깥 4 + 안쪽 12(합 16)로 바뀌었다. 이 단정이 지키는 것은 아바타·본문 사이 gap-2다.
    expect(messageRow).toMatch(/"group relative flex gap-2 mx-1 rounded-lg px-3 /);
    // 묶음 머리 행은 위가 열린 상수, 이어지는 행은 대칭 상수다. 두 상수를 맞바꾸면 미리보기가 묶음 사이를 12로 그린다.
    expect(preview).toMatch(
      /cn\(\s*"flex gap-2",\s*startsGroup\s*\?\s*ROW_GROUP_START_PAD_CLASS\s*:\s*ROW_CONTINUATION_PAD_CLASS\s*\)/
    );
    expect(messageRow).toMatch(/startsGroup\s*\?\s*ROW_GROUP_START_PAD_CLASS\s*:\s*ROW_CONTINUATION_PAD_CLASS/);
    // 거터는 손으로 쓴 `w-<숫자>`가 아니라 상수 하나다.
    expect(preview).toContain('cn("shrink-0", MESSAGE_AVATAR_GUTTER_CLASS)');
    expect(preview.match(/(?<![\w-])w-\d+(?![\w-])/g)).toBeNull(); // `min-w-0`은 폭을 정하지 않으니 걸리지 않는다.
  });

  it("상자는 카드 전폭이다 — 글자 크기를 바꿔도 오른쪽 가장자리가 움직이지 않는다", () => {
    expect(preview).toMatch(/className="[^"]*\bw-full\b[^"]*"\s*\n\s*data-testid="conversation-preview"/);
  });

  it("모양 규칙도 타임라인과 같다: 사람은 원, 에이전트는 둥근 사각", () => {
    expect(preview).toContain("rounded-full");
    expect(preview).toContain("rounded-sm");
    expect(messageRow).toContain('identity.kind === "agent" ? "rounded-sm" : "rounded-full"');
  });
});

// 링크 카드 샘플은 눌리지 않는 그림이라 진짜 `UnfurlCardView`를 쓰지 못하고 같은 클래스를 다시 적는다(#4882).
// 한쪽만 바뀌면 미리보기가 거짓말이 되므로, 두 소스에 같은 클래스 문자열이 있는지 맞대 본다.
describe("링크 카드 샘플이 타임라인 카드와 같은 클래스를 쓴다", () => {
  const SHARED = [
    "relative isolate flex rounded-md bg-surface-muted", // 테두리 없는 면
    "relative flex h-unfurl-tile w-unfurl-thumb shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted-soft text-icon", // 104x64 그림 칸
  ] as const;

  it.each(SHARED)("두 소스에 모두 있다: %s", (classes) => {
    const words = (source: string) => [...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]!);
    const asSet = (text: string) => new Set(text.split(/\s+/));
    const covers = (source: string) =>
      words(source).some((value) => {
        const have = asSet(value);
        return classes.split(" ").every((c) => have.has(c));
      });
    expect(covers(unfurlCards), "UnfurlCards.tsx").toBe(true);
    expect(covers(preview), "ConversationPreview.tsx").toBe(true);
  });

  it("미리보기는 크게 카드의 그림 틀을 타임라인과 같은 상수에서 받는다", () => {
    expect(preview).toContain("UNFURL_HERO_FRAME_CLASS");
    expect(preview).toContain('from "@/features/timeline/UnfurlCards"');
  });
});

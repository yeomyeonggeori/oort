import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@momo/core/features/timeline/markdown";
import {
  BODY_FOLD,
  CARD_FOLD,
  blockLines,
  countBlockLines,
  foldBlocks,
  foldText,
  foldWasOpened,
  rememberFoldOpen,
} from "./fold";

// 이 스위트가 지키는 것은 「접히는가」가 아니라 **접힌 것이 몇 줄인지 말한 숫자가
// 참인가**다. 진단 H-8의 아픔은 길이 그 자체가 아니라, 그 길이가 어디까지인지
// 아무도 말해 주지 않는다는 것이었다.

const lines = (n: number, prefix = "줄") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("foldText", () => {
  it("예산 안의 본문은 손대지 않는다 (채널의 대부분이 그것이다)", () => {
    const body = lines(BODY_FOLD.threshold);
    expect(foldText(body)).toEqual({ text: body, hiddenLines: 0 });
  });

  it("한 줄만 넘어도 접고, 남는 것은 정확히 예산만큼이다", () => {
    const body = lines(BODY_FOLD.threshold + 1);
    const folded = foldText(body);
    expect(folded.text.split("\n")).toHaveLength(BODY_FOLD.eager);
    expect(folded.hiddenLines).toBe(
      BODY_FOLD.threshold + 1 - BODY_FOLD.eager
    );
  });

  it("숨겼다고 말한 줄 수와 실제로 빠진 줄 수가 같다 (500줄 로그)", () => {
    const body = lines(500);
    const folded = foldText(body);
    const shown = folded.text.split("\n").length;
    expect(shown + folded.hiddenLines).toBe(500);
  });

  it("접힌 것은 언제나 12줄 이상이다: 눌러서 얻는 것이 누르는 값보다 크다", () => {
    for (const total of [25, 26, 40, 500]) {
      expect(foldText(lines(total)).hiddenLines).toBeGreaterThanOrEqual(
        BODY_FOLD.threshold - BODY_FOLD.eager
      );
    }
  });

  it("카드 값은 더 짠 예산을 쓴다: 값 하나가 본문보다 커지지 않게", () => {
    const value = lines(9);
    expect(foldText(value).hiddenLines).toBe(0);
    expect(foldText(value, CARD_FOLD).hiddenLines).toBe(9 - CARD_FOLD.eager);
  });

  it("개행 없는 긴 한 줄은 접지 않는다 (적어 둔 대가)", () => {
    const oneLine = "가".repeat(5_000);
    expect(foldText(oneLine).hiddenLines).toBe(0);
  });
});

describe("blockLines", () => {
  it("블록마다 「줄」이 무엇인지가 다르다", () => {
    const [paragraph] = parseMarkdown("첫 줄\n둘째 줄\n셋째 줄");
    expect(blockLines(paragraph)).toBe(3);
    const [code] = parseMarkdown("```sh\na\nb\nc\n```");
    expect(code.kind).toBe("code");
    expect(blockLines(code)).toBe(3);
    const [list] = parseMarkdown("- 하나\n- 둘\n- 셋\n- 넷");
    expect(list.kind).toBe("list");
    expect(blockLines(list)).toBe(4);
  });
});

describe("foldBlocks", () => {
  it("예산 안의 본문은 블록을 그대로 돌려준다", () => {
    const blocks = parseMarkdown("**결론**: 배포는 롤백했습니다.\n원인은 아래에.");
    const folded = foldBlocks(blocks);
    expect(folded.hiddenLines).toBe(0);
    expect(folded.blocks).toEqual(blocks);
  });

  it("코드 펜스 한가운데서 예산이 끝나면 그 펜스를 잘라서 남긴다", () => {
    // 산문 2줄 + 40줄 펜스 = 42줄. 진단이 말한 「500줄 로그」의 축소판이고,
    // 예산은 펜스 안쪽 10줄째에서 끝난다.
    const body = `로그를 붙입니다.\n아래를 보세요.\n\n\`\`\`sh\n${lines(40, "log")}\n\`\`\``;
    const blocks = parseMarkdown(body);
    const total = countBlockLines(blocks);
    const folded = foldBlocks(blocks);
    expect(countBlockLines(folded.blocks)).toBe(BODY_FOLD.eager);
    expect(folded.hiddenLines).toBe(total - BODY_FOLD.eager);
    const code = folded.blocks[folded.blocks.length - 1];
    expect(code.kind).toBe("code");
    if (code.kind === "code") {
      // 잘렸어도 코드는 코드다: 언어 라벨과 종류가 남아야 짧은 펜스로 읽힌다.
      expect(code.lang).toBe("sh");
      expect(code.text.split("\n")).toHaveLength(BODY_FOLD.eager - 2);
    }
  });

  it("긴 목록은 항목 단위로 잘린다", () => {
    const blocks = parseMarkdown(
      Array.from({ length: 40 }, (_, i) => `- 항목 ${i + 1}`).join("\n")
    );
    const folded = foldBlocks(blocks);
    expect(folded.hiddenLines).toBe(40 - BODY_FOLD.eager);
    const list = folded.blocks[0];
    if (list.kind !== "list") throw new Error("목록이 아니다");
    expect(list.items).toHaveLength(BODY_FOLD.eager);
    // 저자가 3번부터 셌으면 잘린 목록도 3번부터 센다.
    expect(list.ordered).toBe(false);
  });

  it("원본 블록을 제자리에서 고치지 않는다: 펼치면 원문이 그대로 돌아온다", () => {
    const blocks = parseMarkdown(`\`\`\`\n${lines(40, "log")}\n\`\`\``);
    const before = countBlockLines(blocks);
    foldBlocks(blocks);
    expect(countBlockLines(blocks)).toBe(before);
  });

  it("숨겼다고 말한 줄 수와 실제로 빠진 줄 수가 같다", () => {
    const blocks = parseMarkdown(
      `머리말\n\n- 하나\n- 둘\n- 셋\n\n\`\`\`ts\n${lines(30, "code")}\n\`\`\`\n\n맺음말`
    );
    const total = countBlockLines(blocks);
    const folded = foldBlocks(blocks);
    expect(countBlockLines(folded.blocks) + folded.hiddenLines).toBe(total);
  });
});

describe("펼쳐 둔 상태", () => {
  it("키가 없으면 아무것도 기억하지 않는다", () => {
    rememberFoldOpen(undefined, true);
    expect(foldWasOpened(undefined)).toBe(false);
  });

  it("행이 언마운트됐다 돌아와도 펼친 것은 펼친 채다", () => {
    rememberFoldOpen("msg-1", true);
    expect(foldWasOpened("msg-1")).toBe(true);
    rememberFoldOpen("msg-1", false);
    expect(foldWasOpened("msg-1")).toBe(false);
  });

  it("긴 세션이 맵을 영원히 키우지 않는다: 가장 오래된 것이 밀린다", () => {
    for (let i = 0; i < 600; i++) rememberFoldOpen(`bulk-${i}`, true);
    expect(foldWasOpened("bulk-0")).toBe(false);
    expect(foldWasOpened("bulk-599")).toBe(true);
  });
});

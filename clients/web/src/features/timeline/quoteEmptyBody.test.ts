import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { quoteBlockFrom } from "@momo/core/features/timeline/quote";
import type { QuotedMessage } from "@momo/core/lib/api";

// =============================================================================
// 본문 없는 인용 — 「지워졌다」와 「내용이 없다」가 웹에서 갈라져 있는가 (이슈 #1498).
//
// `QuoteBlock.tsx` 에는 두 갈래가 있다: `kind === "deleted"` 는 「삭제된 메시지」를
// 말하고, `lines.length === 0` 인 `ready` 는 「내용 없는 메시지」를 말한다. 둘째
// 갈래는 **코어가 그 모양을 만들어 줄 때만** 살아 있다 — 코어가 빈 본문을 전부
// 묘비로 접으면 이 클라의 낱말 하나가 조용히 도달 불가가 되고, 화면은 지워지지 않은
// 메시지를 지워졌다고 말하기 시작한다.
//
// 폰에는 그 단정이 이미 있다(`__tests__/quoteSurface.test.tsx` — 「본문이 공백뿐인
// 원본을 빈 칸으로 두지 않는다」). 웹에는 없어서, #1498 을 고치는 동안 이 클라의
// 스위트는 그 정책이 뒤집혀도 초록으로 남았다. 그 구멍을 여기서 막는다.
//
// 이 클라에는 렌더 하네스가 없다(testing-library 미의존). 그래서 코어가 만드는
// 모양은 코어를 불러 재고, 그 모양을 그리는 갈래는 `bodySlot.test.ts` 와 같은
// 방식으로 소스를 읽어 잰다.
// =============================================================================

const QUOTE_SRC = readFileSync(
  fileURLToPath(new URL("./QuoteBlock.tsx", import.meta.url)),
  "utf8"
);

function quoted(body: string | null | undefined): QuotedMessage {
  const base: Record<string, unknown> = {
    id: "0199a1b2-0000-7000-8000-000000000001",
    seq: 41,
    authorMemberId: "0199a1b2-0000-7000-8000-000000000003",
    type: "text",
    state: "sent",
  };
  if (body !== undefined) base.body = body;
  return base as unknown as QuotedMessage;
}

describe("본문 없는 인용의 두 갈래 (#1498)", () => {
  it("본문이 아예 없으면(부재·런타임 null) 묘비다", () => {
    // 서버는 tombstone 에서 본문을 뺀다. 키를 빼든 `null` 을 싣든 같은 사실이고,
    // 선언 타입(`body?: string`)은 런타임 `null` 을 막지 못한다(#1476 과 같은 값).
    expect(quoteBlockFrom(quoted(undefined)).kind).toBe("deleted");
    expect(quoteBlockFrom(quoted(null)).kind).toBe("deleted");
  });

  it("빈 문자열·공백뿐인 본문은 묘비가 아니라 발췌만 빈 인용이다", () => {
    for (const body of ["", "   \n\t "]) {
      const block = quoteBlockFrom(quoted(body));
      expect(block.kind).toBe("ready");
      if (block.kind !== "ready") continue;
      expect(block.lines).toEqual([]);
    }
  });

  it("그 빈 발췌를 그리는 갈래가 이 클라에 남아 있다", () => {
    expect(QUOTE_SRC).toContain("lines.length === 0");
    expect(QUOTE_SRC).toContain("내용 없는 메시지");
    expect(QUOTE_SRC).toContain('data-testid="quote-deleted"');
  });
});

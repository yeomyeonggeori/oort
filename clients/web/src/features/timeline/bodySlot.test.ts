import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasRenderableBody } from "@momo/core/features/timeline/bodySlot";
import { rowPresentation } from "@momo/core/features/timeline/rowModel";
import type { Message } from "@momo/core/lib/api";

// =============================================================================
// 살릴 본문이 없는 행은 본문 칸을 만들지 않는다 — 웹 배선 (이슈 #1465 → #1478).
//
// 판정 자체와 「자격과 내용은 다른 물음」이라는 계약은 이제 **코어**가 잰다
// (`packages/momo-core/src/features/timeline/bodySlot.test.ts` — #1478 이 판정을
// 거기로 올렸다). 여기 남는 것은 이 클라만 답할 수 있는 물음이다:
//
//   1. 이 행이 그 판정을 **실제로 부르는가.** 옳은 함수를 아무도 부르지 않는 것이
//      이 레포에서 가장 조용한 실패 방식이다.
//   2. 부르되 **코어의 것을** 부르는가 — 로컬 사본이 다시 서면 #1478 이 되돌아
//      온다(같은 규칙이 두 곳에 적히고, 한 곳만 고쳐진다).
//   3. 묘비와 편집기가 그 판정 **앞에** 남는가.
//
// 이 클라에는 렌더 하네스가 없다(testing-library 미의존). 그래서 셋 다
// `MessageRow.tsx` 소스를 읽어 잰다 — `completionReportCard.test.ts` 가 쓰는 것과
// 같은 방식이다. 화면에서의 부재는 `scripts/capture-completion.mjs` 가 재고
// (`EMPTY_BODY_PARAGRAPHS` — 리포트 행 안에 글자 없는 문단이 0개), 폰 쪽 짝은
// `clients/mobile/__tests__/conversationHygiene.test.tsx` 의 공백-본문 단정이다.
// =============================================================================

const ROW_SRC = readFileSync(
  fileURLToPath(new URL("./MessageRow.tsx", import.meta.url)),
  "utf8"
);

/** 주석을 걷어낸 코드. 이 레포는 반례를 주석에 그대로 인용한다. */
const ROW_CODE = ROW_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^\s*\/\/.*$/gm,
  ""
);

function report(props: Record<string, unknown>, body?: string): Message {
  return {
    id: "0199a1b2-0000-7000-8000-000000000001",
    channelId: "0199a1b2-0000-7000-8000-000000000002",
    seq: 2206,
    hlcTs: 0,
    hlcCount: 0,
    authorMemberId: "0199a1b2-0000-7000-8000-000000000003",
    type: "text",
    state: "sent",
    props,
    createdAtMs: 0,
    ...(body === undefined ? {} : { body }),
  };
}

/** #1454 H-2 가 커밋하는 모양: 산문도 요약도 제목도 없고 게이트만 있다. */
const GATES_ONLY = {
  kind: "completion_report",
  gates: [{ surface: "웹", checks: [{ label: "테스트", outcome: "pass" }] }],
};

describe("행이 그 판정을 실제로 쓴다", () => {
  it("본문 갈래가 `hasBody` 뒤에 선다", () => {
    expect(ROW_CODE).toContain("hasRenderableBody(message.body)");
    expect(ROW_CODE).toMatch(
      /\) : hasBody \? \(\s*<MessageBody body=\{message\.body \?\? ""\}/
    );
  });

  it("판정은 코어에서 온다 — 로컬 사본이 다시 서면 실패한다", () => {
    // #1478 이 산 것이 이 한 줄이다. 웹이 자기 사본을 다시 들면 폰과 답이 갈라질
    // 수 있고, 그 갈라짐은 화면을 보기 전까지 보이지 않는다.
    expect(ROW_CODE).toContain(
      'import { hasRenderableBody } from "@momo/core/features/timeline/bodySlot"'
    );
    expect(ROW_CODE).not.toMatch(/from "\.\/bodySlot"/);
  });

  it("묘비와 편집기는 그 판정 앞에 남는다", () => {
    // 둘 다 본문 자리에 서지만 본문이 아니다. 묘비를 이 판정 뒤로 옮기면 지워진
    // 행이 통째로 사라지고(서버가 본문을 비운다), 편집기를 옮기면 빈 메시지를
    // 고칠 길이 없어진다.
    const branch = ROW_CODE.slice(
      ROW_CODE.indexOf("{keepsBody &&"),
      ROW_CODE.indexOf("<AttachmentList")
    );
    expect(branch.indexOf('data-testid="tombstone"')).toBeGreaterThan(-1);
    expect(branch.indexOf('data-testid="tombstone"')).toBeLessThan(
      branch.indexOf(") : hasBody ? (")
    );
    expect(branch.indexOf("<MessageEditor")).toBeLessThan(
      branch.indexOf(") : hasBody ? (")
    );
  });
});

describe("이 클라가 마주치는 모양 (무회귀)", () => {
  it("요약 없는 완료 리포트: 자격은 살아 있고 본문 칸만 사라진다", () => {
    const message = report(GATES_ONLY);
    // 자격(`keepsBody`)은 #1465 도 #1478 도 건드리지 않는다 — 카드는 그대로 선다.
    expect(rowPresentation(message).keepsBody).toBe(true);
    expect(hasRenderableBody(message.body)).toBe(false);
  });

  it("같은 리포트에 산문이 실리면 그 산문은 남는다 (M2)", () => {
    const message = report(GATES_ONLY, "환경 셋업을 마쳤습니다.");
    expect(rowPresentation(message).keepsBody).toBe(true);
    expect(hasRenderableBody(message.body)).toBe(true);
  });

  it("공백만 있는 본문은 칸을 얻지 못한다 (실측 46px 의 그 모양)", () => {
    expect(hasRenderableBody(report({}, "   \n  ").body)).toBe(false);
  });
});

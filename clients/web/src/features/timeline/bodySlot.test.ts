import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCardModel, cardKeepsBody } from "@momo/core/features/timeline/agentCardModel";
import { rowPresentation } from "@momo/core/features/timeline/rowModel";
import type { Message } from "@momo/core/lib/api";
import { hasRenderableBody } from "./bodySlot";

// =============================================================================
// 살릴 본문이 없는 행은 본문 칸을 만들지 않는다 (이슈 #1465).
//
// 이 클라에는 렌더 하네스가 없다(testing-library 미의존). 그래서 계약을 세 겹으로
// 잰다 — `completionReportCard.test.ts` 가 쓰는 것과 같은 방식이다:
//
//   1. 판정 자체를 함수로 잰다 (`hasRenderableBody`).
//   2. 코어의 `keepsBody` 가 이 판정과 **다른 물음**임을 잰다 — 요약 없는 완료
//      리포트에서 자격은 true 인데 살릴 본문이 없다. 그 어긋남이 이 이슈다.
//   3. `MessageRow.tsx` 소스를 읽어 판정이 실제로 배선돼 있는지 잰다. 옳은 함수를
//      아무도 부르지 않는 것이 이 레포에서 가장 조용한 실패 방식이다.
//
// 화면에서의 부재는 `scripts/capture-completion.mjs` 가 재고(`EMPTY_BODY_PARAGRAPHS`
// — 리포트 행 안에 글자 없는 문단이 0개), 폰 쪽 짝은 폰 MessageRow 의 `body !== ''`
// 갈래다.
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

describe("hasRenderableBody", () => {
  it("사람이 읽을 글자가 없으면 false", () => {
    // 서버가 보내는 모양은 **부재**다: `MessageDto.body` 가
    // `skip_serializing_if = "Option::is_none"` 이라 빈 본문은 키째로 빠진다.
    expect(hasRenderableBody(undefined)).toBe(false);
    // 실시간 프레임은 `"body": null` 을 싣는다(`build_broadcast_payload`). 코어의
    // `payloadToMessage` 가 부재로 바꿔 주지만, 화면 판정이 그 정규화 하나에
    // 기대고 있지는 않다.
    expect(hasRenderableBody(null)).toBe(false);
    expect(hasRenderableBody("")).toBe(false);
    // 공백만 있는 본문이 눈에 보이는 결함이었다: `whitespace-pre-wrap` 이 그것을
    // 그대로 그려 카드 위에 빈 줄이 섰다(실측 46px, `bodySlot.ts` 표).
    expect(hasRenderableBody(" ")).toBe(false);
    expect(hasRenderableBody("   \n  ")).toBe(false);
    expect(hasRenderableBody("\t\n")).toBe(false);
  });

  it("글자가 하나라도 있으면 true — 앞뒤 공백은 판정을 바꾸지 못한다", () => {
    expect(hasRenderableBody("환경 셋업을 마쳤습니다.")).toBe(true);
    expect(hasRenderableBody("  ok  ")).toBe(true);
    // 마침표 하나도 저자가 친 것이다. 짧다는 이유로 지우지 않는다.
    expect(hasRenderableBody(".")).toBe(true);
  });
});

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

describe("자격과 내용은 다른 물음이다", () => {
  it("요약 없는 완료 리포트는 자격은 true, 살릴 본문은 없다", () => {
    const message = report(GATES_ONLY);
    const card = agentCardModel(message);
    expect(card?.kind).toBe("completion_report");
    // 코어의 시맨틱은 그대로다: 요약이 없으면 본문이 곧 빠진 요약이므로 살릴
    // **자격**이 있다. 이 이슈는 그 자격을 건드리지 않는다.
    expect(card && cardKeepsBody(card)).toBe(true);
    expect(rowPresentation(message).keepsBody).toBe(true);
    // 그런데 살릴 본문이 없다. 웹은 이 어긋남에서 빈 문단을 하나 세웠다.
    expect(hasRenderableBody(message.body)).toBe(false);
  });

  it("같은 리포트에 산문이 실리면 그 산문은 남는다 (M2 무회귀)", () => {
    const message = report(GATES_ONLY, "환경 셋업을 마쳤습니다.");
    expect(rowPresentation(message).keepsBody).toBe(true);
    expect(hasRenderableBody(message.body)).toBe(true);
  });

  it("요약이 있는 리포트는 애초에 자격이 없다 (본문을 두 번 말하지 않는다)", () => {
    const message = report(
      { ...GATES_ONLY, summary: "게이트를 전부 초록으로 맞췄습니다." },
      "환경 셋업을 마쳤습니다."
    );
    expect(rowPresentation(message).keepsBody).toBe(false);
  });
});

describe("행이 그 판정을 실제로 쓴다", () => {
  it("본문 갈래가 `hasBody` 뒤에 선다", () => {
    expect(ROW_CODE).toContain("hasRenderableBody(message.body)");
    expect(ROW_CODE).toMatch(
      /\) : hasBody \? \(\s*<MessageBody body=\{message\.body \?\? ""\}/
    );
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

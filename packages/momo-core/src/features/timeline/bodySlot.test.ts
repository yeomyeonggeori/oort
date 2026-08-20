import { describe, expect, it } from "vitest";
import { agentCardModel, cardKeepsBody } from "./agentCardModel";
import { hasRenderableBody } from "./bodySlot";
import { rowPresentation } from "./rowModel";
import type { Message } from "../../lib/api";

// =============================================================================
// 살릴 본문이 없는 행은 본문 칸을 만들지 않는다 (#1465 → #1478).
//
// 이 스위트는 #1465 가 웹에 세웠던 계약이 **판정과 함께** 코어로 올라온 것이다.
// 여기서 재는 것은 순수한 두 가지다:
//
//   1. 판정 자체 — 부재/`null`/빈 문자열/공백만 vs 글자.
//   2. 코어의 `keepsBody` 가 이 판정과 **다른 물음**임 — 요약 없는 완료 리포트에서
//      자격은 true 인데 살릴 본문이 없다. 그 어긋남이 #1465 였다.
//
// 두 클라가 실제로 이 판정을 부르는지는 각 표면이 잰다: 웹은 소스 배선
// (`clients/web/src/features/timeline/bodySlot.test.ts`), 폰은 그려진 트리
// (`clients/mobile/__tests__/conversationHygiene.test.tsx`). 옳은 함수를 아무도
// 부르지 않는 것이 이 레포에서 가장 조용한 실패 방식이라, 코어가 판정을 갖는다고
// 해서 그 배선 측정이 없어지지는 않는다.
// =============================================================================

describe("hasRenderableBody", () => {
  it("사람이 읽을 글자가 없으면 false", () => {
    // 서버가 보내는 모양은 **부재**다: `MessageDto.body` 가
    // `skip_serializing_if = "Option::is_none"` 이라 빈 본문은 키째로 빠진다.
    expect(hasRenderableBody(undefined)).toBe(false);
    // 실시간 프레임은 `"body": null` 을 싣는다(`build_broadcast_payload`).
    // `payloadToMessage` 가 부재로 바꿔 주지만, 화면 판정이 그 정규화 하나에
    // 기대고 있지는 않다.
    expect(hasRenderableBody(null)).toBe(false);
    expect(hasRenderableBody("")).toBe(false);
    // 공백만 있는 본문이 눈에 보이는 결함이었다: 웹은 `whitespace-pre-wrap` 이
    // 그것을 그대로 그려 카드 위에 빈 줄이 섰고(실측 46px, `bodySlot.ts` 표),
    // 폰은 `body !== ''` 라 애초에 이 갈래에 오지도 못했다(#1478).
    expect(hasRenderableBody(" ")).toBe(false);
    expect(hasRenderableBody("   \n  ")).toBe(false);
    expect(hasRenderableBody("\t\n")).toBe(false);
    // 줄바꿈만 있는 본문도 같다 — 폰에서 이것이 그대로 줄을 만들었다.
    expect(hasRenderableBody("\n\n")).toBe(false);
  });

  it("글자가 하나라도 있으면 true — 앞뒤 공백은 판정을 바꾸지 못한다", () => {
    expect(hasRenderableBody("환경 셋업을 마쳤습니다.")).toBe(true);
    expect(hasRenderableBody("  ok  ")).toBe(true);
    // 마침표 하나도 저자가 친 것이다. 짧다는 이유로 지우지 않는다.
    expect(hasRenderableBody(".")).toBe(true);
    // 안쪽 공백은 본문의 일부다. 「글자가 있다」는 사실만 본다.
    expect(hasRenderableBody("  \n 한 줄 \n  ")).toBe(true);
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
    // 시맨틱은 그대로다: 요약이 없으면 본문이 곧 빠진 요약이므로 살릴 **자격**이
    // 있다. #1465 도 #1478 도 그 자격을 건드리지 않는다.
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

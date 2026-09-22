import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { agentCardModel, cardKeepsBody } from "./agentCardModel";
import {
  ACTION_RESULT_PROP_KEY,
  ACTION_RESULT_STATUS_LABEL,
  ACTION_RESULT_STATUS_NOTE,
  MAX_ACTION_RESULT_ROWS,
  actionResultCard,
  parseActionResultStatus,
} from "./actionResultCard";

// ADR-0186 부록 B 의 샘플 그대로. 서버(AX-3b)가 아직 없으므로 이것이 계약이다.
const APPENDIX_B = {
  v: 1,
  action_id: "invite.create",
  status: "executed",
  approval_id: "0199aa11-2222-7000-8000-0000000000a1",
  decided_by: "019f9a01-0000-7000-8000-000000000401",
  ref: { type: "invite", id: "0199aa11-2222-7000-8000-0000000000f1" },
  rows: [
    { label: "역할", value: "member" },
    { label: "만료", value: "2026-09-29" },
  ],
  secret_shown_once: true,
  next: { label: "설정 › 초대에서 보기", href: "/settings?section=invites" },
};

function resultMessage(over: Record<string, unknown> = {}): Message {
  return {
    id: "0199aa11-2222-7000-8000-0000000000e1",
    channelId: "0199aa11-2222-7000-8000-000000000201",
    seq: 42,
    authorMemberId: "019f9a01-0000-7000-8000-000000000401",
    type: "tool_result",
    body: "초대 링크를 만들었습니다.",
    state: "sent",
    createdAtMs: 0,
    props: { [ACTION_RESULT_PROP_KEY]: { ...APPENDIX_B, ...over } },
  } as unknown as Message;
}

describe("action_result 카드 (ADR-0186 부록 B)", () => {
  it("부록 B 샘플을 그대로 읽는다", () => {
    const card = agentCardModel(resultMessage());
    expect(card?.kind).toBe("action_result");
    if (card?.kind !== "action_result") throw new Error("not an action_result");
    expect(card.actionId).toBe("invite.create");
    expect(card.status).toBe("executed");
    expect(card.rows).toEqual([
      { label: "역할", value: "member" },
      { label: "만료", value: "2026-09-29" },
    ]);
    expect(card.secretShownOnce).toBe(true);
    expect(card.next).toEqual({
      label: "설정 › 초대에서 보기",
      href: "/settings?section=invites",
    });
    expect(card.ref).toEqual({
      type: "invite",
      id: "0199aa11-2222-7000-8000-0000000000f1",
    });
    // 제목은 본문이고, 그래서 본문은 위에 한 번 더 서지 않는다.
    expect(card.title).toBe("초대 링크를 만들었습니다.");
    expect(cardKeepsBody(card)).toBe(false);
  });

  it("네 상태 전부에 칩 낱말과 문장이 있다", () => {
    for (const status of ["executed", "rejected", "expired", "role_required"] as const) {
      const card = agentCardModel(resultMessage({ status }));
      if (card?.kind !== "action_result") throw new Error(`no card for ${status}`);
      expect(card.status).toBe(status);
      expect(ACTION_RESULT_STATUS_LABEL[status]).not.toBe("");
      expect(ACTION_RESULT_STATUS_NOTE[status]).not.toBe("");
    }
    expect(ACTION_RESULT_STATUS_NOTE.role_required).toBe(
      "관리자가 승인해야 합니다."
    );
  });

  it("모르는 판은 카드가 아니라 본문 폴백이다 (D5)", () => {
    const card = agentCardModel(resultMessage({ v: 2 }));
    // 도구 결과로 떨어진다. 본문이 그대로 남는 것이 폴백의 뜻이다.
    expect(card?.kind).toBe("tool");
  });

  it("모르는 상태도 본문 폴백이다 — 무슨 일이 났는지 모르면 결과를 그리지 않는다", () => {
    const card = agentCardModel(resultMessage({ status: "half_done" }));
    expect(card?.kind).toBe("tool");
    expect(parseActionResultStatus("half_done")).toBeNull();
  });

  it("action_id 가 없으면 카드가 아니다", () => {
    const card = agentCardModel(resultMessage({ action_id: "" }));
    expect(card?.kind).toBe("tool");
  });

  it("tool_call 에서는 결과 카드를 세우지 않는다", () => {
    const message = { ...resultMessage(), type: "tool_call" } as Message;
    expect(agentCardModel(message)?.kind).toBe("tool");
  });

  it("모양이 어긋난 행은 버리고 개수로 말한다 (조용히 자르지 않는다)", () => {
    const card = actionResultCard(
      {
        [ACTION_RESULT_PROP_KEY]: {
          ...APPENDIX_B,
          rows: [
            { label: "역할", value: "member" },
            { label: "", value: "이름 없는 행" },
            { label: "숫자", value: 3 },
            "행이 아닌 것",
          ],
        },
      },
      "본문"
    );
    expect(card?.rows).toEqual([{ label: "역할", value: "member" }]);
    expect(card?.omittedRows).toBe(3);
  });

  it("행 상한을 넘으면 넘은 만큼 개수로 남는다", () => {
    const rows = Array.from({ length: MAX_ACTION_RESULT_ROWS + 3 }, (_, i) => ({
      label: `라벨 ${i}`,
      value: `값 ${i}`,
    }));
    const card = actionResultCard(
      { [ACTION_RESULT_PROP_KEY]: { ...APPENDIX_B, rows } },
      "본문"
    );
    expect(card?.rows).toHaveLength(MAX_ACTION_RESULT_ROWS);
    expect(card?.omittedRows).toBe(3);
  });

  it("카드가 서면 숨김 0이다 — 그린 것을 숨겼다고 말하지 않는다", () => {
    const card = agentCardModel(resultMessage());
    if (card?.kind !== "action_result") throw new Error("not an action_result");
    expect(card.detail.withheld).toBe(0);
  });

  it("1회 값을 담을 칸이 없다 (D4) — props 에 실려 와도 모델에 들어오지 않는다", () => {
    const card = actionResultCard(
      {
        [ACTION_RESULT_PROP_KEY]: {
          ...APPENDIX_B,
          // 서버가 규율을 어겨 보내더라도 이 모델에는 앉을 자리가 없다.
          value: "https://oort.test/join?code=NOPE",
          secretOnce: { kind: "invite_link", value: "https://oort.test/join?code=NOPE" },
        },
      },
      "본문"
    );
    expect(JSON.stringify(card)).not.toContain("NOPE");
  });

  it("본문이 없으면 중립 제목이 선다", () => {
    const message = { ...resultMessage(), body: null } as unknown as Message;
    const card = agentCardModel(message);
    if (card?.kind !== "action_result") throw new Error("not an action_result");
    expect(card.title).toBe("워크스페이스 행동");
  });
});

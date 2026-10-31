import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { agentRequestBundle } from "./agentCardModel";
import { remainingTime } from "./requestBundle";

// #4986. 조용한 줄의 남은 시간. 15분짜리 허락(DM 들이기)이 「1시간 남음」이라고 말해서, 결정할 사람이
// 한 시간을 믿고 미루다 만료를 만났다. 단위는 남은 크기로 고르고, 단위 안에서는 내려서 실제보다 길게
// 말하지 않는다. 표의 오른쪽은 문자열 그대로 단정한다(「있다」가 아니라 「이 글자다」).
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const after = (ms: number) => remainingTime(NOW + ms, NOW);

describe("조용한 줄의 남은 시간 (#4986)", () => {
  it("한 시간이 안 되면 분으로 말한다: 15분짜리가 「1시간」이 되지 않는다", () => {
    expect(after(15 * MIN)).toBe("15분 남음");
    expect(after(59 * MIN)).toBe("59분 남음");
    expect(after(HOUR - 1)).toBe("59분 남음");
    expect(after(10 * MIN + 1)).toBe("10분 남음");
  });

  it("10분 이하는 숫자 없이 곧 만료라고 말한다(기한 정각 전까지)", () => {
    expect(after(10 * MIN)).toBe("10분 안에 만료돼요");
    expect(after(1)).toBe("10분 안에 만료돼요");
  });

  it("단위 안에서는 내린다: 실제보다 길게 말하지 않는다", () => {
    expect(after(HOUR)).toBe("1시간 남음");
    expect(after(HOUR + MIN)).toBe("1시간 남음"); // 올림이면 「2시간」이 된다
    expect(after(2 * HOUR - 1)).toBe("1시간 남음");
    expect(after(23 * HOUR)).toBe("23시간 남음");
    expect(after(DAY - 1)).toBe("23시간 남음");
    expect(after(DAY)).toBe("1일 남음");
    expect(after(DAY + HOUR)).toBe("1일 남음"); // 올림이면 「2일」이 된다
    expect(after(3 * DAY)).toBe("3일 남음");
  });

  it("기한을 모르거나 이미 지났으면 말하지 않는다", () => {
    expect(remainingTime(undefined, NOW)).toBeUndefined();
    expect(remainingTime(NOW, NOW)).toBeUndefined();
    expect(remainingTime(NOW - 1, NOW)).toBeUndefined();
  });

  it("값은 분 단위로만 움직인다: 같은 분 안의 초는 같은 글자다", () => {
    expect(after(15 * MIN + 59_000)).toBe(after(15 * MIN));
    expect(after(15 * MIN - 1)).not.toBe(after(15 * MIN));
  });
});

describe("묶음 모델의 남은 시간 줄 (#4986)", () => {
  const approval = (expiresAtMs: number, extra: Record<string, unknown> = {}): Message => ({
    id: "m", channelId: "c", seq: 1, hlcTs: 1, hlcCount: 0, authorMemberId: "agent",
    type: "approval_request", body: "", state: "sent", createdAtMs: 1,
    props: { approval_id: "approval", action_type: "tool_call", tool_name: "shell", status: "pending", expires_at_ms: expiresAtMs, ...extra },
  } as Message);
  const context = { nowMs: NOW, viewerMemberId: "human", viewerKind: "human" as const, canDecide: true };

  it("15분 남은 대기 카드는 「15분 남음」을 말하고, 눌리지 않는 표면용으로 「자세히」 없는 줄을 따로 낸다", () => {
    const model = agentRequestBundle(approval(NOW + 15 * MIN), context)!;
    expect(model.quietLine).toBe("15분 남음 · 자세히");
    expect(model.remainingLine).toBe("15분 남음");
  });

  it("결정을 기다리지 않는 카드는 남은 시간 줄이 없다(키 자체가 없다)", () => {
    const closed = agentRequestBundle(approval(NOW + 15 * MIN, { status: "rejected" }), context)!;
    expect("remainingLine" in closed).toBe(false);
    expect(closed.quietLine).toBe("자세히");
    const unknown = agentRequestBundle(approval(NOW, { expires_at_ms: undefined }), context)!;
    expect("remainingLine" in unknown).toBe(false);
  });
});

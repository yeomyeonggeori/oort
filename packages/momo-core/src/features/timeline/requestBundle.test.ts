import { describe, expect, it } from "vitest";
import type { AgentRunBundle, AgentRunProgress, Message } from "../../lib/api";
import { agentCardModel, agentRequestBundle } from "./agentCardModel";
import {
  remainingTime,
  requestBundleDecisionMode,
  runBundleCanDecide,
  runBundleSnapshot,
} from "./requestBundle";

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

// #4960. run 진행 bundle은 서버가 보는 사람 기준으로 판정한 값이고, 화면은 그 값을 그대로 읽는다.
describe("run 진행 bundle의 서버 값 (#4763)", () => {
  const bundle = (patch: Partial<AgentRunBundle> = {}): AgentRunBundle => ({
    approvalId: "approval", status: "pending", decisionMode: "inline", canDecide: true,
    actionType: "tool_call", intent: "소개를 바꿔도 될까요?", ...patch,
  });
  const run = (value?: AgentRunBundle) => ({ bundle: value }) as Pick<AgentRunProgress, "bundle">;

  it("runBundleSnapshot은 서버 값을 그대로 옮긴다: decisionMode·canDecide·status·actionType·intent", () => {
    expect(runBundleSnapshot(run(bundle()))).toEqual({
      approvalId: "approval", status: "pending", decisionMode: "inline", canDecide: true,
      actionType: "tool_call", intent: "소개를 바꿔도 될까요?",
    });
    expect(runBundleSnapshot(run(bundle({ decisionMode: "open", canDecide: false })))).toMatchObject({
      decisionMode: "open", canDecide: false,
    });
  });

  it("bundle이 없는 run(옛 서버·승인 없는 run)은 snapshot이 없다: 칩·요약 줄은 phase로 읽는다", () => {
    expect(runBundleSnapshot(run(undefined))).toBeUndefined();
  });

  it("덧댄 카드 스냅샷에 상태가 있으면 그것이 먼저고, 상태가 없는 덧댐은 서버 bundle을 가리지 않는다", () => {
    const overlay = { status: "approved", result: { status: "executed", rows: [], omittedRows: 0 } };
    expect(runBundleSnapshot({ ...run(bundle()), bundleSnapshot: overlay })).toBe(overlay);
    expect(runBundleSnapshot({ ...run(bundle()), bundleSnapshot: { approvalId: "approval" } })?.status).toBe("pending");
  });

  it("runBundleCanDecide는 이 승인의 bundle일 때만 말한다: 다른 승인의 카드는 모른다(undefined)", () => {
    expect(runBundleCanDecide(run(bundle({ canDecide: false })), "approval")).toBe(false);
    expect(runBundleCanDecide(run(bundle({ canDecide: true })), "APPROVAL")).toBe(true);
    expect(runBundleCanDecide(run(bundle({ canDecide: false })), "older-approval")).toBeUndefined();
    expect(runBundleCanDecide(run(bundle()), null)).toBeUndefined();
    expect(runBundleCanDecide(run(undefined), "approval")).toBeUndefined();
    expect(runBundleCanDecide(undefined, "approval")).toBeUndefined();
  });
});

// 「클라이언트에서 decisionMode를 다시 계산하지 않아요」: 서버 값이 있으면 옛 공개 사실(실행 계획·행동 목록)보다
// 그 값이 먼저다. 없을 때만(옛 서버) 폴백한다 — 그 폴백은 그대로 둔다.
describe("결정 모드는 서버 값이 먼저다 (#4763)", () => {
  const card = (props: Record<string, unknown>) => {
    const model = agentCardModel({
      id: "m", channelId: "c", seq: 1, hlcTs: 1, hlcCount: 0, authorMemberId: "agent",
      type: "approval_request", body: "", state: "sent", createdAtMs: 1,
      props: { approval_id: "approval", status: "pending", ...props },
    } as Message);
    if (model?.kind !== "approval") throw new Error("approval card");
    return model;
  };
  const SPAWN = { execution: { kind: "work_session_spawn", host_candidates: [{ host_id: "h", display_name: "내 맥", host_type: "local", tier: "local", scope: "user", online: true, selectable: true }], default_host_id: "h" } };

  it("서버가 inline이라 했으면 실행 계획이 있어도 inline이다", () => {
    const withPlan = card({ action_type: "tool_call", tool_name: "shell", decision_mode: "inline", ...SPAWN });
    expect(withPlan.execution).not.toBeNull();
    expect(requestBundleDecisionMode(withPlan)).toBe("inline");
  });

  it("서버가 open이라 했으면 지금까지 inline이던 행동도 open이다", () => {
    const action = { id: "channel.create", rows: [], required_role: "admin" };
    const legacy = card({ action_type: "workspace_action", action });
    expect(requestBundleDecisionMode(legacy)).toBe("inline");
    expect(requestBundleDecisionMode(card({ action_type: "workspace_action", action, decision_mode: "open" }))).toBe("open");
  });

  it("서버가 모드를 안 보낸 옛 응답은 지금처럼 공개 사실로 읽는다(폴백)", () => {
    expect(requestBundleDecisionMode(card({ action_type: "tool_call", tool_name: "shell", ...SPAWN }))).toBe("open");
    expect(requestBundleDecisionMode(card({ action_type: "tool_call", tool_name: "shell" }))).toBe("inline");
  });
});

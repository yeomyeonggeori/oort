import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { agentCardModel } from "./agentCardModel";
import { presentableRows, settleToolCalls } from "./toolCallSettle";

// #4986. 서버는 `tool_call` 행을 한 번 쓰고 고치지 않는다(`{name, arguments, call_id}` 가 전부).
// 결과는 같은 `call_id` 의 `tool_result` 행으로 따로 온다. 결과가 이미 도착했는데도 호출 카드가
// 「생각 중」으로 남던 결함을, 목록이 가진 사실로 닫는다.
function row(type: "tool_call" | "tool_result", id: string, props: Record<string, unknown>, extra: Partial<Message> = {}): Message {
  return {
    id, channelId: "channel-1", seq: 1, hlcTs: 1, hlcCount: 0, authorMemberId: "agent",
    type, body: type === "tool_call" ? "Tool call: work.session.end" : "done", state: "sent", createdAtMs: 1,
    props, ...extra,
  } as Message;
}
const call = (callId: string, extra: Record<string, unknown> = {}) => row("tool_call", `call-${callId}`, { name: "work.session.end", arguments: {}, call_id: callId, ...extra });
const result = (callId: string, extra: Record<string, unknown> = {}) => row("tool_result", `result-${callId}`, { call_id: callId, output: "ok", is_error: false, ...extra });
const chip = (message: Message) => {
  const card = agentCardModel(message);
  if (card?.kind !== "tool") throw new Error("not a tool card");
  return card.status;
};

describe("끝난 도구 호출 카드 (#4986)", () => {
  it("바탕: 결과를 모르는 호출 행은 「생각 중」이다 — 서버가 상태를 싣지 않는다", () => {
    expect(chip(call("a"))).toBe("thinking");
  });

  it("같은 채널에 같은 call_id 의 결과가 있으면 호출 카드가 완료로 닫힌다", () => {
    const [settled] = settleToolCalls([call("a"), result("a")]);
    expect(chip(settled!)).toBe("done");
  });

  it("결과가 오류면 실패로, 거부·만료로 닫힌 결과면 중단으로 닫힌다 (사람이 한 일은 오류가 아니다)", () => {
    expect(chip(settleToolCalls([call("a"), result("a", { is_error: true })])[0]!)).toBe("error");
    expect(chip(settleToolCalls([call("a"), result("a", { is_error: true, status: "rejected", approval_id: "x" })])[0]!)).toBe("cancelled");
    expect(chip(settleToolCalls([call("a"), result("a", { is_error: true, status: "expired", approval_id: "x" })])[0]!)).toBe("cancelled");
  });

  it("결과가 아직 없는 호출과 다른 call_id 의 결과는 건드리지 않는다: 그때의 「생각 중」은 맞는 말이다", () => {
    const messages = [call("a"), call("b"), result("b")];
    const settled = settleToolCalls(messages);
    expect(chip(settled[0]!)).toBe("thinking");
    expect(chip(settled[1]!)).toBe("done");
  });

  it("다른 채널의 같은 call_id 는 닫지 않는다", () => {
    const other = row("tool_result", "result-other", { call_id: "a", output: "ok", is_error: false }, { channelId: "channel-2" });
    expect(chip(settleToolCalls([call("a"), other])[0]!)).toBe("thinking");
  });

  it("서버가 상태를 싣고 온 호출 행은 덮지 않고, 지운 결과 행은 세지 않는다", () => {
    expect(chip(settleToolCalls([call("a", { status: "running" }), result("a")])[0]!)).toBe("thinking");
    const deleted = row("tool_result", "result-a", { call_id: "a", output: "ok", is_error: false }, { state: "deleted" });
    expect(chip(settleToolCalls([call("a"), deleted])[0]!)).toBe("thinking");
  });

  it("바꿀 행이 없으면 같은 배열을, 바꿔도 같은 원본은 같은 사본을 돌려준다(행이 다시 그려지지 않는다)", () => {
    const quiet = [call("a")];
    expect(settleToolCalls(quiet)).toBe(quiet);
    const start = call("a");
    const messages = [start, result("a")];
    const first = settleToolCalls(messages);
    const second = settleToolCalls([...messages]);
    expect(first[0]).toBe(second[0]);
    expect(first[0]).not.toBe(start);
    expect(first[1]).toBe(messages[1]);
    expect(start.props?.["status"]).toBeUndefined(); // 원본은 건드리지 않는다
  });
});

describe("행으로 그릴 메시지 (#4986)", () => {
  const closedCard = (): Message => row("tool_call", "card", { approval_id: "ap", status: "rejected", action_type: "tool_call", tool_name: "work.session.end" }, { type: "approval_request" as never, body: "승인 카드" });

  it("접히는 결과 줄도 호출을 닫는 근거다: 접기 전 목록으로 짝짓는다", () => {
    // 거부로 닫힌 카드가 같은 목록에 있어 이 결과 줄(`bundle_of`)은 접힌다. 그래도 호출은 중단으로 닫혀야 한다.
    const folded = result("a", { bundle_of: "ap", is_error: true, status: "rejected", approval_id: "ap" });
    const rows = presentableRows([call("a"), closedCard(), folded]);
    expect(rows.map((message) => message.id)).toEqual(["call-a", "card"]);
    expect(chip(rows[0]!)).toBe("cancelled");
  });

  it("호출만 있으면 손대지 않고, 접을 줄이 없으면 그대로 돌려준다", () => {
    const rows = presentableRows([call("a")]);
    expect(rows).toHaveLength(1);
    expect(chip(rows[0]!)).toBe("thinking");
    const text = row("tool_result", "plain", { call_id: "z", output: "x", is_error: false });
    expect(presentableRows([text]).map((message) => message.id)).toEqual(["plain"]);
  });
});

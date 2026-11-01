import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { agentCardModel } from "./agentCardModel";
import { presentableRows, settleToolCalls } from "./toolCallSettle";

// #4986. 서버는 `tool_call` 행을 한 번 쓰고 고치지 않는다(`{name, arguments, call_id}` 가 전부).
// 결과는 같은 `call_id` 의 `tool_result` 행으로 따로 온다. 결과가 이미 도착했는데도 호출 카드가
// 「생각 중」으로 남던 결함을, 목록이 가진 사실로 닫는다.
function row(type: Message["type"], id: string, props: Record<string, unknown>, extra: Partial<Message> = {}): Message {
  return {
    id, channelId: "channel-1", seq: 1, hlcTs: 1, hlcCount: 0, authorMemberId: "agent",
    type, body: type === "tool_call" ? "Tool call: work.session.end" : "done", state: "sent", createdAtMs: 1,
    props, ...extra,
  } as Message;
}
const call = (callId: string, extra: Record<string, unknown> = {}) => row("tool_call", `call-${callId}`, { name: "work.session.end", arguments: {}, call_id: callId, ...extra });
const result = (callId: string, extra: Record<string, unknown> = {}) => row("tool_result", `result-${callId}`, { call_id: callId, output: "ok", is_error: false, ...extra });
// 서버가 승인 카드에 싣는 모양: 처음부터 `call_id`·`tool_name` 이 있고, 끝나면 `approval_status`·`status` 를 한 패치로 함께
// 고친다(`approval.rs` `approval_request_props`, `decided_props_patch`). 결과 행은 따로 쓰지 않는다.
const approvalCard = (callId: string, status: string, extra: Record<string, unknown> = {}, over: Partial<Message> = {}) =>
  row("approval_request", `card-${callId}`, { approval_id: `ap-${callId}`, call_id: callId, tool_name: "work.session.end", action_type: "tool_call", approval_status: status, status, ...extra }, { body: "승인 카드", ...over });
const chip = (message: Message) => {
  const card = agentCardModel(message);
  if (card?.kind !== "tool") throw new Error("not a tool card");
  return card.status;
};
const toolCardOf = (message: Message) => {
  const card = agentCardModel(message);
  if (card?.kind !== "tool") throw new Error("not a tool card");
  return card;
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
    // 짝이 있는 결과 행은 호출 행의 이름을 빌린 사본이다(#5009). 이 사본도 같은 원본이면 같은 객체다.
    expect(first[1]).toBe(second[1]);
    expect(start.props?.["status"]).toBeUndefined(); // 원본은 건드리지 않는다
  });
});

describe("거부·만료·취소로 끝난 승인 카드는 같은 호출 카드를 중단으로 닫는다 (#5009)", () => {
  it.each(["rejected", "expired", "cancelled"])("%s 카드의 call_id 로 호출 카드가 닫힌다 — 결과 행이 하나도 없어도", (status) => {
    const messages = [call("a"), approvalCard("a", status)];
    const settled = settleToolCalls(messages);
    expect(chip(settled[0]!)).toBe("cancelled");
    expect(settled[1]).toBe(messages[1]); // 승인 카드는 그대로다
  });

  it("승인됨·대기 중 카드로는 닫지 않는다: 승인 뒤 실행 중일 수 있고 그 끝은 결과 행이 말한다", () => {
    expect(chip(settleToolCalls([call("a"), approvalCard("a", "approved")])[0]!)).toBe("thinking");
    expect(chip(settleToolCalls([call("a"), approvalCard("a", "pending")])[0]!)).toBe("thinking");
    // 승인됨 → 실행 → 결과 흐름은 지금처럼 결과 행으로 닫힌다.
    expect(chip(settleToolCalls([call("a"), approvalCard("a", "approved"), result("a")])[0]!)).toBe("done");
  });

  it("같은 호출에 결과 행과 종결 카드가 함께 있으면 결과 행이 이긴다", () => {
    expect(chip(settleToolCalls([call("a"), approvalCard("a", "rejected"), result("a")])[0]!)).toBe("done");
    expect(chip(settleToolCalls([call("a"), result("a", { is_error: true }), approvalCard("a", "expired")])[0]!)).toBe("error");
  });

  it("상태는 카드 모델과 같은 순서로 읽는다(approval_status → status), 다른 채널·지운 카드·call_id 없는 카드는 세지 않는다", () => {
    // `approval_status` 가 있으면 그것이 먼저다: 카드가 승인됨이라고 말하면 `status` 의 거부 흔적으로 닫지 않는다.
    expect(chip(settleToolCalls([call("a"), approvalCard("a", "approved", { status: "rejected" })])[0]!)).toBe("thinking");
    const statusOnly = approvalCard("a", "rejected");
    delete (statusOnly.props as Record<string, unknown>)["approval_status"];
    expect(chip(settleToolCalls([call("a"), statusOnly])[0]!)).toBe("cancelled");
    expect(chip(settleToolCalls([call("a"), approvalCard("a", "rejected", {}, { channelId: "channel-2" })])[0]!)).toBe("thinking");
    expect(chip(settleToolCalls([call("a"), approvalCard("a", "rejected", {}, { state: "deleted" })])[0]!)).toBe("thinking");
    expect(chip(settleToolCalls([call("a"), approvalCard("a", "rejected", { call_id: "" })])[0]!)).toBe("thinking");
  });
});

describe("결과 카드의 제목은 같은 call_id 의 호출 행 이름을 빌린다 (#5009)", () => {
  it("이름 없는 결과 행이 호출 행의 이름으로 제목을 말한다 — 「표시하지 않은 항목」 수는 그대로다", () => {
    const messages = [call("a"), result("a")];
    expect(toolCardOf(messages[1]!).title).toBe("도구 실행"); // 바탕: 빌리기 전
    const settled = settleToolCalls(messages);
    const card = toolCardOf(settled[1]!);
    expect(card.title).toBe("work.session.end 실행");
    // call_id · output 둘뿐이다. 빌려 온 `name` 은 제목에 그려지므로 숨김이 아니다.
    expect(card.detail.withheld).toBe(2);
    expect(toolCardOf(messages[1]!).detail.withheld).toBe(2);
  });

  it("자기 이름을 싣고 온 결과 행·짝이 없는 결과 행·다른 채널의 호출은 건드리지 않는다", () => {
    const own = result("a", { tool_name: "shell" });
    const kept = settleToolCalls([call("a"), own]);
    expect(kept[1]).toBe(own);
    expect(toolCardOf(kept[1]!).title).toBe("shell 실행");
    const lone = [result("a")];
    expect(settleToolCalls(lone)).toBe(lone);
    expect(toolCardOf(lone[0]!).title).toBe("도구 실행");
    const other = row("tool_call", "call-other", { name: "work.session.end", arguments: {}, call_id: "a" }, { channelId: "channel-2" });
    expect(toolCardOf(settleToolCalls([other, result("a")])[1]!).title).toBe("도구 실행");
  });

  it("빌려 준 사본은 같은 원본이면 같은 객체이고 원본은 건드리지 않는다(행이 다시 그려지지 않는다)", () => {
    const messages = [call("a"), result("a")];
    const first = settleToolCalls(messages);
    const second = settleToolCalls([...messages]);
    expect(first[1]).toBe(second[1]);
    expect(first[1]).not.toBe(messages[1]);
    expect(messages[1]!.props?.["name"]).toBeUndefined();
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

  it("종결 카드는 접히지 않고 호출 카드를 닫는다: 두 판정이 한 목록에서 함께 선다", () => {
    const rows = presentableRows([call("a"), approvalCard("a", "rejected")]);
    expect(rows.map((message) => message.id)).toEqual(["call-a", "card-a"]);
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

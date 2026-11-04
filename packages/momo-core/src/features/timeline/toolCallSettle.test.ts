import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { agentCardModel, agentRequestBundle } from "./agentCardModel";
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

  it("종결 카드는 접히지 않고, 그 승인이 걸린 호출 행이 접힌다: 한 장만 말한다 (#5066)", () => {
    const rows = presentableRows([call("a"), approvalCard("a", "rejected")]);
    expect(rows.map((message) => message.id)).toEqual(["card-a"]);
  });

  it("호출만 있으면 손대지 않고, 접을 줄이 없으면 그대로 돌려준다", () => {
    const rows = presentableRows([call("a")]);
    expect(rows).toHaveLength(1);
    expect(chip(rows[0]!)).toBe("thinking");
    const text = row("tool_result", "plain", { call_id: "z", output: "x", is_error: false });
    expect(presentableRows([text]).map((message) => message.id)).toEqual(["plain"]);
  });
});

// #5066 (검증 줄 1회차 H2). 도구 승인 하나를 호출 카드와 승인 카드가 서로 다른 상태로 말했다(결정 대기 내내 호출 카드는
// 「생각 중」, 기한이 지나도 서버가 정리하기 전까지 「생각 중」, 정리된 뒤엔 「중단됨」 대 「만료」). 이 시험은 두 장이
// 한 목록에서 한 장이 되는 규칙을 코어에서 잰다: 승인이 걸린 호출은 승인 카드가 말하고 호출 행은 접힌다.
describe("승인이 걸린 호출은 짝 승인 카드 한 장이 말한다 (#5066)", () => {
  const ids = (messages: Message[]) => presentableRows(messages).map((message) => message.id);

  it.each(["pending", "approved", "rejected", "expired", "cancelled"])(
    "%s 승인: 같은 call_id 의 호출 행이 접히고 승인 카드는 남는다 — 어느 국면에도 호출 카드가 따로 상태를 말하지 않는다",
    (status) => {
      expect(ids([call("a"), approvalCard("a", status)])).toEqual(["card-a"]);
    }
  );

  it("호출 행이 승인 카드보다 늦게 와도 목록 순서와 상관없이 접힌다", () => {
    expect(ids([approvalCard("a", "pending"), call("a")])).toEqual(["card-a"]);
  });

  it("짝을 알아볼 수 없으면 접지 않는다: 카드 없음 · 다른 call_id · 다른 채널 · 지운 카드 · 승인 id 없는 카드", () => {
    expect(ids([call("a")])).toEqual(["call-a"]);
    expect(ids([call("a"), approvalCard("b", "pending")])).toEqual(["call-a", "card-b"]);
    expect(ids([call("a"), approvalCard("a", "pending", {}, { channelId: "channel-2" })])).toEqual(["call-a", "card-a"]);
    expect(ids([call("a"), approvalCard("a", "pending", {}, { state: "deleted" })])).toEqual(["call-a", "card-a"]);
    expect(ids([call("a"), approvalCard("a", "pending", { approval_id: "" })])).toEqual(["call-a", "card-a"]);
  });

  it("호출 행만 접는다: 아직 끝나지 않은 승인의 결과 행·승인 카드·승인에 걸리지 않은 다른 호출은 그대로 선다", () => {
    // 승인됨 카드의 결과 행은 #5168 이 승인 카드로 접는다(아래 describe). 여기서는 접히지 않는 쪽만 잰다.
    expect(ids([call("a"), approvalCard("a", "pending"), result("a")])).toEqual(["card-a", "result-a"]);
    expect(ids([call("a"), approvalCard("a", "pending"), call("b")])).toEqual(["card-a", "call-b"]);
    expect(ids([approvalCard("a", "pending")])).toEqual(["card-a"]);
  });

  it("접힌 호출 행의 이름을 결과 카드가 빌린다: 접기는 짝짓기 뒤에 한다", () => {
    // 카드 스냅샷이 아직 대기인데 결과가 먼저 보이는 순간(결정 패치가 오기 전): 호출 행은 접히고, 승인 카드가 닫지 않은
    // 결과 줄은 접힌 호출 행의 이름으로 선다. 승인됨 카드의 결과 줄은 #5168 이 카드로 접는다(아래 describe).
    const rows = presentableRows([call("a"), approvalCard("a", "pending"), result("a")]);
    expect(rows.map((message) => message.id)).toEqual(["card-a", "result-a"]);
    expect(toolCardOf(rows[1]!).title).toBe("work.session.end 실행");
  });

  it("로그인 핸드오프 승인도 승인 카드 가족이라 그 호출 행을 접는다", () => {
    const handoff = approvalCard("a", "pending", { kind: "login_handoff", tool_name: "work.session.login_handoff" });
    expect(ids([call("a", { name: "work.session.login_handoff" }), handoff])).toEqual(["card-a"]);
  });
});


// #5168 (검증 줄 3회차, #5066의 다음 국면). 승인한 도구 호출은 결정 뒤 워커에서 실행되고, 끝은 같은 `call_id` 의 `tool_result`
// 행으로 따로 온다. 서버는 승인 카드를 그때 다시 고치지 않고(「실행 중 → 끝」은 run이 말한다, ADR-0186 v6 R-b 2), 클라이언트는
// 결정 뒤 run 을 그 카드에 잇지 못해서(진행 읽기는 승인을 기다리는 동안에만 승인 id 를 싣는다) 카드가 「실행 중」에 영영 머물렀고
// 결과 행은 카드가 한 장 더로 섰다. 이 시험은 두 장이 한 장이 되는 규칙을 코어에서 잰다: 승인됨 카드는 같은 호출의 결과로
// 「끝」·「실패」로 닫히고, 그 결과 행은 따로 서지 않는다. 카드를 읽는 말은 웹·폰이 같은 코어(`requestBundleState`)에서 읽는다.
describe("승인한 도구 호출은 같은 call_id 의 결과로 닫히고 결과 줄은 따로 서지 않는다 (#5168)", () => {
  const at = (message: Message, seq: number): Message => ({ ...message, seq });
  const started = () => at(call("a"), 1);
  const approved = (callId = "a", extra: Record<string, unknown> = {}, over: Partial<Message> = {}) =>
    at(approvalCard(callId, "approved", extra, over), 2);
  const finished = (callId = "a", extra: Record<string, unknown> = {}, over: Partial<Message> = {}): Message => ({
    ...result(callId, extra), seq: 3, ...over,
  });
  const stateOf = (message: Message) => agentRequestBundle(message, { nowMs: 1 })?.state;

  it("바탕: 승인됨 카드는 결과를 모르면 「실행 중」이다 — 완료를 추측하지 않는다", () => {
    const rows = presentableRows([started(), approved()]);
    expect(rows.map((message) => message.id)).toEqual(["card-a"]);
    expect(stateOf(rows[0]!)).toBe("executing");
  });

  it("같은 call_id 의 성공 결과가 오면 승인 카드가 「끝」으로 닫히고 결과 줄은 서지 않는다: 한 호출에 한 장", () => {
    const rows = presentableRows([started(), approved(), finished()]);
    expect(rows.map((message) => message.id)).toEqual(["card-a"]);
    expect(stateOf(rows[0]!)).toBe("done");
  });

  it("결과가 오류면 「실패」로 닫힌다", () => {
    const rows = presentableRows([started(), approved(), finished("a", { is_error: true, output: "권한이 없어요" })]);
    expect(rows.map((message) => message.id)).toEqual(["card-a"]);
    expect(stateOf(rows[0]!)).toBe("failed");
  });

  it("다른 call_id 의 결과는 카드를 닫지 않고 따로 선다", () => {
    const rows = presentableRows([started(), approved("a"), finished("b")]);
    expect(rows.map((message) => message.id)).toEqual(["card-a", "result-b"]);
    expect(stateOf(rows[0]!)).toBe("executing");
  });

  it.each(["pending", "rejected", "expired", "cancelled"])(
    "%s 카드는 닫지도 접지도 않는다: 카드는 원본 그대로이고 결과 줄이 남는다",
    (status) => {
      const card = at(approvalCard("a", status), 2);
      const rows = presentableRows([started(), card, finished()]);
      expect(rows.map((message) => message.id)).toEqual(["card-a", "result-a"]);
      expect(rows[0]).toBe(card);
    }
  );

  it.each<[string, () => Message[]]>([
    ["거부·만료로 닫힌 옛 결과 줄(`status`)", () => [approved(), finished("a", { is_error: true, status: "rejected", approval_id: "ap-a" })]],
    ["지운 결과", () => [approved(), finished("a", {}, { state: "deleted" })]],
    ["다른 채널의 결과", () => [approved(), finished("a", {}, { channelId: "channel-2" })]],
    ["카드보다 먼저 온 결과(같은 call_id 를 다시 쓴 앞 호출의 것)", () => [approved(), at(finished(), 1)]],
    ["행동 승인 카드", () => [approved("a", { action_type: "workspace_action" }), finished()]],
    ["로그인 핸드오프 카드", () => [approved("a", { kind: "login_handoff" }), finished()]],
    ["서버가 이미 result 를 쓴 카드", () => [approved("a", { result: { status: "executed" } }), finished()]],
    ["행동 결과 카드(`momo.action_result`)", () => [approved(), finished("a", { "momo.action_result": { v: 1, action_id: "channel.create", status: "executed", rows: [] } })]],
    ["승인 id 없는 카드", () => [approved("a", { approval_id: "" }), finished()]],
  ])("짝으로 세지 않는다 — %s: 결과 줄이 남고 카드는 원본 그대로다", (_name, build) => {
    const messages = build();
    const rows = presentableRows(messages);
    expect(rows.map((message) => message.id)).toContain("result-a");
    expect(rows[0]).toBe(messages[0]);
  });

  it("같은 call_id 를 다시 쓴 두 번째 승인은 자기 뒤에 온 결과로만 닫힌다", () => {
    const second = at(approvalCard("a", "approved", { approval_id: "ap-a2" }, { id: "card-a2" }), 4);
    const first = [approved(), finished()];
    // 둘째 카드는 앞 호출의 결과(seq 3)로 닫히지 않는다.
    const waiting = presentableRows([...first, second]);
    expect(waiting.map((message) => message.id)).toEqual(["card-a", "card-a2"]);
    expect([stateOf(waiting[0]!), stateOf(waiting[1]!)]).toEqual(["done", "executing"]);
    // 둘째의 결과가 오면 각자 자기 결과로 닫히고 두 결과 줄이 모두 접힌다.
    const both = presentableRows([...first, second, { ...finished(), id: "result-a2", seq: 5 }]);
    expect(both.map((message) => message.id)).toEqual(["card-a", "card-a2"]);
    expect([stateOf(both[0]!), stateOf(both[1]!)]).toEqual(["done", "done"]);
  });

  it("두 승인 뒤에 결과가 하나뿐이면 그 결과는 가까운 쪽(뒤 카드)의 것이다: 앞 카드는 결과를 못 받았으니 「실행 중」 그대로다", () => {
    const second = at(approvalCard("a", "approved", { approval_id: "ap-a2" }, { id: "card-a2" }), 4);
    const lateResult = { ...finished(), id: "result-late", seq: 5 };
    const rows = presentableRows([approved(), second, lateResult]);
    expect(rows.map((message) => message.id)).toEqual(["card-a", "card-a2"]);
    expect([stateOf(rows[0]!), stateOf(rows[1]!)]).toEqual(["executing", "done"]);
  });

  it("같은 원본이면 같은 사본을 돌려주고 원본은 건드리지 않는다(카드가 다시 그려지지 않는다)", () => {
    const messages = [started(), approved(), finished()];
    const first = presentableRows(messages)[0]!;
    const second = presentableRows([...messages])[0]!;
    expect(first).toBe(second);
    expect(first).not.toBe(messages[1]);
    expect(messages[1]!.props?.["result"]).toBeUndefined();
  });
});

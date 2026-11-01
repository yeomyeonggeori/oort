// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import { presentableRows } from "@momo/core/features/timeline/toolCallSettle";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { AgentCard } from "./AgentCard";

// =============================================================================
// #5009. 도구 호출 카드의 결과 자리와 제목. 판단은 코어(`presentableRows`·`toolCard`)가 하고, 이 시험은 웹 `AgentCard`
// 가 그 결과를 **실제로 그린 DOM** 에서 잰다: 서버의 영어 폴백 본문(「Tool call: …」)도, 끝난 호출의 빈 문장
// (「결과가 없습니다.」)도 화면에 없고, 진행 중 문구와 결과 카드 제목은 그대로 선다.
//
// 픽스처는 서버가 쓰는 모양 그대로다: 호출은 `{name, arguments, call_id}` + 영어 폴백 본문, 결과는 `{call_id, output,
// is_error}`, 거부·만료·취소로 끝난 승인은 결과 행 없이 승인 카드가 제자리에서 고쳐진다(`approval.rs`).
// =============================================================================

afterEach(cleanup);

const CHANNEL = "channel";
function row(type: Message["type"], id: string, seq: number, props: Record<string, unknown>, body: string): Message {
  return { id, channelId: CHANNEL, seq, hlcTs: seq, hlcCount: 0, authorMemberId: "agent", type, body, state: "sent", createdAtMs: seq, props } as Message;
}
const started = () => row("tool_call", "call", 1, { name: "work.session.end", arguments: {}, call_id: "c1" }, "Tool call: work.session.end");
const finished = () => row("tool_result", "result", 2, { call_id: "c1", output: "세션을 정리했어요", is_error: false }, "세션을 정리했어요");
// 끝난 승인 카드의 코드·문장은 서버가 정한 그대로다(`approval_outcome.rs` `outcome_code_and_line`).
const OUTCOME: Record<string, [code: string, line: string]> = {
  rejected: ["approval_rejected", "거부됐어요"],
  expired: ["approval_expired", "승인을 기다리다 만료됐어요"],
};
const settledApproval = (status: "rejected" | "expired") =>
  row("approval_request", "approval", 3, { approval_id: "ap-1", call_id: "c1", tool_name: "work.session.end", action_type: "tool_call", approval_status: status, status, code: OUTCOME[status]![0], title: "도구 「work.session.end」 실행", summary: OUTCOME[status]![1] }, OUTCOME[status]![1]);

/** 코어가 행으로 그릴 목록에서 한 행을 골라 웹 카드로 그린다(카드 모델 → `AgentCard`). */
function mountRow(messages: Message[], id: string) {
  const message = presentableRows(messages).find((row) => row.id === id);
  const card = message === undefined ? null : agentCardModel(message);
  if (card === null) throw new Error(`no card for ${id}`);
  return render(<AgentCard card={card} directory={makeDirectory([])} />);
}
const chip = () => screen.getByTestId("agent-status-chip");

describe("도구 호출 카드의 결과 자리 (#5009)", () => {
  it.each([
    ["결과로 끝난 호출", [started(), finished()], "done", "완료"],
    ["거부로 끝난 승인", [started(), settledApproval("rejected")], "cancelled", "중단됨"],
    ["만료로 끝난 승인", [started(), settledApproval("expired")], "cancelled", "중단됨"],
  ] as const)("끝난 호출(%s)은 영어 폴백도 빈 문장도 그리지 않고 상태 낱말은 칩이 말한다", (_name, messages, status, word) => {
    mountRow([...messages], "call");
    expect(chip().dataset.status).toBe(status);
    expect(chip().textContent).toBe(word);
    expect(screen.queryByTestId("agent-frame")).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Tool call");
    expect(text).not.toContain("결과가 없습니다");
  });

  it("아직 도는 호출은 지금 문구 「실행 중입니다.」를 유지하고 영어 폴백은 없다", () => {
    mountRow([started()], "call");
    expect(chip().dataset.status).toBe("thinking");
    expect(screen.getByTestId("agent-frame").textContent).toContain("실행 중입니다.");
    expect(document.body.textContent).not.toContain("Tool call");
  });
});

describe("결과 카드의 제목 (#5009)", () => {
  it("같은 call_id 의 호출 행 이름으로 제목을 말하고, 결과 문장은 그대로 그린다", () => {
    mountRow([started(), finished()], "result");
    expect(screen.getByTestId("agent-card").getAttribute("aria-label")).toBe("work.session.end 실행");
    expect(screen.getByTestId("agent-frame").textContent).toContain("세션을 정리했어요");
  });

  it("짝이 되는 호출 행이 목록에 없으면 지금 문구 그대로다", () => {
    mountRow([finished()], "result");
    expect(screen.getByTestId("agent-card").getAttribute("aria-label")).toBe("도구 실행");
  });
});

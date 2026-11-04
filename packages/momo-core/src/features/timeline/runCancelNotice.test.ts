import { describe, expect, it } from "vitest";
import {
  isRunCancelledNotice,
  RUN_CANCELLED_NOTICE_KIND,
} from "./runCancelNotice";

type Row = Parameters<typeof isRunCancelledNotice>[0];

function row(type: string, props?: Record<string, unknown>): Row {
  return { type, props } as Row;
}

describe("isRunCancelledNotice", () => {
  it("서버가 중단 때 남기는 줄이다: type 이 system 이고 props.kind 가 agent_run_cancelled", () => {
    // 서버가 싣는 모양 그대로(`agent_runs.rs`): kind 말고도 run·에이전트·멈춘 사람이 함께 실린다.
    expect(
      isRunCancelledNotice(
        row("system", {
          kind: "agent_run_cancelled",
          run_id: "run-1",
          agent_member_id: "agent-1",
          cancelled_by: "member-1",
        })
      )
    ).toBe(true);
    expect(RUN_CANCELLED_NOTICE_KIND).toBe("agent_run_cancelled");
  });

  it("다른 시스템 줄은 이 줄이 아니다", () => {
    for (const kind of ["agent_paused", "dm_agent_membership", "work_session_event", ""]) {
      expect(isRunCancelledNotice(row("system", { kind }))).toBe(false);
    }
    expect(isRunCancelledNotice(row("system"))).toBe(false);
    expect(isRunCancelledNotice(row("system", {}))).toBe(false);
    // 표식이 문자열이 아니면 같은 표식이 아니다.
    expect(isRunCancelledNotice(row("system", { kind: ["agent_run_cancelled"] }))).toBe(false);
    expect(isRunCancelledNotice(row("system", { kind: null }))).toBe(false);
  });

  it("사람이 보낸 글은 표식을 흉내 내도 이 줄이 아니다", () => {
    for (const type of ["text", "tool_call", "tool_result", "approval_request", "artifact"]) {
      expect(isRunCancelledNotice(row(type, { kind: "agent_run_cancelled" }))).toBe(false);
    }
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import type { AgentProgressEvent } from "@momo/core/lib/realtimeEvents";
import { endedRunIds, observeAgentProgress, resetEndedRuns } from "./endedRuns";

function status(
  runId: string,
  runStatus: string,
  phase = "thinking"
): AgentProgressEvent {
  return {
    type: "agent.status",
    v: 1,
    ts: 1,
    payload: {
      run_id: runId,
      agent_member_id: "a",
      channel_id: "c",
      phase,
      run_status: runStatus,
    },
  } as AgentProgressEvent;
}

describe("endedRuns", () => {
  beforeEach(() => {
    resetEndedRuns();
  });

  it("살아 있는 run 은 적지 않는다", () => {
    observeAgentProgress(status("r1", "running", "streaming"));
    observeAgentProgress(status("r2", "awaiting_approval"));
    expect(endedRunIds().size).toBe(0);
  });

  it("끝난 것을 본 run 만 적는다", () => {
    observeAgentProgress(status("R-CANCELLED", "cancelled"));
    observeAgentProgress(status("r-failed", "failed"));
    observeAgentProgress(status("r-ok", "succeeded"));
    // run id 는 대소문자 두 가지로 도는 값이라(`uuidEq` 가 존재하는 이유),
    // 이 집합의 열쇠는 항상 소문자다.
    expect([...endedRunIds()].sort()).toEqual([
      "r-cancelled",
      "r-failed",
      "r-ok",
    ]);
  });

  /**
   * **왜 「없음」이 아니라 「본 것」인가.** 레일은 끝난 run 을 트랙에서 지우므로,
   * 부재는 종결과 구별되지 않는다 — 새로고침 직후에도, 다른 탭에서 시작된 턴에도
   * 똑같이 부재다. 이 스토어를 부재 기반으로 바꾸면 지금 도착 중인 답에
   * 「응답이 끊김」이 붙는다.
   */
  it("본 적 없는 run 은 끝났다고 말하지 않는다", () => {
    observeAgentProgress(status("r1", "cancelled"));
    expect(endedRunIds().has("r1")).toBe(true);
    expect(endedRunIds().has("never-seen")).toBe(false);
  });

  it("세션이 바뀌면 아무것도 물려받지 않는다", () => {
    observeAgentProgress(status("r1", "cancelled"));
    resetEndedRuns();
    expect(endedRunIds().size).toBe(0);
  });
});

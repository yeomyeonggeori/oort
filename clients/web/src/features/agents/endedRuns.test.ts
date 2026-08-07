import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import type { Message } from "@momo/core/lib/api";
import type { AgentProgressEvent } from "@momo/core/lib/realtimeEvents";
import {
  endedStreamRunIds,
  isStreamRunEnded,
  STREAM_CUT_OFF_MARK,
  STREAM_PROPS_KEY,
  streamStopMark,
} from "@momo/core/features/timeline/streamStop";
import {
  endedRunIds,
  observeAgentProgress,
  resetEndedRuns,
  seedEndedRuns,
} from "./endedRuns";

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

  // ---- #1166 — 페이지 읽기가 심는 종결 ------------------------------------

  function orphan(runId: string, runEnded?: boolean): Message {
    return {
      id: "m1",
      channelId: "c1",
      seq: 7,
      hlcTs: 1,
      hlcCount: 0,
      authorMemberId: "agent",
      type: "text",
      body: "답을 절반쯤 쓰다가",
      state: "sent",
      createdAtMs: 1,
      props: { [STREAM_PROPS_KEY]: { rev: 9, streaming: true }, run_id: runId },
      ...(runEnded === undefined ? {} : { runEnded }),
    };
  }

  /**
   * **RED proof — 리로드 폐곡선.**
   *
   * 이 탭은 그 run 의 터미널 프레임을 본 적이 없다(새로고침이 그것을 지웠다).
   * 페이지가 들고 온 종결을 심지 않으면 아래 꼬리는 `null` 이고, 반쪽 답이
   * 완결된 답의 옷을 입는다 — ADR-0155 가 C안을 기각한 그 거짓말이다.
   */
  it("페이지가 들고 온 종결은 프레임을 못 본 탭에서도 꼬리를 세운다", () => {
    const row = orphan("RUN-A", true);
    expect(streamStopMark(row, isStreamRunEnded(row, endedRunIds()))).toBeNull();

    seedEndedRuns(endedStreamRunIds([row]));

    expect(endedRunIds().has("run-a")).toBe(true);
    expect(streamStopMark(row, isStreamRunEnded(row, endedRunIds()))).toBe(
      STREAM_CUT_OFF_MARK
    );
  });

  /**
   * **RED proof — 종결 아닌 run 은 표기될 수 없다.** 서버가 침묵한 행은
   * 씨앗을 하나도 내놓지 못하므로, 도착 중인 답은 도착 중인 채로 남는다.
   */
  it("서버가 말하지 않은 run 은 심지 않는다", () => {
    const live = orphan("run-live");
    seedEndedRuns(endedStreamRunIds([live]));
    expect(endedRunIds().size).toBe(0);
    expect(streamStopMark(live, isStreamRunEnded(live, endedRunIds()))).toBeNull();
  });

  it("빈 씨앗은 구독자를 깨우지 않는다", () => {
    observeAgentProgress(status("r1", "cancelled"));
    const before = endedRunIds();
    seedEndedRuns([]);
    seedEndedRuns(["r1"]);
    expect(endedRunIds()).toBe(before);
  });

  /**
   * 씨딩은 **머지 자리**에 있어야 한다. 웹 타임라인이 페이지를 긷는 곳은
   * 셋(첫 화면·위로 더 읽기·재연결 백필)이고 그 셋이 전부 `applyBatch` 를
   * 지난다 — 호출부마다 심게 옮기는 순간 언젠가 한 곳이 빠지고, 그 한 곳으로
   * 들어온 반쪽 답만 조용히 완결 행세를 한다. 폰은 훅을 통째로 지나는 테스트가
   * 이것을 재지만(`conversationTimeline.test.tsx`), 웹에는 훅 하네스가 없으므로
   * 배선 자체를 못으로 박는다.
   */
  it("타임라인 머지 자리가 종결을 심는다", () => {
    const source = readFileSync(
      new URL("../timeline/useTimeline.ts", import.meta.url),
      "utf8"
    );
    const applyBatch = source.slice(
      source.indexOf("const applyBatch = useCallback"),
      source.indexOf("const addMarker = useCallback")
    );
    expect(applyBatch).toContain("seedEndedRuns(endedStreamRunIds(batch))");
  });
});

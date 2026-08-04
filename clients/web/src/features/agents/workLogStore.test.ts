import { beforeEach, describe, expect, it } from "vitest";
import type { AgentProgressEvent } from "@momo/core/lib/realtimeEvents";
import {
  closeWorkPanel,
  openWorkPanel,
  recordAgentProgress,
  resetWorkLogs,
  watchWorkLog,
  workLogSnapshot,
  workPanelSnapshot,
} from "./workLogStore";

// =============================================================================
// 작업 패널 스토어 (goal WEB-WP1). 접는 규칙은 core가 갖고 있고 거기서 따로
// 검증된다. 여기서 지키는 것은 core가 알 수 없는 한 가지다: **보는 동안만 쌓고,
// 놓으면 사라진다**(D1 휘발 관전).
// =============================================================================

const RUN = "9F1C8B2A-0000-7000-8000-00000000RUN1";
const MEMBER = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const T0 = 1_785_238_400_000;

function delta(text: string, runId: string = RUN): AgentProgressEvent {
  return {
    type: "agent.partial",
    v: 1,
    ts: Date.now(),
    payload: { run_id: runId, channel_id: CHANNEL, text_delta: text },
  };
}

function target(runId: string = RUN) {
  return { runId, memberId: MEMBER, channelId: CHANNEL };
}

function textOf(runId: string = RUN): string {
  const log = workLogSnapshot().get(runId.toLowerCase());
  if (!log) return "";
  return log.entries
    .map((entry) => (entry.kind === "text" ? entry.text : ""))
    .join("");
}

beforeEach(() => {
  resetWorkLogs();
  closeWorkPanel();
});

describe("workLogStore: 보는 동안만 쌓는다", () => {
  it("아무도 안 보는 run의 프레임은 기록되지 않는다", () => {
    recordAgentProgress(delta("아무도 안 봄"));
    expect(workLogSnapshot().size).toBe(0);
  });

  it("구독하면 그때부터 쌓이고, 놓으면 사라진다", () => {
    const release = watchWorkLog(target(), T0);
    recordAgentProgress(delta("보이는 "));
    recordAgentProgress(delta("줄"));
    expect(textOf()).toBe("보이는 줄");

    release();
    expect(workLogSnapshot().size).toBe(0);

    // 놓은 뒤에 온 프레임은 어디에도 남지 않는다.
    recordAgentProgress(delta("놓은 뒤"));
    expect(workLogSnapshot().size).toBe(0);
  });

  it("다시 보면 그 시점부터 다시 쌓인다 (앞을 복원하지 않는다)", () => {
    const first = watchWorkLog(target(), T0);
    recordAgentProgress(delta("첫 번째 관전"));
    first();
    recordAgentProgress(delta("닫혀 있는 동안"));

    const second = watchWorkLog(target(), T0 + 1_000);
    recordAgentProgress(delta("두 번째 관전"));
    expect(textOf()).toBe("두 번째 관전");
    second();
  });

  it("다시 연 로그는 앞을 못 봤다고 계속 말한다", () => {
    const release = watchWorkLog(target(), T0);
    recordAgentProgress(delta("중간부터"));
    expect(workLogSnapshot().get(RUN.toLowerCase())?.truncatedHead).toBe(true);
    release();
  });
});

describe("workLogStore: 구독 참조 수", () => {
  it("두 구독자 중 하나가 놓아도 로그는 남는다", () => {
    const a = watchWorkLog(target(), T0);
    const b = watchWorkLog(target(), T0);
    recordAgentProgress(delta("살아 있음"));
    a();
    expect(textOf()).toBe("살아 있음");
    b();
    expect(workLogSnapshot().size).toBe(0);
  });

  it("같은 해제 함수를 두 번 불러도 남의 구독을 놓지 않는다", () => {
    const a = watchWorkLog(target(), T0);
    const b = watchWorkLog(target(), T0);
    a();
    a();
    expect(workLogSnapshot().size).toBe(1);
    b();
    expect(workLogSnapshot().size).toBe(0);
  });

  it("다른 run은 서로를 건드리지 않는다", () => {
    const other = "9F1C8B2A-0000-7000-8000-00000000RUN2";
    const a = watchWorkLog(target(), T0);
    const b = watchWorkLog(target(other), T0);
    recordAgentProgress(delta("첫째"));
    recordAgentProgress(delta("둘째", other));
    expect(textOf()).toBe("첫째");
    expect(textOf(other)).toBe("둘째");
    a();
    b();
  });

  it("run id는 대소문자를 접어서 맞춘다 (와이어가 섞어 보낸다)", () => {
    const release = watchWorkLog(target(RUN.toLowerCase()), T0);
    recordAgentProgress(delta("대문자 run id로 도착", RUN.toUpperCase()));
    expect(textOf()).toBe("대문자 run id로 도착");
    release();
  });
});

describe("workLogStore: 세션 경계", () => {
  it("리셋은 로그와 구독 수를 함께 비운다", () => {
    watchWorkLog(target(), T0);
    recordAgentProgress(delta("이전 워크스페이스"));
    resetWorkLogs();
    expect(workLogSnapshot().size).toBe(0);
    // 구독 수까지 비워졌으므로 새 워크스페이스의 첫 구독이 1부터 시작한다.
    const release = watchWorkLog(target(), T0);
    release();
    expect(workLogSnapshot().size).toBe(0);
  });
});

describe("workLogStore: 무엇을 열어 두었는가", () => {
  it("같은 run을 같은 자리에서 다시 열면 같은 인스턴스를 유지한다", () => {
    // 같은 값으로 다시 emit하면 useSyncExternalStore가 리렌더를 한 번 더 돈다.
    openWorkPanel({ ...target(), origin: "activity" });
    const first = workPanelSnapshot();
    openWorkPanel({ ...target(), origin: "activity" });
    expect(workPanelSnapshot()).toBe(first);
  });

  it("같은 run이라도 진입점이 다르면 새로 연 것으로 본다", () => {
    openWorkPanel({ ...target(), origin: "activity" });
    openWorkPanel({ ...target(), origin: "hub" });
    expect(workPanelSnapshot()?.origin).toBe("hub");
  });

  it("닫으면 비고, 이미 닫혀 있으면 아무 일도 하지 않는다", () => {
    openWorkPanel({ ...target(), origin: "hub" });
    closeWorkPanel();
    expect(workPanelSnapshot()).toBeNull();
    closeWorkPanel();
    expect(workPanelSnapshot()).toBeNull();
  });
});

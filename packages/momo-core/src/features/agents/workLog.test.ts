import { describe, expect, it } from "vitest";
import type {
  AgentPartialEvent,
  AgentPhaseWire,
  AgentRunStatusWire,
  AgentStatusEvent,
} from "../../lib/realtimeEvents";
import { IDLE_CUTOFF_MS } from "./workingSignal";
import {
  appendProgress,
  openWorkLog,
  toolEntryState,
  WORK_LOG_MAX_ARG_FIELDS,
  WORK_LOG_MAX_ENTRIES,
  WORK_LOG_MAX_TEXT_CHARS,
  workLogLiveness,
  workLogStateLabel,
  workPhaseLabel,
  type WorkLog,
  type WorkTextEntry,
  type WorkToolEntry,
} from "./workLog";

const RUN = "9F1C8B2A-0000-7000-8000-00000000RUN1";
const MEMBER = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const T0 = 1_785_238_400_000;

function log(nowMs = T0): WorkLog {
  return openWorkLog(
    { runId: RUN, memberId: MEMBER, channelId: CHANNEL },
    nowMs
  );
}

function status(
  phase: AgentPhaseWire,
  runStatus: AgentRunStatusWire,
  ts: number,
  extra: Partial<AgentStatusEvent["payload"]> = {}
): AgentStatusEvent {
  return {
    type: "agent.status",
    v: 1,
    ts,
    payload: {
      run_id: RUN,
      agent_member_id: MEMBER,
      channel_id: CHANNEL,
      phase,
      run_status: runStatus,
      ...extra,
    },
  };
}

function partial(
  ts: number,
  payload: Partial<AgentPartialEvent["payload"]>
): AgentPartialEvent {
  return {
    type: "agent.partial",
    v: 1,
    ts,
    payload: { run_id: RUN, channel_id: CHANNEL, ...payload },
  };
}

function textOf(entry: WorkLog["entries"][number]): string {
  return entry.kind === "text" ? entry.text : `<${entry.kind}>`;
}

describe("workLog — 델타 순서", () => {
  it("도착한 순서대로 이어 붙는다", () => {
    let l = log();
    for (const [index, slice] of ["배포 로그를 ", "먼저 ", "읽었습니다."].entries()) {
      l = appendProgress(l, partial(T0 + index, { text_delta: slice }), T0 + 100);
    }
    expect(l.entries).toHaveLength(1);
    expect(textOf(l.entries[0])).toBe("배포 로그를 먼저 읽었습니다.");
  });

  it("순서가 뒤집히면 문장이 달라진다 (게이트가 겨누는 실패)", () => {
    let forward = log();
    let reversed = log();
    const slices = ["가", "나", "다"];
    for (const slice of slices) {
      forward = appendProgress(forward, partial(T0, { text_delta: slice }), T0);
    }
    for (const slice of [...slices].reverse()) {
      reversed = appendProgress(reversed, partial(T0, { text_delta: slice }), T0);
    }
    expect(textOf(forward.entries[0])).toBe("가나다");
    expect(textOf(reversed.entries[0])).not.toBe("가나다");
  });

  it("같은 ts를 가진 델타도 순서를 잃지 않는다", () => {
    let l = log();
    for (const slice of ["1", "2", "3", "4"]) {
      l = appendProgress(l, partial(T0, { text_delta: slice }), T0);
    }
    expect(textOf(l.entries[0])).toBe("1234");
  });

  it("도구 단계가 끼면 텍스트 블록이 갈라지고 순서가 남는다", () => {
    let l = log();
    l = appendProgress(l, partial(T0, { text_delta: "앞" }), T0);
    l = appendProgress(
      l,
      partial(T0 + 1, { tool_call_id: "call-1", tool_call_name: "work.session.end" }),
      T0 + 1
    );
    l = appendProgress(l, partial(T0 + 2, { text_delta: "뒤" }), T0 + 2);
    expect(l.entries.map((e) => e.kind)).toEqual(["text", "tool", "text"]);
    expect(l.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(textOf(l.entries[0])).toBe("앞");
    expect(textOf(l.entries[2])).toBe("뒤");
  });

  it("`text`(전문)는 이어 붙이지 않고 대체한다", () => {
    let l = log();
    l = appendProgress(l, partial(T0, { text_delta: "가나" }), T0);
    l = appendProgress(l, partial(T0 + 1, { text: "가나다" }), T0 + 1);
    expect(textOf(l.entries[0])).toBe("가나다");
  });

  it("델타와 전문이 함께 오면 델타를 이어 붙인다", () => {
    let l = log();
    l = appendProgress(l, partial(T0, { text_delta: "가" }), T0);
    l = appendProgress(
      l,
      partial(T0 + 1, { text_delta: "나", text: "가나" }),
      T0 + 1
    );
    expect(textOf(l.entries[0])).toBe("가나");
  });
});

describe("workLog — phase 전이", () => {
  it("전이만 줄이 되고 keepalive는 늘어나지 않는다", () => {
    let l = log();
    l = appendProgress(l, status("queued", "queued", T0), T0);
    l = appendProgress(l, status("thinking", "running", T0 + 1), T0 + 1);
    l = appendProgress(l, status("thinking", "running", T0 + 2), T0 + 2);
    l = appendProgress(l, status("streaming", "running", T0 + 3), T0 + 3);
    expect(l.entries.map((e) => e.kind)).toEqual(["phase", "phase", "phase"]);
    expect(l.entries.map((e) => workPhaseLabel(e as never))).toEqual([
      "대기 중",
      "생각 중",
      "답을 쓰는 중",
    ]);
  });

  it("승인 대기는 작업 중이 아니다", () => {
    let l = log();
    l = appendProgress(l, status("thinking", "running", T0), T0);
    expect(l.state).toBe("working");
    l = appendProgress(l, status("thinking", "awaiting_approval", T0 + 1), T0 + 1);
    expect(l.state).toBe("awaiting_approval");
    expect(workLogStateLabel(l, workLogLiveness(l, T0 + 2))).toBe("승인 대기");
  });

  it("partial은 승인 대기를 작업 중으로 되돌리지 못한다", () => {
    let l = log();
    l = appendProgress(l, status("thinking", "awaiting_approval", T0), T0);
    l = appendProgress(
      l,
      partial(T0 + 1, { tool_call_id: "c", tool_call_name: "github.read" }),
      T0 + 1
    );
    expect(l.state).toBe("awaiting_approval");
  });

  it("종료 프레임은 닫고, 상태 문장을 종료 어휘로 바꾼다", () => {
    let l = log();
    l = appendProgress(l, status("thinking", "running", T0), T0);
    l = appendProgress(l, status("done", "succeeded", T0 + 5), T0 + 5);
    expect(l.closed?.runStatus).toBe("succeeded");
    expect(workLogLiveness(l, T0 + 10_000_000)).toBe("closed");
    expect(workLogStateLabel(l, "closed")).toBe("완료");
  });

  it("같은 종료 프레임이 다시 와도 완료 줄이 두 번 생기지 않는다", () => {
    let l = log();
    l = appendProgress(l, status("thinking", "running", T0), T0);
    l = appendProgress(l, status("done", "succeeded", T0 + 5), T0 + 5);
    const before = l.entries.length;
    l = appendProgress(l, status("done", "succeeded", T0 + 6), T0 + 6);
    expect(l.entries).toHaveLength(before);
    expect(l.closed?.atMs).toBe(T0 + 5);
  });
});

describe("workLog — 정직성", () => {
  it("여는 프레임을 못 보면 앞이 잘렸다고 말하고 시계를 그리지 않는다", () => {
    let l = log();
    l = appendProgress(l, status("streaming", "running", T0), T0);
    expect(l.truncatedHead).toBe(true);
    expect(l.startedAtMs).toBeUndefined();
  });

  it("여는 프레임을 첫 프레임으로 받으면 앞이 온전하고 시계가 생긴다", () => {
    let l = log();
    l = appendProgress(l, status("queued", "queued", T0), T0);
    expect(l.truncatedHead).toBe(false);
    expect(l.startedAtMs).toBe(T0);
  });

  it("이미 접은 뒤에 오는 queued는 앞이 온전하다는 근거가 아니다", () => {
    let l = log();
    l = appendProgress(l, partial(T0, { text_delta: "중간부터" }), T0);
    l = appendProgress(l, status("queued", "queued", T0 + 1), T0 + 1);
    expect(l.truncatedHead).toBe(true);
    expect(l.startedAtMs).toBeUndefined();
  });

  it("종료를 못 본 조용한 run은 완료가 아니라 신호 소실이다", () => {
    let l = log();
    l = appendProgress(l, status("streaming", "running", T0), T0);
    const later = T0 + IDLE_CUTOFF_MS + 1;
    expect(workLogLiveness(l, later)).toBe("signal_lost");
    expect(workLogStateLabel(l, "signal_lost")).toBe("신호 소실");
    expect(l.closed).toBeUndefined();
  });

  it("항목 상한을 넘기면 몇 개를 버렸는지 남긴다", () => {
    let l = log();
    for (let i = 0; i < WORK_LOG_MAX_ENTRIES + 7; i += 1) {
      l = appendProgress(
        l,
        partial(T0 + i, { tool_call_id: `call-${i}`, tool_call_name: "fs.read" }),
        T0 + i
      );
    }
    expect(l.entries).toHaveLength(WORK_LOG_MAX_ENTRIES);
    expect(l.droppedEntries).toBe(7);
  });

  it("긴 텍스트 블록은 뒤를 남기고 잘렸다고 표시한다", () => {
    let l = log();
    l = appendProgress(
      l,
      partial(T0, { text_delta: "가".repeat(WORK_LOG_MAX_TEXT_CHARS) }),
      T0
    );
    l = appendProgress(l, partial(T0 + 1, { text_delta: "끝" }), T0 + 1);
    const entry = l.entries[0] as WorkTextEntry;
    expect(entry.text).toHaveLength(WORK_LOG_MAX_TEXT_CHARS);
    expect(entry.text.endsWith("끝")).toBe(true);
    expect(entry.clipped).toBe(true);
  });
});

describe("workLog — 도구 단계", () => {
  it("인자 값은 로그에 들어오지 않는다. 이름과 개수만 남는다", () => {
    let l = log();
    l = appendProgress(
      l,
      partial(T0, {
        tool_call_id: "call-1",
        tool_call_name: "work.session.end",
        tool_call_args: { session: "A", path: "/Users/seongjae/secret" },
        tool_call_args_truncated: true,
      }),
      T0
    );
    const entry = l.entries[0] as WorkToolEntry;
    expect(entry.name).toBe("work.session.end");
    expect(entry.argsTruncated).toBe(true);
    expect(entry.argFields).toEqual(["session", "path"]);
    expect(entry.argFieldsHidden).toBe(0);
    expect(entry.argWithheld).toBe(2);
    // 값은 직렬화해도 어디에도 없다. 이것이 이 타입의 요점이다.
    expect(JSON.stringify(entry)).not.toContain("/Users/seongjae/secret");
    expect(JSON.stringify(entry)).not.toContain('"A"');
  });

  it("객체가 아닌 인자(문자열 프롬프트)는 이름 없이 하나로 센다", () => {
    let l = log();
    l = appendProgress(
      l,
      partial(T0, {
        tool_call_id: "call-1",
        tool_call_name: "agent.prompt",
        tool_call_args: "배포를 되돌려도 되는지 판단해 줘",
      }),
      T0
    );
    const entry = l.entries[0] as WorkToolEntry;
    expect(entry.argFields).toEqual([]);
    expect(entry.argWithheld).toBe(1);
    expect(JSON.stringify(entry)).not.toContain("되돌려도");
  });

  it("인자가 없으면 감출 것도 없다", () => {
    let l = log();
    l = appendProgress(
      l,
      partial(T0, { tool_call_id: "call-1", tool_call_name: "fs.list" }),
      T0
    );
    const entry = l.entries[0] as WorkToolEntry;
    expect(entry.argFields).toEqual([]);
    expect(entry.argWithheld).toBe(0);
  });

  it("키 자체가 경로/URL이면 이름도 접는다 (map형 인자, fail-closed)", () => {
    let l = log();
    l = appendProgress(
      l,
      partial(T0, {
        tool_call_id: "call-1",
        tool_call_name: "fs.patch",
        // map형 인자에서는 키가 스키마가 아니라 사람의 데이터다.
        tool_call_args: {
          "/Users/seongjae/projects/momo/secret-plan.md": "…",
          "https://internal.example/deploy?token=abc": "…",
          "C:\\Users\\seongjae\\notes.txt": "…",
          "~/.ssh/config": "…",
          "배포 되돌리기 절차": "…",
          dryRun: true,
        },
      }),
      T0
    );
    const entry = l.entries[0] as WorkToolEntry;
    // 안전한 식별자 하나만 남는다.
    expect(entry.argFields).toEqual(["dryRun"]);
    expect(entry.argFieldsHidden).toBe(5);
    expect(entry.argWithheld).toBe(6);
    const serialized = JSON.stringify(entry);
    for (const secret of [
      "secret-plan",
      "internal.example",
      "notes.txt",
      ".ssh",
      "되돌리기",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("이름 목록 상한을 넘어도 개수는 전부 센다", () => {
    const args: Record<string, string> = {};
    for (let i = 0; i < WORK_LOG_MAX_ARG_FIELDS + 5; i += 1) args[`k${i}`] = "v";
    let l = log();
    l = appendProgress(
      l,
      partial(T0, {
        tool_call_id: "call-1",
        tool_call_name: "fs.read",
        tool_call_args: args,
      }),
      T0
    );
    const entry = l.entries[0] as WorkToolEntry;
    expect(entry.argFields).toHaveLength(WORK_LOG_MAX_ARG_FIELDS);
    expect(entry.argFieldsHidden).toBe(5);
    expect(entry.argWithheld).toBe(WORK_LOG_MAX_ARG_FIELDS + 5);
  });

  it("같은 call_id의 후속 프레임은 자리를 옮기지 않는다", () => {
    let l = log();
    l = appendProgress(
      l,
      partial(T0, { tool_call_id: "call-1", tool_call_name: "fs.read" }),
      T0
    );
    l = appendProgress(l, partial(T0 + 1, { text_delta: "본문" }), T0 + 1);
    l = appendProgress(
      l,
      partial(T0 + 2, {
        tool_call_id: "call-1",
        tool_call_name: "fs.read",
        tool_call_args: { path: "a.ts" },
      }),
      T0 + 2
    );
    expect(l.entries.map((e) => e.kind)).toEqual(["tool", "text"]);
    expect((l.entries[0] as WorkToolEntry).argFields).toEqual(["path"]);
  });

  it("결과 프레임이 없으므로 마지막 단계만 진행 중이라고 말한다", () => {
    let l = log();
    l = appendProgress(
      l,
      partial(T0, { tool_call_id: "c1", tool_call_name: "fs.read" }),
      T0
    );
    l = appendProgress(
      l,
      partial(T0 + 1, { tool_call_id: "c2", tool_call_name: "github.read" }),
      T0 + 1
    );
    const [first, second] = l.entries as WorkToolEntry[];
    expect(toolEntryState(l, first, "live")).toBe("passed");
    expect(toolEntryState(l, second, "live")).toBe("running");
  });

  it("신호가 끊긴 순간 실행 중이던 단계는 다음 단계로 넘어갔다고 하지 않는다", () => {
    let l = log();
    l = appendProgress(
      l,
      partial(T0, { tool_call_id: "c1", tool_call_name: "fs.read" }),
      T0
    );
    const only = l.entries[0] as WorkToolEntry;
    // 뒤에 아무것도 오지 않았다. "다음 단계로"는 관측되지 않은 전이를 주장하는
    // 것이고, 결과도 모른다.
    expect(toolEntryState(l, only, "signal_lost")).toBe("unknown");
    expect(toolEntryState(l, only, "closed")).toBe("unknown");
  });
});

describe("workLog — 비용", () => {
  it("최신 스냅샷으로 갱신되고 누적 합을 지어내지 않는다", () => {
    let l = log();
    l = appendProgress(l, partial(T0, { spent_micro_usd: 1_200 }), T0);
    expect(l.spentMicroUsd).toBe(1_200);
    l = appendProgress(
      l,
      status("streaming", "running", T0 + 1, { spent_micro_usd: 4_800 }),
      T0 + 1
    );
    expect(l.spentMicroUsd).toBe(4_800);
  });

  it("비용을 싣지 않은 프레임이 비용을 지우거나 리렌더를 부르지 않는다", () => {
    let l = log();
    l = appendProgress(l, partial(T0 + 5, { spent_micro_usd: 1_200 }), T0 + 5);
    // 같은 (또는 더 이른) 시각에 비용 없이 온 프레임은 바꿀 것이 없다.
    const same = appendProgress(l, partial(T0 + 1, {}), T0 + 5);
    expect(same).toBe(l);
    expect(same.spentMicroUsd).toBe(1_200);
  });
});

describe("workLog — 무의미한 프레임", () => {
  it("다른 run의 프레임은 무시하고 같은 인스턴스를 돌려준다", () => {
    const l = log();
    const other = appendProgress(
      l,
      {
        type: "agent.partial",
        v: 1,
        ts: T0,
        payload: { run_id: "OTHER-RUN", channel_id: CHANNEL, text_delta: "x" },
      },
      T0
    );
    expect(other).toBe(l);
  });

  it("아무것도 담지 않은 뒤늦은 partial은 같은 인스턴스를 돌려준다", () => {
    let l = log(T0);
    l = appendProgress(l, partial(T0 + 10, { text_delta: "가" }), T0 + 10);
    const same = appendProgress(l, partial(T0 + 5, {}), T0 + 10);
    expect(same).toBe(l);
  });
});

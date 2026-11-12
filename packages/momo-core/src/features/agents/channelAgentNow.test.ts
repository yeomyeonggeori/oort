import { describe, expect, it } from "vitest";
import {
  agentRunActivePageFromWire,
  fetchAllActiveAgentRuns,
  type AgentRunActivePage,
  type AgentRunProgress,
} from "../../lib/api";
import { WireShapeError } from "../../lib/wire";
import { activityRail } from "./activityRail";
import { channelAgentNow } from "./channelAgentNow";
import { elapsedParts, elapsedSpan, signalFromProgress } from "./runPhase";

// =============================================================================
// 채널 멤버 패널의 에이전트 한 줄 (#5686). 시험이 붙드는 것:
//   - 이 채널의 run만 남는다(다른 채널의 run은 제목·수 모두 빠진다)
//   - 낱말은 입력창 레일과 같다(같은 run을 두 표면에 맞대어 본다)
//   - 단계는 작업 중에만, 없으면 요청 한 줄. 경과는 서버 시각에서 1분 단위
//   - 둘 이상이면 보이는 국면은 레일의 합치기 규칙, 그 국면의 가장 최근 것 + 수
//   - 「아직 받지 않았어요」 유예를 넘은 run은 레일처럼 빠진다
// =============================================================================

const CH = "00000000-0000-7000-8000-000000000201";
const OTHER = "00000000-0000-7000-8000-000000000202";
const GROK = "00000000-0000-7000-8000-000000000301";
const HERMES = "00000000-0000-7000-8000-000000000302";
const MIN = 60_000;
const NOW = 1_800_000_000_000;

let seq = 0;
function run(over: Partial<AgentRunProgress> = {}): AgentRunProgress {
  seq += 1;
  return {
    id: `0199aa11-2222-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    agentMemberId: GROK,
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 1,
    ahead: [],
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    triggerSummary: "@grok 설계 문서 정리해 줘",
    startedAtMs: NOW - 4 * MIN - 30_000,
    latestStage: "설계 문서 읽는 중",
    createdAtMs: NOW - 5 * MIN,
    updatedAtMs: NOW - MIN,
    ...over,
  };
}

describe("channelAgentNow (#5686)", () => {
  it("이 채널의 안 끝난 run만 줄이 된다: 다른 채널의 run은 줄도 수도 남기지 않는다", () => {
    const lines = channelAgentNow(
      [
        run(),
        run({ channelId: OTHER, latestStage: "다른 채널의 비밀 작업" }),
        run({ channelId: OTHER, agentMemberId: HERMES }),
      ],
      CH,
      NOW
    );
    expect([...lines.keys()]).toEqual([GROK]);
    const grok = lines.get(GROK)!;
    expect(grok.extra).toBe(0);
    expect(grok.stage).toBe("설계 문서 읽는 중");
    expect(JSON.stringify([...lines.values()])).not.toContain("다른 채널");
  });

  it("끝난 run은 줄이 아니다", () => {
    const lines = channelAgentNow(
      [run({ status: "succeeded", phase: "succeeded", finishedAtMs: NOW - MIN })],
      CH,
      NOW
    );
    expect(lines.size).toBe(0);
  });

  it("작업 중: 낱말·단계(에이전트 보고)·서버 시작 시각에서 잰 분", () => {
    const line = channelAgentNow([run()], CH, NOW).get(GROK)!;
    expect(line).toMatchObject({
      phase: "working",
      word: "작업 중",
      stage: "설계 문서 읽는 중",
      elapsed: { unit: "minute", count: 4 },
      active: true,
      needsHuman: false,
    });
    expect(line.request).toBeUndefined();
  });

  it("단계를 못 알리는 에이전트(Hermes·관리형)는 요청 한 줄을 한 줄로 접어 쓴다", () => {
    const line = channelAgentNow(
      [
        run({
          agentMemberId: HERMES,
          latestStage: undefined,
          triggerMessageId: undefined,
          triggerSummary: "배포 준비\n  체크리스트   돌리기",
        }),
      ],
      CH,
      NOW
    ).get(HERMES)!;
    expect(line.stage).toBeUndefined();
    expect(line.request).toBe("배포 준비 체크리스트 돌리기");
    expect(line.word).toBe("작업 중");
  });

  it("단계는 작업 중에만: 승인 대기에서는 단계 대신 요청 한 줄이다", () => {
    const line = channelAgentNow(
      [run({ status: "awaiting_approval", phase: "awaiting_approval" })],
      CH,
      NOW
    ).get(GROK)!;
    expect(line.phase).toBe("approval");
    expect(line.word).toBe("승인 필요");
    expect(line.needsHuman).toBe(true);
    expect(line.stage).toBeUndefined();
    expect(line.request).toBe("@grok 설계 문서 정리해 줘");
  });

  it("경과는 1분 미만이면 없고, 시작 전이면 서버가 받은 시각에서 잰다", () => {
    const fresh = channelAgentNow(
      [run({ startedAtMs: NOW - 59_000 })],
      CH,
      NOW
    ).get(GROK)!;
    expect(fresh.elapsed).toBeUndefined();
    const queued = channelAgentNow(
      [
        run({
          status: "queued",
          phase: "queued",
          startedAtMs: undefined,
          latestStage: undefined,
          createdAtMs: NOW - 3 * MIN,
        }),
      ],
      CH,
      NOW
    ).get(GROK)!;
    expect(queued.phase).toBe("received");
    expect(queued.word).toBe("받음");
    expect(queued.elapsed).toEqual({ unit: "minute", count: 3 });
    expect(queued.active).toBe(false);
  });

  it("「아직 받지 않았어요」 유예를 넘은 run은 레일처럼 빠진다", () => {
    const lines = channelAgentNow(
      [
        run({
          status: "queued",
          phase: "queued",
          startedAtMs: undefined,
          latestStage: undefined,
          createdAtMs: NOW - 6 * MIN,
        }),
      ],
      CH,
      NOW
    );
    expect(lines.size).toBe(0);
  });

  it("둘 이상이면 보이는 국면은 레일의 합치기 규칙(작업 중이 이긴다), 그 국면의 가장 최근 것 + 수", () => {
    const older = run({ latestStage: "옛 단계", createdAtMs: NOW - 20 * MIN, startedAtMs: NOW - 19 * MIN });
    const newer = run({ latestStage: "새 단계", createdAtMs: NOW - 8 * MIN, startedAtMs: NOW - 7 * MIN });
    // 방금 받은 요청: 가장 최근이지만 국면이 약하다. 이 run이 줄을 차지하면 「작업 중」인 에이전트가 「받음」으로 보인다.
    const justQueued = run({
      status: "queued",
      phase: "queued",
      startedAtMs: undefined,
      latestStage: undefined,
      createdAtMs: NOW - 30_000,
    });
    const line = channelAgentNow([older, justQueued, newer], CH, NOW).get(GROK)!;
    expect(line.word).toBe("작업 중");
    expect(line.runId).toBe(newer.id);
    expect(line.stage).toBe("새 단계");
    expect(line.elapsed).toEqual({ unit: "minute", count: 7 });
    expect(line.extra).toBe(2);
  });

  it("레일과 같은 낱말: 같은 run을 레일과 패널에 맞대면 국면 낱말이 같다", () => {
    const cases: Partial<AgentRunProgress>[] = [
      {},
      { status: "awaiting_approval", phase: "awaiting_approval" },
      { status: "paused", phase: "paused" },
      { status: "queued", phase: "claimed", claimedAtMs: NOW - MIN, startedAtMs: undefined },
      { status: "queued", phase: "queued", startedAtMs: undefined, createdAtMs: NOW - MIN },
    ];
    for (const over of cases) {
      const row = run(over);
      const panel = channelAgentNow([row], CH, NOW).get(GROK)!;
      const signal = signalFromProgress(row)!;
      const rail = activityRail([signal], () => ({ name: "grok" }), NOW)!;
      expect(panel.word).toBe(rail.lead.word);
      expect(panel.active).toBe(rail.lead.active);
      expect(panel.needsHuman).toBe(rail.lead.needsHuman);
    }
  });

  it("채널 id·에이전트 id의 대소문자를 가리지 않는다", () => {
    const lines = channelAgentNow([run({ agentMemberId: GROK.toUpperCase() })], CH.toUpperCase(), NOW);
    expect(lines.get(GROK)?.word).toBe("작업 중");
  });
});

describe("elapsedParts (#5686): elapsedSpan과 같은 문턱", () => {
  it("분·시간·일, 1분 미만은 없음", () => {
    expect(elapsedParts(NOW - 59_999, NOW)).toBeUndefined();
    expect(elapsedParts(NOW - MIN, NOW)).toEqual({ unit: "minute", count: 1 });
    expect(elapsedParts(NOW - 59 * MIN, NOW)).toEqual({ unit: "minute", count: 59 });
    expect(elapsedParts(NOW - 60 * MIN, NOW)).toEqual({ unit: "hour", count: 1 });
    expect(elapsedParts(NOW - 24 * 60 * MIN, NOW)).toEqual({ unit: "day", count: 1 });
    expect(elapsedSpan(NOW - 59 * MIN, NOW)).toBe("59분");
    expect(elapsedSpan(NOW - 60 * MIN, NOW)).toBe("1시간");
    expect(elapsedSpan(NOW - 24 * 60 * MIN, NOW)).toBe("1일");
  });
});

describe("「지금 실행 중」 읽기 (#5686)", () => {
  const wireRun = (id: string, channelId = CH) => ({
    id,
    channelId,
    agentMemberId: GROK.toUpperCase(),
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 0,
    ahead: [],
    createdAtMs: 1,
    updatedAtMs: 2,
  });

  it("행은 진행 읽기와 같은 모양으로 읽고, 에이전트별 수(`agents[]`)는 싣지 않는다", () => {
    const page = agentRunActivePageFromWire({
      runs: [wireRun("AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAA01")],
      agents: [{ agentMemberId: GROK, visible: { running: 1 }, activeTotal: 9 }],
      nextCursor: "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAA01",
    });
    expect(page.runs[0]!.agentMemberId).toBe(GROK);
    expect(page.nextCursor).toBe("aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaa01");
    expect(JSON.stringify(page)).not.toContain("activeTotal");
  });

  it("행 모양이 틀리면 형태 오류다(조용히 비우지 않는다)", () => {
    expect(() => agentRunActivePageFromWire({})).toThrow(WireShapeError);
    expect(() => agentRunActivePageFromWire({ runs: [{ id: "x" }] })).toThrow(WireShapeError);
  });

  it("다음 쪽을 상한까지 이어 읽고, 상한에 닿으면 멈추고 그 사실을 알린다", async () => {
    const asked: (string | undefined)[] = [];
    const pages: Record<string, AgentRunActivePage> = {
      first: { runs: [agentRunActivePageFromWire({ runs: [wireRun("a1")] }).runs[0]!], nextCursor: "c1" },
      c1: { runs: [agentRunActivePageFromWire({ runs: [wireRun("a2")] }).runs[0]!], nextCursor: "c2" },
      c2: { runs: [agentRunActivePageFromWire({ runs: [wireRun("a3")] }).runs[0]!], nextCursor: "c3" },
    };
    const fetchPage = async (_ws: string, options: { cursor?: string } = {}) => {
      asked.push(options.cursor);
      return pages[options.cursor ?? "first"]!;
    };
    const all = await fetchAllActiveAgentRuns("ws", { maxPages: 2, fetchPage });
    expect(all.runs.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(all.truncated).toBe(true);
    expect(all.pages).toBe(2);
    expect(asked).toEqual([undefined, "c1"]);

    asked.length = 0;
    const one = await fetchAllActiveAgentRuns("ws", {
      fetchPage: async (_ws, options = {}) => {
        asked.push(options.cursor);
        return { runs: pages.first!.runs };
      },
    });
    expect(one).toMatchObject({ truncated: false, pages: 1 });
    expect(asked).toEqual([undefined]);
  });

  it("같은 커서가 돌아오면 거기서 멈춘다", async () => {
    let calls = 0;
    const all = await fetchAllActiveAgentRuns("ws", {
      maxPages: 5,
      fetchPage: async () => {
        calls += 1;
        return { runs: [], nextCursor: "same" };
      },
    });
    expect(calls).toBe(2);
    expect(all.truncated).toBe(false);
  });
});

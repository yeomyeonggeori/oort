import { describe, expect, it } from "vitest";
import type { AgentRunProgress } from "../../lib/api";
import { agentRunProgressFromWire, agentRunProgressPageFromWire } from "../../lib/api";
import { asAgentRunEventFrame } from "../../lib/realtimeEvents";
import { WireShapeError } from "../../lib/wire";
import { activityLines, agentTurnBadgeCopy } from "./turnCopy";
import {
  endReasonText,
  isOpenRunPhase,
  runPhaseDetail,
  runPhaseLabel,
  serverFactsOf,
  signalFromProgress,
} from "./runPhase";
import {
  IDLE_CUTOFF_MS,
  isStaleSignal,
  mergeAgentWorkingSignals,
  resolveAgentWorkingSignals,
} from "./workingSignal";
import {
  appendProgress,
  openWorkLog,
  workLogLiveness,
  workLogStateLabel,
} from "./workLog";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const RUN = "0199aa11-2222-7000-8000-0000000000b2";

function progress(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    createdAtMs: NOW - 11 * MIN,
    updatedAtMs: NOW - 11 * MIN,
    ...extra,
  };
}

const names = () => ({ name: "그록봇" });

describe("서버 phase가 클라이언트 시계를 이긴다 (ADR-0200 D1)", () => {
  // 2026-10-13 실측: 11분 뒤에 수령되는 정상 run이 55초에 「신호 소실」로 보였다.
  // 이 시험을 되돌리면(isStaleSignal이 server를 무시하면) 첫 단정부터 실패한다.
  it("11분 동안 수령되지 않은 정상 run은 90초가 지나도 소실이 아니라 대기 중이다", () => {
    const signal = signalFromProgress(
      progress({ queuePosition: 2, aheadTotal: 1 })
    );
    expect(signal).not.toBeNull();
    if (signal === null) return;

    expect(NOW - signal.lastActivityAtMs).toBeGreaterThan(IDLE_CUTOFF_MS);
    expect(isStaleSignal(signal, NOW)).toBe(false);

    const resolved = resolveAgentWorkingSignals([signal], NOW);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].state).toBe("queued");

    const badge = agentTurnBadgeCopy(resolved, names);
    expect(badge?.text).toBe("대기 2번째");
    expect(badge?.text).not.toContain("작업 중");
    expect(badge?.text).not.toContain("신호 소실");
  });

  it("같은 신호에서 server를 빼면 90초에 걸러진다 (관리형·옛 서버의 규칙은 그대로)", () => {
    const signal = signalFromProgress(progress({ queuePosition: 1 }));
    if (signal === null) throw new Error("signal");
    const { server: _server, ...legacy } = signal;
    expect(isStaleSignal(legacy, NOW)).toBe(true);
    expect(resolveAgentWorkingSignals([legacy], NOW)).toEqual([]);
  });

  it("작업 패널도 서버가 열려 있다고 하면 시계로 소실을 말하지 않는다", () => {
    const log = openWorkLog({ runId: RUN, memberId: AGENT, channelId: CH }, NOW - 11 * MIN);
    const facts = serverFactsOf(progress({ queuePosition: 1 }));
    expect(workLogLiveness(log, NOW)).toBe("quiet");
    expect(workLogLiveness(log, NOW, IDLE_CUTOFF_MS, facts)).toBe("live");
    expect(workLogStateLabel(log, "live", facts)).toBe("대기 1번째");
  });

  it("서버 판정이 있는 run은 프레임이 말하는 상태와 달라도 서버가 이긴다", () => {
    // 프레임 접기는 queued 프레임 하나를 「작업 중」(옛 규칙)으로 읽었다.
    const log = appendProgress(
      openWorkLog({ runId: RUN, memberId: AGENT, channelId: CH }, NOW),
      {
        type: "agent.status",
        v: 1,
        ts: NOW,
        payload: {
          run_id: RUN,
          agent_member_id: AGENT,
          channel_id: CH,
          phase: "queued",
          run_status: "queued",
        },
      },
      NOW
    );
    expect(log.state).toBe("queued");
    expect(
      workLogStateLabel(log, "live", serverFactsOf(progress({ phase: "claimed" })))
    ).toBe("가져감");
  });
});

describe("상태 어휘: 대기 n번째 / 가져감 / 진행 / 승인 필요 / 끝(사유)", () => {
  it("phase마다 한 낱말", () => {
    const label = (extra: Partial<AgentRunProgress>) =>
      runPhaseLabel(serverFactsOf(progress(extra)));
    expect(label({ phase: "queued", queuePosition: 2 })).toBe("대기 2번째");
    expect(label({ phase: "queued" })).toBe("대기 중");
    expect(label({ phase: "claimed", leaseState: "live" })).toBe("가져감");
    expect(label({ phase: "running", leaseState: "live" })).toBe("작업 중");
    expect(label({ phase: "awaiting_approval" })).toBe("승인 필요");
    expect(label({ phase: "paused" })).toBe("일시 정지");
    expect(label({ phase: "succeeded" })).toBe("완료");
    expect(label({ phase: "failed" })).toBe("실패");
    expect(label({ phase: "cancelled" })).toBe("취소됨");
    expect(label({ phase: "timed_out", endReason: "approval_expired" })).toBe("만료");
  });

  it("「신호 소실」은 서버가 lease_abandoned로 끝냈다고 알릴 때만 나온다", () => {
    const lost = serverFactsOf(
      progress({ phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" })
    );
    expect(runPhaseLabel(lost)).toBe("신호 소실");
    // 같은 timed_out이어도 사유가 다르면 그 낱말을 쓰지 않는다.
    for (const endReason of ["approval_expired", "unclaimed_expired", undefined]) {
      const other = serverFactsOf(
        progress({ phase: "timed_out", status: "timed_out", ...(endReason ? { endReason } : {}) })
      );
      expect(runPhaseLabel(other)).not.toBe("신호 소실");
    }
    // 열려 있는 phase는 lease가 만료됐어도 소실이라 하지 않는다.
    const stale = serverFactsOf(
      progress({ phase: "claimed", status: "queued", leaseState: "stale", claimedAtMs: NOW - 30 * MIN })
    );
    expect(runPhaseLabel(stale)).toBe("가져감");
    expect(runPhaseDetail(stale, NOW)).toBe("가져간 뒤 30분째 소식이 없어요");
  });

  it("근거 줄은 서버가 준 사실만 말한다", () => {
    const queued = serverFactsOf(progress({ queuePosition: 3, aheadTotal: 2 }));
    expect(runPhaseDetail(queued, NOW)).toBe("11분째 기다려요 · 에이전트 앞에 2건");
    // 패널이 앞의 일을 따로 자세히 보일 때는 같은 건수를 두 번 말하지 않는다.
    expect(runPhaseDetail(queued, NOW, { omitAhead: true })).toBe("11분째 기다려요");
    const fresh = serverFactsOf(progress({ createdAtMs: NOW - 10_000, queuePosition: 1 }));
    // 1분 전에도 말한다(#3824): 「0분」을 지어내지 않고 초로 센다.
    expect(runPhaseDetail(fresh, NOW)).toBe("10초째 기다려요");
    const running = serverFactsOf(
      progress({ phase: "running", status: "running", leaseState: "live", lastEventAtMs: NOW - 4 * MIN })
    );
    // 시작 시각을 모르는 run의 작업 시간은 「모름」이다(가져간 때로 메우지 않는다).
    expect(runPhaseDetail(running, NOW)).toBe("작업 시간 모름 · 마지막 보고 4분 전");
  });

  it("종료 사유: 닫힌 코드만 문장이 되고 모르는 코드는 만들어 내지 않는다", () => {
    expect(endReasonText("approval_expired")).toBe("승인을 기다리다 만료됐어요");
    expect(endReasonText("unclaimed_expired")).toBe("아무도 가져가지 않아 끝냈어요");
    // ADR-0200 증보 3 E4(#4284): 새 닫힌 코드의 문장. 「아무도」(24시간 규칙)와 다른 사실이라 문장도 다르다.
    expect(endReasonText("woken_not_collected")).toBe("깨웠지만 가져가지 않아 끝냈어요");
    expect(endReasonText("woken_not_collected")).not.toBe(endReasonText("unclaimed_expired"));
    expect(endReasonText("cancelled_by_member")).toBe("멤버가 취소했어요");
    // 서버의 사람 중단(`POST …/agent-runs/{run}/cancel`)이 원장에 남기는 코드다.
    // 이 줄이 없으면 「취소됐어요」 아래 사유가 비어, 누가 멈췄는지 기록이 말하지 않는다.
    expect(endReasonText("human_cancelled")).toBe("사람이 중단했어요");
    expect(endReasonText("brand_new_code")).toBeUndefined();
    expect(endReasonText(undefined)).toBeUndefined();
  });

  it("끝난 run은 열린 턴 신호를 세우지 않는다", () => {
    for (const phase of ["succeeded", "failed", "timed_out", "cancelled"] as const) {
      expect(isOpenRunPhase(phase)).toBe(false);
      expect(signalFromProgress(progress({ phase }))).toBeNull();
    }
  });
});

describe("표면 낱말", () => {
  it("대기·가져감·진행·승인 필요가 알약에서 서로 다른 낱말이다", () => {
    const sig = (extra: Partial<AgentRunProgress>) => {
      const s = signalFromProgress(progress(extra));
      if (s === null) throw new Error("signal");
      return s;
    };
    const word = (extra: Partial<AgentRunProgress>) =>
      agentTurnBadgeCopy([sig(extra)], names)?.text;
    expect(word({ phase: "queued", queuePosition: 2 })).toBe("대기 2번째");
    expect(word({ phase: "claimed", leaseState: "live" })).toBe("가져감");
    expect(word({ phase: "running", status: "running", leaseState: "live" })).toBe("작업 중");
    expect(word({ phase: "awaiting_approval", status: "awaiting_approval" })).toBe("승인 필요");
  });

  it("컴포저 줄: 대기·가져감은 「작업 중」이 아니고, 진행 단계는 에이전트가 보고한 만큼이다", () => {
    const queued = signalFromProgress(progress({ queuePosition: 2 }));
    const running = signalFromProgress(
      progress({
        id: "0199aa11-2222-7000-8000-0000000000b3",
        phase: "running",
        status: "running",
        leaseState: "live",
        startedAtMs: NOW - 2 * MIN,
        latestStage: "채널 이름 확인",
      })
    );
    if (queued === null || running === null) throw new Error("signal");
    const q = activityLines([queued], names).lines[0];
    expect(q.state).toBe("queued");
    expect(q.startedAtMs).toBeUndefined();
    const r = activityLines([running], names).lines[0];
    expect(r.headline).toBe("채널 이름 확인");
    expect(r.startedAtMs).toBe(NOW - 2 * MIN);
  });

  it("한 에이전트의 여러 run은 working > 승인 필요 > 대기 순으로 접힌다", () => {
    const mk = (extra: Partial<AgentRunProgress>) => {
      const s = signalFromProgress(progress(extra));
      if (s === null) throw new Error("signal");
      return s;
    };
    const queued = mk({ id: "q", queuePosition: 1 });
    const waiting = mk({ id: "a", phase: "awaiting_approval", status: "awaiting_approval" });
    const working = mk({ id: "w", phase: "running", status: "running", leaseState: "live" });
    expect(mergeAgentWorkingSignals([queued, waiting])?.state).toBe("awaiting_approval");
    expect(mergeAgentWorkingSignals([queued, working])?.state).toBe("working");
    expect(mergeAgentWorkingSignals([queued, mk({ id: "q2", queuePosition: 2 })])?.server?.queuePosition).toBe(1);
  });
});

describe("서버 응답 파서", () => {
  const wire = {
    id: RUN.toUpperCase(),
    channelId: CH,
    agentMemberId: AGENT,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    queuePosition: 2,
    aheadTotal: 3,
    ahead: [{ runId: "0199AA11-2222-7000-8000-0000000000C1", channelId: CH }],
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };

  it("id는 소문자로 접고 ahead는 내 채널 것만 이름이 있다", () => {
    const parsed = agentRunProgressFromWire(wire);
    expect(parsed.id).toBe(RUN);
    expect(parsed.queuePosition).toBe(2);
    expect(parsed.aheadTotal).toBe(3);
    expect(parsed.ahead).toHaveLength(1);
  });

  it("모르는 phase나 깨진 모양은 조용히 통과시키지 않는다", () => {
    expect(() => agentRunProgressFromWire({ ...wire, phase: "teleporting" })).toThrow(WireShapeError);
    expect(() => agentRunProgressFromWire({ ...wire, leaseState: "dead" })).toThrow(WireShapeError);
    expect(() => agentRunProgressFromWire({ ...wire, queuePosition: -1 })).toThrow(WireShapeError);
    expect(() => agentRunProgressFromWire(null)).toThrow(WireShapeError);
  });
});

// 서버 DTO(`AgentRunBundleDto`, ADR-0186 v6 R-f #4763)가 내보내는 키 그대로: camelCase, `line`·`intent`는
// 있을 때만. 이 서버 계약을 파서가 읽어 `AgentRunProgress.bundle`로 싣는다.
describe("run 진행 bundle 파서 (#4763 서버 계약)", () => {
  const base = {
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    status: "awaiting_approval",
    phase: "awaiting_approval",
    leaseState: "live",
    stepCount: 1,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
  const bundleWire = {
    approvalId: "0199AA11-2222-7000-8000-0000000000C9",
    status: "pending",
    decisionMode: "inline",
    canDecide: true,
    line: "소개를 바꿔도 될까요?",
    intent: "소개를 바꿔도 될까요?",
    actionType: "workspace_action",
  };
  const parse = (bundle: unknown) => agentRunProgressFromWire({ ...base, bundle });

  it("서버 bundle을 있는 그대로 읽는다: 승인 id는 소문자로 접고 나머지 값은 서버 판정 그대로다", () => {
    expect(parse(bundleWire).bundle).toEqual({
      approvalId: "0199aa11-2222-7000-8000-0000000000c9",
      status: "pending",
      decisionMode: "inline",
      canDecide: true,
      actionType: "workspace_action",
      line: "소개를 바꿔도 될까요?",
      intent: "소개를 바꿔도 될까요?",
    });
  });

  it("옛 서버 응답(bundle 없음)은 bundle 키 자체가 없고 나머지는 예전 그대로 읽는다", () => {
    const parsed = agentRunProgressFromWire(base);
    expect("bundle" in parsed).toBe(false);
    expect(parsed.phase).toBe("awaiting_approval");
    // null도 「없음」이다(서버가 키를 null로 보내도 던지지 않는다).
    expect("bundle" in agentRunProgressFromWire({ ...base, bundle: null })).toBe(false);
  });

  it.each(["pending", "approved", "rejected", "expired", "cancelled"] as const)(
    "닫힌 다섯 상태 %s를 읽고, 결정 자격은 대기일 때만 남는다",
    (status) => {
      // 서버가 canDecide:true를 어긋나게 보내도(대기가 아닌데) 단추를 세우지 못하게 한 번 더 닫는다.
      const bundle = parse({ ...bundleWire, status }).bundle;
      expect(bundle?.status).toBe(status);
      expect(bundle?.canDecide).toBe(status === "pending");
    }
  );

  it("canDecide:false는 false로 남는다(서버가 보는 사람에게 못 한다고 말한 것)", () => {
    expect(parse({ ...bundleWire, canDecide: false }).bundle?.canDecide).toBe(false);
  });

  it("모르는 상태는 bundle 없음으로 읽고 던지지 않는다: 결정 자격도 함께 사라진다", () => {
    const run = parse({ ...bundleWire, status: "escalated", canDecide: true });
    expect(run.bundle).toBeUndefined();
    expect(run.phase).toBe("awaiting_approval");
  });

  it("뜻을 바꾸는 칸이 모자라거나 모양이 틀린 bundle은 없는 것으로 읽는다: 같은 쪽의 다른 run은 살아 있다", () => {
    const { approvalId: _a, ...noApproval } = bundleWire;
    const { actionType: _t, ...noAction } = bundleWire;
    for (const bad of [noApproval, noAction, { ...bundleWire, approvalId: "" }, "pending", ["pending"], 7]) {
      expect(parse(bad).bundle, JSON.stringify(bad)).toBeUndefined();
    }
    const runs = agentRunProgressPageFromWire({
      runs: [
        { ...base, id: "run-a", bundle: "깨짐" },
        { ...base, id: "run-b", bundle: bundleWire },
      ],
    });
    expect(runs.map((run) => run.bundle?.status)).toEqual([undefined, "pending"]);
  });

  it("권한만 줄이는 칸은 제한 쪽으로 읽는다: 모르거나 없는 decisionMode는 open, 없는 canDecide는 false", () => {
    const { decisionMode: _m, canDecide: _c, ...bare } = bundleWire;
    expect(parse(bare).bundle).toMatchObject({ decisionMode: "open", canDecide: false });
    expect(parse({ ...bundleWire, decisionMode: "sheet" }).bundle?.decisionMode).toBe("open");
    expect(parse({ ...bundleWire, canDecide: "yes" }).bundle?.canDecide).toBe(false);
  });

  it("끝난 승인의 line은 읽고 intent는 서버가 줄 때만 있다(앞뒤 공백은 접는다)", () => {
    const { intent: _i, ...settled } = { ...bundleWire, status: "approved", line: "  승인됐어요  " };
    const bundle = parse(settled).bundle;
    expect(bundle?.line).toBe("승인됐어요");
    expect(bundle && "intent" in bundle).toBe(false);
  });
});

describe("agent.run.event 프레임 (ADR-0200 D2)", () => {
  const frame = {
    type: "agent.run.event",
    v: 1,
    ts: NOW,
    payload: { run_id: RUN, channel_id: CH, kind: "stage" },
  };

  it("run id·채널 id·종류가 있으면 읽고, 단계 문자열은 싣지 않는 신호로만 쓴다", () => {
    expect(asAgentRunEventFrame(frame)?.payload.kind).toBe("stage");
    // 프레임은 재조회 신호일 뿐이다: 단계 문자열을 실어 와도 모양이 그것을 약속하지 않는다.
    expect(Object.keys(asAgentRunEventFrame(frame)?.payload ?? {}).sort()).toEqual([
      "channel_id",
      "kind",
      "run_id",
    ]);
  });

  it("다른 프레임·깨진 모양은 받지 않는다", () => {
    expect(asAgentRunEventFrame({ ...frame, type: "work.run.updated" })).toBeNull();
    expect(asAgentRunEventFrame({ ...frame, payload: { run_id: RUN } })).toBeNull();
    expect(asAgentRunEventFrame(null)).toBeNull();
    expect(asAgentRunEventFrame("agent.run.event")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { ApiError, type AgentProfile, type RosterMember, type WorkHost, type WorkSession } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { serverSurface } from "../capabilities/serverSurfaces";
import {
  agentProfileRead,
  agentStateLabel,
  allowedModelsSummary,
  hostTier,
  isAgentPaused,
  noSessionsDetail,
  PAUSE_EFFECT_NOTICE,
  pauseActionLabel,
  pauseEffectNotice,
  pauseFailureCopy,
  pauseReceipt,
  RESUME_EFFECT_NOTICE,
  RUNNING_SESSION_PILL,
  runningSessionCount,
  runningSessionMeta,
  sessionsForAgent,
  sessionSurvival,
} from "./agentOps";

// =============================================================================
// The judgements behind the phone's 「에이전트」 surface (goal RN-A1).
//
// The fixtures below are the SHAPES `server-rust` answers with, measured
// 2026-08-03 against the route table in `bins/momo-server/src/lib.rs` and the
// DTOs in `bins/momo-server/src/dto.rs`. Two of them are the whole reason this
// file exists:
//
//   - a roster row carries NO pause state (`RosterMemberDto` has no `paused`),
//     so the state word depends on a SECOND request that an ordinary member is
//     allowed to be refused;
//   - a work session carries NO host type (`WorkSessionDto` has `hostId` and
//     nothing else about the machine), so the D5 badge is a client-side join
//     that can come back empty-handed.
// =============================================================================

const WS = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "cccccccc-1111-4111-8111-cccccccccccc";

function agent(over: Partial<RosterMember> = {}): RosterMember {
  return {
    id: AGENT_ID,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 1,
    channelIds: ["ch-general"],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agentMemberId: AGENT_ID,
    workspaceId: WS,
    instructions: "",
    enabledTools: [],
    triggers: { mention: true },
    paused: false,
    version: 1,
    updatedBy: "someone",
    updatedAtMs: 0,
    ...over,
  };
}

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "SESSION-1",
    workspaceId: WS,
    channelId: "ch-general",
    memberId: AGENT_ID,
    hostId: "HOST-1",
    rootMessageId: "m-1",
    tool: "codex",
    label: "리팩터링",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: 1_000,
    ...over,
  };
}

function host(over: Partial<WorkHost> = {}): WorkHost {
  return {
    id: "HOST-1",
    workspaceId: WS,
    scope: "member",
    ownerMemberId: "11111111-1111-4111-8111-111111111111",
    type: "app",
    displayName: "성재의 맥",
    capabilities: {},
    createdAtMs: 0,
    online: true,
    ...over,
  };
}

describe("what this client learned about one agent's profile", () => {
  it("keeps a refusal apart from a failure", () => {
    // 403 is what an ordinary member gets for a perfectly healthy agent
    // (server-rust gates the profile read on owner/admin). Folding it into
    // "실패" would offer a retry that can only fail again.
    expect(agentProfileRead(undefined, false, new ApiError(403, "nope"))).toEqual({
      kind: "forbidden",
    });
    expect(agentProfileRead(undefined, false, new ApiError(401, "nope"))).toEqual({
      kind: "forbidden",
    });
    expect(agentProfileRead(undefined, false, new ApiError(500, "boom"))).toEqual({
      kind: "failed",
    });
    expect(
      agentProfileRead(undefined, false, new NetworkError("unreachable", 15_000))
    ).toEqual({ kind: "failed" });
  });

  it("prefers an answer it already has over either", () => {
    const read = agentProfileRead(profile({ paused: true }), true, new ApiError(500, "x"));
    expect(read.kind).toBe("ready");
    expect(isAgentPaused(read)).toBe(true);
  });

  it("reports pending as pending, and says nothing about pause", () => {
    expect(agentProfileRead(undefined, true, null)).toEqual({ kind: "pending" });
    expect(isAgentPaused({ kind: "pending" })).toBeNull();
    expect(isAgentPaused({ kind: "forbidden" })).toBeNull();
  });
});

describe("상태 한 줄", () => {
  it("uses the desktop hub's own words for the states they share", () => {
    // Not re-spelled here — `agentStateLabel` delegates to `lifecycleLabel`, so
    // the two clients cannot drift into two names for one state.
    expect(agentStateLabel(agent(), { kind: "ready", profile: profile() })).toBe("활성");
    expect(
      agentStateLabel(agent(), { kind: "ready", profile: profile({ paused: true }) })
    ).toBe("일시정지");
    expect(agentStateLabel(agent(), { kind: "pending" })).toBe("상태 확인 중");
    expect(agentStateLabel(agent(), { kind: "failed" })).toBe("상태 확인 실패");
  });

  it("lets membership suspension win over anything the profile says", () => {
    expect(
      agentStateLabel(agent({ status: "suspended" }), {
        kind: "ready",
        profile: profile(),
      })
    ).toBe("사용 중지");
  });

  it("says a refusal is a refusal", () => {
    expect(agentStateLabel(agent(), { kind: "forbidden" })).toBe("상태를 볼 수 없음");
  });
});

describe("재우기 / 깨우기", () => {
  it("states what pause actually reaches, and what it does not", () => {
    // Measured: pause writes one column and is read only by the three run
    // CREATION paths. The gateway routes never read it, so a claimed job runs
    // to completion — which is why the third sentence is here.
    expect(PAUSE_EFFECT_NOTICE).toContain("새 실행이 시작되지 않습니다");
    // 이 단정은 goal RN-C1에서 **고쳐졌지, 지워지지 않았다.**
    //
    // 예전 문장은 "이미 실행 중인 작업은 그대로 끝까지 갑니다"였고 두 가지를
    // 한꺼번에 뜻했다: ① 재우기는 도는 실행에 손대지 않는다 ② 멈출 방법이 아예
    // 없다. `POST …/agent-runs/{run}/cancel`이 이식되면서 ②만 거짓이 됐으므로
    // 잠가 둘 것은 ①이다 — 재우기가 무엇을 **하지 않는지**.
    expect(PAUSE_EFFECT_NOTICE).toContain("재우기로 멈추지 않습니다");
    // 그리고 이제는 사람이 무엇을 할 수 있는지도 말해야 한다. 생긴 길을 말하지
    // 않는 것은 없는 길을 있다고 말하는 것과 같은 크기의 거짓말이다.
    expect(PAUSE_EFFECT_NOTICE).toContain("중단할 수 있습니다");
    // 그렇다고 재우기를 취소로 재포장하지도 않는다. 이 세 줄이 그 경계다.
    //
    // `취소` 금지는 **원래 있던 잠금이고, 복원한 것이다.** RN-C1 첫 판이 그것을
    // 지웠는데 지울 이유가 없었다: 새 문장이 쓰는 낱말은 「중단」이고, 재우기를
    // 취소라고 부르는 것은 그때나 지금이나 같은 거짓말이다. cancel 라우트가 생겼다는
    // 사실은 **재우기가 무엇인지**를 하나도 바꾸지 않는다.
    expect(PAUSE_EFFECT_NOTICE).not.toContain("중지");
    expect(PAUSE_EFFECT_NOTICE).not.toContain("취소");
    expect(PAUSE_EFFECT_NOTICE).not.toContain("재우면 실행이 중단");
    expect(pauseEffectNotice(false)).toBe(PAUSE_EFFECT_NOTICE);
    expect(pauseEffectNotice(true)).toBe(RESUME_EFFECT_NOTICE);
  });

  it("names the act in both directions", () => {
    expect(pauseActionLabel(false, false)).toBe("재우기");
    expect(pauseActionLabel(true, false)).toBe("깨우기");
    expect(pauseActionLabel(false, true)).toBe("재우는 중…");
    expect(pauseActionLabel(true, true)).toBe("깨우는 중…");
  });

  it("explains a refusal instead of asking for a doomed retry", () => {
    const forbidden = pauseFailureCopy(true, new ApiError(403, "agent owner required"));
    expect(forbidden).toContain("재우지 못했습니다");
    expect(forbidden).toContain("워크스페이스 관리자나 그 에이전트를 맡은 사람만");
    expect(forbidden).not.toContain("다시 시도");
  });

  it("never leaks a status code or the server's English", () => {
    for (const error of [
      new ApiError(403, "agent owner or workspace admin required"),
      new ApiError(404, "active agent not found"),
      new ApiError(429, "slow down"),
      new ApiError(500, "internal server error"),
      new ApiError(418, "teapot"),
      new NetworkError("unreachable", 15_000),
      new Error("unexpected"),
    ]) {
      const copy = pauseFailureCopy(false, error);
      expect(copy).toMatch(/^깨우지 못했습니다\./);
      expect(copy).not.toMatch(/\d{3}/);
      expect(copy).not.toMatch(/[A-Za-z]{4}/);
    }
  });

  it("passes the core's own transport sentence through rather than paraphrasing", () => {
    // `NetworkError.message` is the core's own copy, deadline included. It is
    // handed through verbatim rather than re-worded, exactly as the sidebar's
    // DM failure does.
    const network = new NetworkError("timeout", 15_000);
    expect(network.message).toContain("15초");
    expect(pauseFailureCopy(true, network)).toContain(network.message);
  });

  it("writes a receipt that says what changed, with the right particle", () => {
    // 김인턴 ends in a consonant, 헤르메스 does not.
    expect(pauseReceipt("김인턴", true)).toContain("김인턴을 재웠습니다.");
    expect(pauseReceipt("헤르메스", true)).toContain("헤르메스를 재웠습니다.");
    expect(pauseReceipt("김인턴", true)).toContain(PAUSE_EFFECT_NOTICE);
    expect(pauseReceipt("김인턴", false)).toContain("김인턴을 깨웠습니다.");
  });
});

describe("고를 수 있는 모델", () => {
  it("lists what the server sent", () => {
    expect(allowedModelsSummary(["gpt-5.6", "claude-opus-5"])).toBe(
      "gpt-5.6, claude-opus-5"
    );
  });

  it("says the list is missing rather than showing an empty one", () => {
    // The decoder answers null for an absent, empty, blank or duplicated array,
    // exactly so this branch is reachable and cannot be mistaken for "no models".
    expect(allowedModelsSummary(null)).toBe(
      "이 서버가 고를 수 있는 모델 목록을 주지 않았습니다."
    );
  });
});

describe("호스트 등급", () => {
  it("names D5's three grades", () => {
    expect(hostTier(session(), [host({ type: "app" })])).toEqual({
      key: "app",
      label: "데스크톱 앱",
    });
    expect(hostTier(session(), [host({ type: "workd" })]).label).toBe("상시 서버");
    expect(hostTier(session(), [host({ type: "cloud" })]).label).toBe("클라우드");
  });

  it("folds a mixed-case host id, because ids cross this wire in both cases", () => {
    expect(hostTier(session({ hostId: "host-1" }), [host({ id: "HOST-1" })]).key).toBe(
      "app"
    );
  });

  it("refuses to name a host the registry never gave us", () => {
    for (const hosts of [undefined, [], [host({ id: "OTHER" })]]) {
      expect(hostTier(session(), hosts).key).toBe("unknown");
    }
  });

  it("treats a tier this client has never heard of as unknown", () => {
    expect(hostTier(session(), [host({ type: "quantum" })]).key).toBe("unknown");
  });
});

describe("지금 이거 꺼도 되나 — 세션 상태까지 읽고 답한다", () => {
  const APP = [host({ type: "app" })];
  const CLOUD = [host({ type: "cloud" })];

  it("gives D5's sentence to a session that is actually running", () => {
    const app = sessionSurvival(session({ status: "running" }), APP);
    expect(app.sentence).toBe("그 컴퓨터를 끄거나 앱을 닫으면 이 작업도 멈춥니다.");
    expect(app.atRisk).toBe(true);

    const cloud = sessionSurvival(session({ status: "running" }), CLOUD);
    expect(cloud.sentence).toContain("폰을 꺼도 계속됩니다");
    expect(cloud.atRisk).toBe(false);
  });

  it("says a FINISHED session is not at stake, whatever it ran on", () => {
    // R1 High-1: the first version printed the running sentence on every row, so
    // an ended session on a desktop host warned "이 작업도 멈춥니다" in orange
    // about work that was already over, and an ended cloud session promised it
    // would keep going. One card, two contradictory claims.
    for (const hosts of [APP, CLOUD, undefined]) {
      const over = sessionSurvival(session({ status: "ended" }), hosts);
      expect(over.sentence).toBe(
        "끝난 작업입니다. 지금 무엇을 꺼도 이 작업에는 영향이 없습니다."
      );
      expect(over.atRisk).toBe(false);
      expect(over.sentence).not.toContain("멈춥니다");
      expect(over.sentence).not.toContain("계속됩니다");
    }
  });

  it("talks about the SESSION, not a running job, once the run is idle", () => {
    // `idle` is not ended: the host still holds the session and its PTY. So
    // something is still at stake — just not a job in flight.
    const app = sessionSurvival(session({ status: "idle" }), APP);
    expect(app.sentence).toBe("그 컴퓨터를 끄거나 앱을 닫으면 이 세션도 닫힙니다.");
    expect(app.atRisk).toBe(true);

    const cloud = sessionSurvival(session({ status: "idle" }), CLOUD);
    expect(cloud.sentence).toBe(
      "이 세션은 클라우드가 들고 있습니다. 폰을 꺼도 남아 있습니다."
    );
    expect(cloud.atRisk).toBe(false);
  });

  it("tells an orphaned session where it can be picked up", () => {
    const lost = sessionSurvival(session({ status: "orphaned" }), APP);
    expect(lost.sentence).toContain("호스트와 연결이 끊겼습니다");
    expect(lost.sentence).toContain("데스크톱에서");
    expect(lost.atRisk).toBe(false);
  });

  it("refuses to answer for a LIVE session on a host it could not resolve", () => {
    for (const status of ["running", "idle"] as const) {
      const unknown = sessionSurvival(session({ status }), undefined);
      expect(unknown.tier.key).toBe("unknown");
      expect(unknown.sentence).toContain("무엇을 꺼도 되는지 말할 수 없습니다");
      expect(unknown.atRisk).toBe(false);
    }
  });

  it("answers an ENDED session even without the registry, because nothing is at stake", () => {
    expect(sessionSurvival(session({ status: "ended" }), undefined).sentence).toContain(
      "영향이 없습니다"
    );
  });

  it("refuses to answer for a state the ledger grew after this client shipped", () => {
    // Deliberately outside `WorkSessionStatusWire`: `sessionSurvival` takes a
    // widened `status: string` precisely so a fifth state cannot make it throw
    // or, worse, fall through to a reassuring branch.
    const odd = sessionSurvival({ ...session(), status: "hibernating" }, APP);
    expect(odd.sentence).toContain("말할 수 없습니다");
    expect(odd.atRisk).toBe(false);
  });
});

describe("「작업 중」은 이 화면의 말이 아니다", () => {
  it("names the ledger it read, not the state the web word means", () => {
    // R1 High-2: web's 작업 중 is an OPEN TURN on the realtime rail, and it is
    // explicitly NOT the word for a turn parked on an approval. The phone has no
    // rail; it has the session ledger. Same word, different fact = a defect.
    expect(RUNNING_SESSION_PILL).toBe("세션 실행 중");
    expect(RUNNING_SESSION_PILL).not.toContain("작업 중");
    expect(runningSessionMeta(2)).toBe("작업 세션 2개 실행 중");
    expect(runningSessionMeta(1)).not.toMatch(/작업 중/);
  });

  it("counts only this agent's running sessions", () => {
    const rows = [
      session({ id: "A", status: "running" }),
      session({ id: "B", status: "ended" }),
      session({ id: "C", status: "running", memberId: "dddddddd-1111-4111-8111-dddddddddddd" }),
    ];
    expect(runningSessionCount(rows, AGENT_ID)).toBe(1);
  });
});

describe("그 에이전트가 연 작업 세션", () => {
  it("matches on the member id, because agents ARE members", () => {
    const mine = session({ id: "A" });
    const someone = session({ id: "B", memberId: "dddddddd-1111-4111-8111-dddddddddddd" });
    expect(sessionsForAgent([mine, someone], AGENT_ID).map((s) => s.id)).toEqual(["A"]);
  });

  it("folds case on both sides", () => {
    expect(
      sessionsForAgent([session({ memberId: AGENT_ID.toUpperCase() })], AGENT_ID)
    ).toHaveLength(1);
  });

  it("will not call an empty list silence while the run history is unreadable", () => {
    expect(noSessionsDetail(false)).toContain("조용한 것인지 안 보이는 것인지는");
    expect(noSessionsDetail(true)).toBe("이 에이전트가 연 작업 세션이 없습니다.");
    expect(noSessionsDetail(true)).not.toContain("조용한 것인지");
  });

  it("borrows the absent-surface words instead of writing a second copy", () => {
    // R1 Low-3: the screen used to assemble this sentence itself, so the same
    // copy had two definitions. `serverSurfaces` is where a batch that ports the
    // route flips one line, and a second copy would survive that flip.
    const surface = serverSurface("agentRunHistory");
    expect(noSessionsDetail(false)).toContain(surface.absentReason);
    expect(noSessionsDetail(false)).toContain(surface.fallback);
  });
});

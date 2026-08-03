import { describe, expect, it } from "vitest";
import { ApiError, type AgentProfile, type RosterMember, type WorkHost, type WorkSession } from "../../lib/api";
import { NetworkError } from "../../lib/http";
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
  sessionsForAgent,
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
    expect(PAUSE_EFFECT_NOTICE).toContain("이미 실행 중인 작업은 그대로 끝까지 갑니다");
    expect(PAUSE_EFFECT_NOTICE).not.toContain("중지");
    expect(PAUSE_EFFECT_NOTICE).not.toContain("취소");
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

describe("호스트 등급 — 지금 이거 꺼도 되나", () => {
  it("answers D5's sentence for a desktop-app host", () => {
    const tier = hostTier(session(), [host({ type: "app" })]);
    expect(tier.key).toBe("app");
    expect(tier.label).toBe("데스크톱 앱");
    expect(tier.survival).toContain("컴퓨터를 끄거나 앱을 닫으면 이 작업도 멈춥니다");
  });

  it("answers it the other way for workd and cloud", () => {
    for (const type of ["workd", "cloud"] as const) {
      const tier = hostTier(session(), [host({ type })]);
      expect(tier.key).toBe(type);
      expect(tier.survival).toContain("폰을 꺼도 계속됩니다");
    }
  });

  it("folds a mixed-case host id, because ids cross this wire in both cases", () => {
    expect(hostTier(session({ hostId: "host-1" }), [host({ id: "HOST-1" })]).key).toBe(
      "app"
    );
  });

  it("refuses to guess when the registry was not read, or does not name the host", () => {
    for (const hosts of [undefined, [], [host({ id: "OTHER" })]]) {
      const tier = hostTier(session(), hosts);
      expect(tier.key).toBe("unknown");
      expect(tier.survival).toContain("확인하지 못했습니다");
    }
  });

  it("treats a tier this client has never heard of as unanswerable", () => {
    expect(hostTier(session(), [host({ type: "quantum" })]).key).toBe("unknown");
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
    expect(noSessionsDetail(true)).not.toContain("조용한 것인지");
  });
});

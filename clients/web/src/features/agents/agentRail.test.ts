import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "@/lib/api";
import type { AgentPartialEvent, AgentStatusEvent } from "@/lib/realtime";
import { centrifugoAgentChannelName } from "@/lib/realtime";
import {
  agentSubscriptionPairs,
  applyAgentEvent,
  candidatesFrom,
  isRunOver,
  parseSubscriptionKey,
  pruneTracks,
  subscriptionKey,
  type RunTracks,
} from "./agentRail";
import {
  resolveAgentWorkingSignals,
  ZOMBIE_CLEAR_MS,
} from "./agentWorkingSignal";
import {
  rotatingActivityLines,
  staticActivityLines,
  activityText,
} from "./activityLine";

const WS = "00000000-0000-7000-8000-000000000001";
const GENERAL = "00000000-0000-7000-8000-000000000201";
const LAB = "00000000-0000-7000-8000-000000000202";
const DM = "019f984d-b4a8-76fd-8fba-3b6e3390072d";
const HERMES = "00000000-0000-7000-8000-000000000103";
const KIM = "00000000-0000-7000-8000-000000000102";
const HUMAN = "00000000-0000-7000-8000-000000000101";
// Swift `uuidString` is UPPERCASE, and momowebqa publishes run ids that way
// while channel ids come back lowercase in the same payload.
const RUN = "019F994E-6B8D-7F13-A324-EC4B954F2635";
const NOW = 1_784_983_000_000;

function channel(id: string, kind: Channel["kind"] = "public"): Channel {
  return { id, workspaceId: WS, kind, muted: false };
}

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "Hermes",
    handle: "hermes",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

function status(over: Partial<AgentStatusEvent["payload"]> = {}): AgentStatusEvent {
  return {
    type: "agent.status",
    v: 1,
    ts: NOW,
    payload: {
      run_id: RUN,
      agent_member_id: HERMES,
      channel_id: LAB,
      phase: "thinking",
      run_status: "running",
      ...over,
    },
  };
}

function partial(
  over: Partial<AgentPartialEvent["payload"]> = {}
): AgentPartialEvent {
  return {
    type: "agent.partial",
    v: 1,
    ts: NOW,
    payload: { run_id: RUN, channel_id: LAB, ...over },
  };
}

const CONTEXT = { memberId: HERMES, channelId: LAB };

describe("centrifugoAgentChannelName", () => {
  it("matches the exact-channel name the subscribe proxy authorises", () => {
    expect(centrifugoAgentChannelName(WS, LAB, HERMES)).toBe(
      `agent:ws${WS.toUpperCase()}.${LAB.toUpperCase()}.${HERMES.toUpperCase()}`
    );
  });
});

describe("agentSubscriptionPairs", () => {
  const agents = [
    member({
      id: HERMES,
      channelIds: [GENERAL, LAB],
    }),
    member({
      id: KIM,
      displayName: "김인턴",
      handle: "kim-intern",
      channelIds: [GENERAL.toUpperCase(), DM],
    }),
  ];
  const channels = [channel(GENERAL), channel(LAB), channel(DM, "dm")];

  it("watches exactly the (channel, agent) memberships, case-folded", () => {
    // Channel order as given, then agent id ascending: KIM (…102) before
    // HERMES (…103), so the cap always removes the same tail.
    expect(agentSubscriptionPairs(channels, agents)).toEqual([
      { channelId: GENERAL, memberId: KIM },
      { channelId: GENERAL, memberId: HERMES },
      { channelId: LAB, memberId: HERMES },
      { channelId: DM, memberId: KIM },
    ]);
  });

  it("never watches a human, a suspended agent, or a channel the agent left", () => {
    const pairs = agentSubscriptionPairs(channels, [
      member({ id: HUMAN, kind: "human", channelIds: [GENERAL, LAB] }),
      member({ id: KIM, status: "suspended", channelIds: [GENERAL] }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("caps the fan-out and cuts the same tail every time", () => {
    const capped = agentSubscriptionPairs(channels, agents, 2);
    expect(capped).toEqual([
      { channelId: GENERAL, memberId: KIM },
      { channelId: GENERAL, memberId: HERMES },
    ]);
    expect(subscriptionKey(capped)).toBe(
      subscriptionKey(agentSubscriptionPairs(channels, agents, 2))
    );
  });

  it("keys the same memberships identically so a refetch does not resubscribe", () => {
    const again = agentSubscriptionPairs(
      channels,
      agents.map((a) => ({ ...a, updatedAtMs: 1 }))
    );
    expect(subscriptionKey(again)).toBe(
      subscriptionKey(agentSubscriptionPairs(channels, agents))
    );
  });

  it("round-trips through its key, so the effect can subscribe from the key", () => {
    const pairs = agentSubscriptionPairs(channels, agents);
    expect(parseSubscriptionKey(subscriptionKey(pairs))).toEqual(
      pairs.map((p) => ({
        channelId: p.channelId.toLowerCase(),
        memberId: p.memberId.toLowerCase(),
      }))
    );
    expect(parseSubscriptionKey("")).toEqual([]);
  });
});

describe("isRunOver", () => {
  it("ends the turn on a terminal run status or a done/error phase", () => {
    expect(isRunOver("succeeded", "streaming")).toBe(true);
    expect(isRunOver("failed", "thinking")).toBe(true);
    expect(isRunOver("cancelled", "thinking")).toBe(true);
    expect(isRunOver("timed_out", "thinking")).toBe(true);
    expect(isRunOver("running", "done")).toBe(true);
    expect(isRunOver("running", "error")).toBe(true);
  });

  it("keeps awaiting_approval alive: the run is open, just unanswered", () => {
    expect(isRunOver("awaiting_approval", "thinking")).toBe(false);
    expect(isRunOver("queued", "queued")).toBe(false);
    expect(isRunOver("paused", "thinking")).toBe(false);
  });
});

describe("applyAgentEvent", () => {
  it("starts the clock on the first frame and holds it across later ones", () => {
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(tracks, status({ phase: "queued", run_status: "queued" }), CONTEXT, NOW);
    tracks = applyAgentEvent(tracks, status({ phase: "streaming" }), CONTEXT, NOW + 8_000);
    const track = tracks.get(RUN.toLowerCase());
    expect(track?.startedAtMs).toBe(NOW);
    expect(track?.lastActivityAtMs).toBe(NOW + 8_000);
  });

  it("keys runs case-insensitively so an UPPERCASE run id is not a second turn", () => {
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(tracks, status(), CONTEXT, NOW);
    tracks = applyAgentEvent(
      tracks,
      status({ run_id: RUN.toLowerCase() }),
      CONTEXT,
      NOW + 1_000
    );
    expect(tracks.size).toBe(1);
  });

  it("attributes a partial to the agent whose channel it arrived on", () => {
    // agent.partial carries no agent_member_id; only the subscription knows.
    const tracks = applyAgentEvent(new Map(), partial({ text: "안녕" }), CONTEXT, NOW);
    expect(tracks.get(RUN.toLowerCase())?.memberId).toBe(HERMES);
  });

  it("takes the headline from the cumulative text, last line first", () => {
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(tracks, partial({ text_delta: "김인턴 mock reply: " , text: "김인턴 mock reply: " }), CONTEXT, NOW);
    tracks = applyAgentEvent(
      tracks,
      partial({ text_delta: "path verified.", text: "김인턴 mock reply: MOMO-004 SSE path verified." }),
      CONTEXT,
      NOW + 200
    );
    expect(tracks.get(RUN.toLowerCase())?.headline).toBe(
      "김인턴 mock reply: MOMO-004 SSE path verified."
    );
  });

  it("keeps the last headline through a tool-call partial that carries no text", () => {
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(tracks, partial({ text: "빌드 확인 중" }), CONTEXT, NOW);
    tracks = applyAgentEvent(
      tracks,
      partial({ tool_call_name: "github.search_issues" }),
      CONTEXT,
      NOW + 100
    );
    const track = tracks.get(RUN.toLowerCase());
    expect(track?.headline).toBe("빌드 확인 중");
    expect(track?.lastActivityAtMs).toBe(NOW + 100);
  });

  it("drops the run on a terminal frame so every surface clears together", () => {
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(tracks, status(), CONTEXT, NOW);
    tracks = applyAgentEvent(
      tracks,
      status({ phase: "done", run_status: "succeeded" }),
      CONTEXT,
      NOW + 3_000
    );
    expect(tracks.size).toBe(0);
    expect(resolveAgentWorkingSignals(candidatesFrom(tracks), NOW + 3_000)).toEqual([]);
  });

  it("returns the same table for a terminal frame about an unknown run", () => {
    const tracks: RunTracks = new Map();
    expect(applyAgentEvent(tracks, status({ phase: "done" }), CONTEXT, NOW)).toBe(
      tracks
    );
  });

  it("carries a real momowebqa turn through to a resolved signal", () => {
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(tracks, status({ phase: "queued", run_status: "queued" }), CONTEXT, NOW);
    tracks = applyAgentEvent(tracks, status({ phase: "thinking" }), CONTEXT, NOW + 8);
    tracks = applyAgentEvent(tracks, status({ phase: "streaming" }), CONTEXT, NOW + 11);
    tracks = applyAgentEvent(
      tracks,
      partial({ text: "김인턴 mock reply: MOMO-004 SSE path verified." }),
      CONTEXT,
      NOW + 120
    );
    tracks = applyAgentEvent(
      tracks,
      status({ phase: "thinking", run_status: "awaiting_approval", detail: "github.search_issues" }),
      CONTEXT,
      NOW + 230
    );
    const [signal] = resolveAgentWorkingSignals(candidatesFrom(tracks), NOW + 1_000);
    expect(signal.memberId).toBe(HERMES);
    expect(signal.channelId).toBe(LAB);
    expect(signal.startedAtMs).toBe(NOW);
    expect(signal.headlines).toEqual([
      "김인턴 mock reply: MOMO-004 SSE path verified.",
    ]);
    // The tool name is internal vocabulary and never becomes a headline (§7).
    expect(signal.headlines.join(" ")).not.toContain("github.search_issues");
  });
});

describe("pruneTracks", () => {
  it("forgets a run whose terminal frame never arrived", () => {
    const tracks = applyAgentEvent(new Map(), status(), CONTEXT, NOW);
    expect(pruneTracks(tracks, NOW + ZOMBIE_CLEAR_MS, ZOMBIE_CLEAR_MS)).toBe(tracks);
    expect(
      pruneTracks(tracks, NOW + ZOMBIE_CLEAR_MS + 1, ZOMBIE_CLEAR_MS).size
    ).toBe(0);
  });
});

describe("composer activity lines", () => {
  const nameFor = (id: string) => (id === HERMES ? "Hermes" : "김인턴");
  const working = resolveAgentWorkingSignals(
    [
      {
        memberId: HERMES,
        channelId: LAB,
        source: "status",
        startedAtMs: NOW - 30_000,
        headlines: ["빌드 확인 중", "테스트 실행"],
        lastActivityAtMs: NOW,
      },
      {
        memberId: KIM,
        channelId: LAB,
        source: "status",
        startedAtMs: NOW - 4_000,
        headlines: [],
        lastActivityAtMs: NOW,
      },
    ],
    NOW
  );

  it("rotates through every agent x headline pair, oldest turn first", () => {
    expect(rotatingActivityLines(working, nameFor).map(activityText)).toEqual([
      "Hermes: 빌드 확인 중",
      "Hermes: 테스트 실행",
      "김인턴이(가) 작업 중",
    ]);
  });

  it("collapses to one line per agent when motion is reduced", () => {
    expect(staticActivityLines(working, nameFor).map(activityText)).toEqual([
      "Hermes: 빌드 확인 중",
      "김인턴이(가) 작업 중",
    ]);
  });

  it("names an agent the roster has not loaded without inventing one", () => {
    expect(
      staticActivityLines(working, () => null).map((l) => l.agentName)
    ).toEqual(["에이전트", "에이전트"]);
  });
});

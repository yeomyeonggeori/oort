import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "@/lib/api";
import type { AgentPartialEvent, AgentStatusEvent } from "@/lib/realtime";
import { centrifugoAgentChannelName, createReplayGate } from "@/lib/realtime";
import {
  agentSubscriptionPairs,
  applyAgentEvent,
  candidatesFrom,
  eventTimeMs,
  isRunOver,
  parseSubscriptionKey,
  pruneTracks,
  subscriptionKey,
  turnStateOf,
  type RunTracks,
} from "./agentRail";
import {
  IDLE_CUTOFF_MS,
  resolveAgentWorkingSignals,
  ZOMBIE_CLEAR_MS,
} from "./agentWorkingSignal";
import { activityLines, activityText, agentTurnBadgeCopy } from "./turnCopy";

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

/** `ts` is the SERVER clock in the envelope, which is what the rail stamps. */
function status(
  over: Partial<AgentStatusEvent["payload"]> = {},
  ts: number = NOW
): AgentStatusEvent {
  return {
    type: "agent.status",
    v: 1,
    ts,
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
  over: Partial<AgentPartialEvent["payload"]> = {},
  ts: number = NOW
): AgentPartialEvent {
  return {
    type: "agent.partial",
    v: 1,
    ts,
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

describe("createReplayGate", () => {
  // The `agent` namespace is force_recovery in infra/centrifugo.json, so a
  // reconnect replays the frames of turns that already finished. Measured
  // against momowebqa: a 25s gap that spanned one whole @kim-intern turn came
  // back `recovered:true` with all 8 of that turn's frames.
  function gateWith() {
    const pending: Array<() => void> = [];
    const gate = createReplayGate((task) => pending.push(task));
    return { gate, flush: () => pending.splice(0).forEach((t) => t()) };
  }

  it("closes over the recovered batch and opens again for live frames", () => {
    const { gate, flush } = gateWith();
    expect(gate.isReplaying()).toBe(false);
    gate.onSubscribed({ recovered: true, hasRecoveredPublications: true });
    expect(gate.isReplaying()).toBe(true); // the replayed batch
    flush(); // centrifuge-js has returned; anything after this is live
    expect(gate.isReplaying()).toBe(false);
  });

  it("stays open for a first subscribe that recovered nothing", () => {
    const { gate } = gateWith();
    gate.onSubscribed({ recovered: false, hasRecoveredPublications: false });
    expect(gate.isReplaying()).toBe(false);
  });

  it("closes on recovered publications even without the recovered flag", () => {
    const { gate } = gateWith();
    gate.onSubscribed({ hasRecoveredPublications: true });
    expect(gate.isReplaying()).toBe(true);
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

describe("turnStateOf", () => {
  it("separates an agent that is running from one that stopped for a human", () => {
    expect(turnStateOf("running")).toBe("working");
    expect(turnStateOf("queued")).toBe("working");
    // momowebqa ends every @kim-intern turn here, and the run row stays open.
    expect(turnStateOf("awaiting_approval")).toBe("awaiting_approval");
    expect(turnStateOf("paused")).toBe("awaiting_approval");
  });
});

describe("eventTimeMs", () => {
  it("uses the envelope ts, not the moment the frame was handled", () => {
    expect(eventTimeMs(status({}, NOW - 4_000), NOW)).toBe(NOW - 4_000);
  });

  it("never lets a fast server clock start a turn in the future", () => {
    expect(eventTimeMs(status({}, NOW + 9_000), NOW)).toBe(NOW);
  });

  it("falls back to the local clock when the envelope carries no usable ts", () => {
    const noTs = { ...status(), ts: 0 } as AgentStatusEvent;
    expect(eventTimeMs(noTs, NOW)).toBe(NOW);
  });
});

describe("applyAgentEvent", () => {
  it("starts the clock at the SERVER time of the run's opening frame", () => {
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(
      tracks,
      status({ phase: "queued", run_status: "queued" }, NOW - 500),
      CONTEXT,
      NOW
    );
    tracks = applyAgentEvent(
      tracks,
      status({ phase: "streaming" }, NOW + 7_900),
      CONTEXT,
      NOW + 8_000
    );
    const track = tracks.get(RUN.toLowerCase());
    expect(track?.startedAtMs).toBe(NOW - 500);
    expect(track?.lastActivityAtMs).toBe(NOW + 7_900);
  });

  it("carries no clock at all for a turn whose opening was never observed", () => {
    // Attaching mid-turn is the ordinary case after a reconnect or a cold open.
    // "0s" there would be the moment we noticed, not the moment work began.
    const tracks = applyAgentEvent(new Map(), status({ phase: "streaming" }), CONTEXT, NOW);
    expect(tracks.get(RUN.toLowerCase())?.startedAtMs).toBeUndefined();
    const [signal] = resolveAgentWorkingSignals(candidatesFrom(tracks), NOW);
    expect(signal.startedAtMs).toBeUndefined();
  });

  it("refuses a frame that was already stale when it arrived", () => {
    // Belt to the replay gate's braces: a machine that slept wakes into a
    // recovery batch of frames minutes old, and none of them prove liveness.
    const tracks: RunTracks = new Map();
    const replayed = status({ phase: "streaming" }, NOW - IDLE_CUTOFF_MS - 1);
    expect(applyAgentEvent(tracks, replayed, CONTEXT, NOW)).toBe(tracks);
    const replayedPartial = partial(
      { text: "김인턴 mock reply: MOMO-004 SSE path verified." },
      NOW - IDLE_CUTOFF_MS - 1
    );
    expect(applyAgentEvent(tracks, replayedPartial, CONTEXT, NOW)).toBe(tracks);
  });

  it("still ends a turn on a terminal frame that arrived late", () => {
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(tracks, status({}, NOW), CONTEXT, NOW);
    tracks = applyAgentEvent(
      tracks,
      status({ phase: "done", run_status: "succeeded" }, NOW - IDLE_CUTOFF_MS - 1),
      CONTEXT,
      NOW
    );
    expect(tracks.size).toBe(0);
  });

  it("keys runs case-insensitively so an UPPERCASE run id is not a second turn", () => {
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(tracks, status(), CONTEXT, NOW);
    tracks = applyAgentEvent(
      tracks,
      status({ run_id: RUN.toLowerCase() }, NOW + 1_000),
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
    tracks = applyAgentEvent(
      tracks,
      partial({ text_delta: "김인턴 mock reply: ", text: "김인턴 mock reply: " }),
      CONTEXT,
      NOW
    );
    tracks = applyAgentEvent(
      tracks,
      partial(
        {
          text_delta: "path verified.",
          text: "김인턴 mock reply: MOMO-004 SSE path verified.",
        },
        NOW + 200
      ),
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
      partial({ tool_call_name: "github.search_issues" }, NOW + 100),
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
      status({ phase: "done", run_status: "succeeded" }, NOW + 3_000),
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
    // Frame for frame, with the envelope timestamps the live probe recorded.
    let tracks: RunTracks = new Map();
    tracks = applyAgentEvent(
      tracks,
      status({ phase: "queued", run_status: "queued" }, NOW),
      CONTEXT,
      NOW
    );
    tracks = applyAgentEvent(tracks, status({ phase: "thinking" }, NOW + 8), CONTEXT, NOW + 8);
    tracks = applyAgentEvent(
      tracks,
      status({ phase: "streaming" }, NOW + 11),
      CONTEXT,
      NOW + 11
    );
    tracks = applyAgentEvent(
      tracks,
      partial({ text: "김인턴 mock reply: MOMO-004 SSE path verified." }, NOW + 120),
      CONTEXT,
      NOW + 120
    );
    const [working] = resolveAgentWorkingSignals(candidatesFrom(tracks), NOW + 200);
    expect(working.state).toBe("working");
    expect(working.startedAtMs).toBe(NOW);
    expect(working.headlines).toEqual([
      "김인턴 mock reply: MOMO-004 SSE path verified.",
    ]);

    // The turn's LAST frame, every time: the run is open and stopped.
    tracks = applyAgentEvent(
      tracks,
      status(
        {
          phase: "thinking",
          run_status: "awaiting_approval",
          detail: "github.search_issues",
        },
        NOW + 230
      ),
      CONTEXT,
      NOW + 230
    );
    const [signal] = resolveAgentWorkingSignals(candidatesFrom(tracks), NOW + 1_000);
    expect(signal.memberId).toBe(HERMES);
    expect(signal.channelId).toBe(LAB);
    expect(signal.state).toBe("awaiting_approval");
    expect(signal.startedAtMs).toBe(NOW);
    // The answer is already a message in the timeline; the status line does not
    // reprint it while the run waits for a person.
    expect(signal.headlines).toEqual([]);
    // The tool name is internal vocabulary and never becomes a headline (§7).
    expect(JSON.stringify(signal)).not.toContain("github.search_issues");
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

describe("turn copy: the two surfaces say the same thing", () => {
  // The demo roster really carries two 김인턴: the agent @kim-intern and the
  // human @intern-kim. A name without the handle names neither.
  const nameFor = (id: string) =>
    id === HERMES
      ? { name: "Hermes" }
      : { name: "김인턴", handle: "@kim-intern" };

  const turns = resolveAgentWorkingSignals(
    [
      {
        memberId: HERMES,
        channelId: LAB,
        state: "working",
        source: "status",
        startedAtMs: NOW - 30_000,
        headlines: ["빌드 확인 중"],
        lastActivityAtMs: NOW,
      },
      {
        memberId: KIM,
        channelId: LAB,
        state: "working",
        source: "status",
        startedAtMs: NOW - 4_000,
        headlines: [],
        lastActivityAtMs: NOW,
      },
    ],
    NOW
  );

  it("attaches the right Korean particle to each name", () => {
    expect(activityLines(turns, nameFor).lines.map(activityText)).toEqual([
      "Hermes: 빌드 확인 중",
      "김인턴(@kim-intern)이 작업 중",
    ]);
  });

  it("says 승인 대기 for a turn that stopped for a human, with no headline", () => {
    const waiting = resolveAgentWorkingSignals(
      [
        {
          memberId: KIM,
          channelId: LAB,
          state: "awaiting_approval",
          source: "status",
          startedAtMs: NOW - 30_000,
          headlines: [],
          lastActivityAtMs: NOW,
        },
      ],
      NOW
    );
    expect(activityLines(waiting, nameFor).lines.map(activityText)).toEqual([
      "김인턴(@kim-intern)이 승인을 기다립니다",
    ]);
    const badge = agentTurnBadgeCopy(waiting, nameFor);
    expect(badge?.text).toBe("승인 대기");
    expect(badge?.label).toBe("김인턴(@kim-intern)이 승인을 기다립니다.");
  });

  it("names an agent the roster has not loaded without inventing one", () => {
    expect(
      activityLines(turns, () => ({ name: "에이전트" })).lines.map(activityText)
    ).toEqual(["에이전트: 빌드 확인 중", "에이전트가 작업 중"]);
  });

  it("caps the composer at three lines and counts the rest", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      memberId: `${KIM}-${i}`,
      channelId: LAB,
      state: "working" as const,
      source: "status" as const,
      startedAtMs: NOW - i * 1_000,
      headlines: [],
      lastActivityAtMs: NOW,
    }));
    const list = activityLines(many, nameFor);
    expect(list.lines).toHaveLength(3);
    expect(list.overflowCount).toBe(2);
  });

  it("keeps every digit out of the pill, next to the unread count", () => {
    // A 240px sidebar row has ~74px for its name once a pill and an unread
    // badge are on it, and a second unlabelled number reads as a second count.
    const single = agentTurnBadgeCopy([turns[0]], nameFor);
    expect(single?.text).toBe("작업 중");
    expect(agentTurnBadgeCopy(turns, nameFor)?.text).toBe("작업 중");
    expect(single?.text).not.toMatch(/\d/);
  });

  it("keeps who and how many in the accessible name, and holds it still", () => {
    // Digits in the name would change once a second and some AT re-reads it.
    expect(agentTurnBadgeCopy([turns[0]], nameFor)?.label).toBe(
      "Hermes가 작업 중입니다."
    );
    const many = agentTurnBadgeCopy(turns, nameFor);
    expect(many?.label).toBe("에이전트 2명이 작업 중입니다.");
    expect(many?.label).not.toMatch(/\d+s/);
  });

  it("leads with the working turn and still mentions the waiting one", () => {
    const mixed = [
      turns[0],
      { ...turns[1], state: "awaiting_approval" as const },
    ];
    const badge = agentTurnBadgeCopy(mixed, nameFor);
    expect(badge?.text).toBe("작업 중");
    expect(badge?.label).toBe(
      "Hermes가 작업 중입니다. 에이전트 1명이 승인을 기다립니다."
    );
    // Both are still lines in the composer, each with its own state.
    expect(activityLines(mixed, nameFor).lines.map(activityText)).toEqual([
      "Hermes: 빌드 확인 중",
      "김인턴(@kim-intern)이 승인을 기다립니다",
    ]);
  });
});

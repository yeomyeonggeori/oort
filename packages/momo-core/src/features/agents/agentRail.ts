import type { Channel, RosterMember } from "../../lib/api";
import type {
  AgentPartialEvent,
  AgentProgressEvent,
  AgentStatusEvent,
} from "../../lib/realtimeEvents";
import {
  headlineFrom,
  IDLE_CUTOFF_MS,
  type AgentTurnState,
  type AgentWorkingSignal,
  type AgentWorkingSource,
} from "./workingSignal";

// =============================================================================
// agentRail: the pure half of the agent progress rail (AX-5 / MOMO-613). Which
// (channel, agent) pairs to watch, and how one `agent.status` / `agent.partial`
// frame changes what we believe about a run. AgentWorkingRail.tsx holds the
// React and realtime plumbing; everything decidable without a socket lives here
// so it can be pinned by tests.
//
// Moved into the core by goal RN-A1 (was clients/web/src/features/agents/). The
// event types now come from `lib/realtimeEvents` directly — `clients/web`'s
// `lib/realtime` was already re-exporting them from there, so this is the same
// contract read one hop earlier.
// =============================================================================

/**
 * Ceiling on live agent subscriptions. The rail watches every (channel, agent)
 * membership pair rather than only the open channel, because the value of the
 * sidebar badge is telling you an agent is working somewhere you are NOT
 * looking. That product is channels x agents, so it needs a ceiling: past this
 * many pairs the rail watches the first N in a stable order and the rest simply
 * carry no badge (a missing badge is a smaller lie than a socket storm).
 *
 * "Smaller" is not "none": a reader who cannot tell an unwatched channel from a
 * quiet one has been told something false by omission. `agentCoverage` reports
 * what the cap cut so the sidebar can say it out loud (SKILL §9: absence is
 * never promoted to a confirmed story).
 */
export const MAX_AGENT_SUBSCRIPTIONS = 32;

export interface AgentSubscription {
  channelId: string;
  memberId: string;
}

/** Case-folded id key. Ids cross this wire in mixed case by design. */
function keyOf(id: string): string {
  return id.toLowerCase();
}

/**
 * Every (channel, agent) pair the subscribe proxy will authorise: the agent must
 * be an active agent member of that exact channel, and the channel must be one
 * the caller is already in (the list handed in is the caller's own channel
 * list). Deterministic order (given channel order, then agent id) so the cap
 * always cuts the same tail.
 */
export function agentSubscriptionPairs(
  channels: readonly Channel[],
  members: readonly RosterMember[],
  limit: number = MAX_AGENT_SUBSCRIPTIONS
): AgentSubscription[] {
  return agentCoverage(channels, members, limit).pairs;
}

/**
 * What the cap watches and what it leaves out.
 *
 * `uncovered` holds every channel that has an active agent member the rail is
 * NOT subscribed to, whether the cap cut the channel entirely or only its
 * second agent. That is the set of rows whose blank trailing cell means "we did
 * not look", not "nothing happened", and the sidebar states that difference
 * rather than letting the reader assume the quieter one.
 */
export interface AgentCoverage {
  pairs: AgentSubscription[];
  uncovered: Channel[];
}

export function agentCoverage(
  channels: readonly Channel[],
  members: readonly RosterMember[],
  limit: number = MAX_AGENT_SUBSCRIPTIONS
): AgentCoverage {
  const agents = members
    .filter((m) => m.kind === "agent" && m.status === "active")
    .slice()
    .sort((a, b) => keyOf(a.id).localeCompare(keyOf(b.id)));

  const pairs: AgentSubscription[] = [];
  const uncovered: Channel[] = [];
  for (const channel of channels) {
    let missed = false;
    for (const agent of agents) {
      const memberOfChannel = agent.channelIds.some(
        (id) => keyOf(id) === keyOf(channel.id)
      );
      if (!memberOfChannel) continue;
      // Past the cap the loop keeps running rather than returning: the rest of
      // the walk is what turns "we stopped" into a list of channels to name.
      if (pairs.length >= limit) missed = true;
      else pairs.push({ channelId: channel.id, memberId: agent.id });
    }
    if (missed) uncovered.push(channel);
  }
  return { pairs, uncovered };
}

/**
 * Stable identity for a pair list, so an effect re-subscribes only on change.
 * It is also lossless (`parseSubscriptionKey` inverts it), which lets the
 * subscribing effect depend on this string alone instead of on an array whose
 * identity changes on every roster refetch.
 */
export function subscriptionKey(pairs: readonly AgentSubscription[]): string {
  return pairs.map((p) => `${keyOf(p.channelId)}|${keyOf(p.memberId)}`).join(",");
}

/** Inverse of `subscriptionKey`. Ids come back case-folded, which is the form
 * every comparison uses and which the channel name uppercases anyway. */
export function parseSubscriptionKey(key: string): AgentSubscription[] {
  if (key === "") return [];
  return key.split(",").map((entry) => {
    const [channelId, memberId] = entry.split("|");
    return { channelId, memberId };
  });
}

// ---- run tracking -----------------------------------------------------------

/**
 * What the rail remembers about one live run. `agent.partial` carries no
 * `agent_member_id`, so the owning agent comes from the subscription the frame
 * arrived on and is stamped here once.
 */
export interface RunTrack {
  runId: string;
  memberId: string;
  channelId: string;
  state: AgentTurnState;
  source: AgentWorkingSource;
  /**
   * Server epoch ms of the run's OPENING frame, or undefined when that frame
   * was never seen (the rail attached mid-turn). "When we first noticed" is not
   * "when the agent started", so it is left unknown rather than guessed.
   */
  startedAtMs?: number;
  lastActivityAtMs: number;
  /** Latest agent-authored line, or undefined until one is streamed. */
  headline?: string;
}

/**
 * Is this run over? Mirrors MomoCore `RunStatus.isTerminal` plus the phase
 * check the mac resolver applies on top of it: `succeeded / failed / cancelled /
 * timed_out` are terminal, and a `done` / `error` phase ends the turn even while
 * the run row still says running.
 *
 * `awaiting_approval` is deliberately NOT terminal: the run row is genuinely
 * still open. It is not WORKING either, which `turnStateOf` decides separately.
 */
export function isRunOver(runStatus: string, phase: string): boolean {
  if (phase === "done" || phase === "error") return true;
  return (
    runStatus === "succeeded" ||
    runStatus === "failed" ||
    runStatus === "cancelled" ||
    runStatus === "timed_out"
  );
}

/**
 * Working, or stopped and waiting for a person?
 *
 * Measured against momowebqa: every @kim-intern turn ends on
 * `run_status=awaiting_approval, phase=thinking` and publishes nothing further.
 * Reading that as "작업 중" is how a stopped agent kept a clock running for 90
 * seconds while the reader waited for a decision only they could make.
 *
 * `paused` is the same shape of fact (the run stopped for input it does not
 * have), so it lands in the same state rather than in a third one nobody can
 * tell apart on a sidebar row.
 */
export function turnStateOf(runStatus: string): AgentTurnState {
  return runStatus === "awaiting_approval" || runStatus === "paused"
    ? "awaiting_approval"
    : "working";
}

/**
 * A run's opening frame: the only frame that proves when a turn began.
 * momowebqa publishes it as `phase=queued, run_status=queued` ahead of
 * everything else (measured), so a rail that was already listening gets a real
 * start time and a rail that attached mid-turn honestly gets none.
 */
function isRunOpening(event: AgentStatusEvent): boolean {
  return event.payload.phase === "queued" || event.payload.run_status === "queued";
}

/**
 * When the SERVER says this frame happened. Every agent envelope carries `ts`
 * in epoch ms (measured: a live frame's ts lands 2-4ms before it is received),
 * and using it instead of `Date.now()` is what keeps a replayed frame's age
 * real instead of resetting it to zero on arrival.
 *
 * A ts ahead of our clock is clamped: no turn starts in the future. A ts far
 * behind ours is left alone, and `applyAgentEvent` refuses it below.
 */
export function eventTimeMs(event: AgentProgressEvent, nowMs: number): number {
  const ts = event.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return nowMs;
  return Math.min(ts, nowMs);
}

export type RunTracks = ReadonlyMap<string, RunTrack>;

/**
 * Fold one realtime frame into the run table. Returns the same map instance when
 * nothing changed, so a caller can skip a re-render on a no-op frame.
 *
 * A frame that is ALREADY older than the idle cutoff when it arrives cannot
 * prove anything is live, so it never refreshes a turn. This is the second line
 * of defence behind the replay gate in `subscribeAgent`: a laptop that slept for
 * ten minutes wakes into a recovery batch of frames that old, and the failure
 * direction here is deliberate (a server clock lagging ours by more than the
 * cutoff would show nothing rather than something false).
 */
export function applyAgentEvent(
  tracks: RunTracks,
  event: AgentProgressEvent,
  context: { memberId: string; channelId: string },
  nowMs: number
): RunTracks {
  return event.type === "agent.status"
    ? applyStatus(tracks, event, context, nowMs)
    : applyPartial(tracks, event, context, nowMs);
}

/** Is this frame too old to prove liveness? Terminal frames bypass it: ending a
 *  turn late is still ending it, and a delete is never a false claim. */
function tooOldToProveLiveness(atMs: number, nowMs: number): boolean {
  return nowMs - atMs > IDLE_CUTOFF_MS;
}

function applyStatus(
  tracks: RunTracks,
  event: AgentStatusEvent,
  context: { memberId: string; channelId: string },
  nowMs: number
): RunTracks {
  const runId = keyOf(event.payload.run_id ?? "");
  if (runId === "") return tracks;
  const memberId = event.payload.agent_member_id ?? context.memberId;
  const channelId = event.payload.channel_id ?? context.channelId;

  if (isRunOver(event.payload.run_status, event.payload.phase)) {
    if (!tracks.has(runId)) return tracks;
    const next = new Map(tracks);
    next.delete(runId);
    return next;
  }

  const atMs = eventTimeMs(event, nowMs);
  if (tooOldToProveLiveness(atMs, nowMs)) return tracks;

  const existing = tracks.get(runId);
  const startedAtMs =
    existing?.startedAtMs ?? (isRunOpening(event) ? atMs : undefined);
  const next = new Map(tracks);
  next.set(runId, {
    runId,
    memberId,
    channelId,
    state: turnStateOf(event.payload.run_status),
    source: "status",
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    lastActivityAtMs: atMs,
    ...(existing?.headline !== undefined ? { headline: existing.headline } : {}),
  });
  return next;
}

function applyPartial(
  tracks: RunTracks,
  event: AgentPartialEvent,
  context: { memberId: string; channelId: string },
  nowMs: number
): RunTracks {
  const runId = keyOf(event.payload.run_id ?? "");
  if (runId === "") return tracks;
  const atMs = eventTimeMs(event, nowMs);
  if (tooOldToProveLiveness(atMs, nowMs)) return tracks;

  const existing = tracks.get(runId);
  // `text` is the full answer so far and `text_delta` only the new slice, so the
  // headline reads the cumulative field when the worker sends it; a tool-call
  // partial carries neither and refreshes liveness without a headline.
  const headline =
    headlineFrom(event.payload.text) ??
    headlineFrom(event.payload.text_delta) ??
    existing?.headline;

  const next = new Map(tracks);
  next.set(runId, {
    runId,
    memberId: existing?.memberId ?? context.memberId,
    channelId: existing?.channelId ?? event.payload.channel_id ?? context.channelId,
    // A partial refreshes liveness and may carry a headline, but it never
    // decides the STATE. `run_status` is the only field that says whether the
    // run is running or parked on a person, it rides on `agent.status` alone,
    // and `AgentPartialEvent` has no equivalent: promoting every partial to
    // 작업 중 means one late `tool_call_*` frame (a documented payload shape
    // that carries no text at all) drags a run back out of 승인 대기 and both
    // surfaces resume claiming the reader should wait. That is the exact lie
    // this module exists to prevent.
    //
    // Same rule as the mac resolver, which reads state off the runs projection
    // and lets partials contribute headlines only (AgentWorkingSignal.swift
    // §1a/§1b). A run that genuinely resumes after an approval publishes a
    // fresh `agent.status`, and that frame is what moves it back to working.
    state: existing?.state ?? "working",
    source: existing?.source ?? "status",
    ...(existing?.startedAtMs !== undefined
      ? { startedAtMs: existing.startedAtMs }
      : {}),
    lastActivityAtMs: atMs,
    ...(headline !== undefined ? { headline } : {}),
  });
  return next;
}

/**
 * Forget runs that went quiet past `ttlMs`. Without this a run whose terminal
 * frame was lost stays in the table for the life of the session: the resolver
 * already refuses to render it, but the table itself would only ever grow.
 * Returns the same map instance when nothing was dropped.
 */
export function pruneTracks(
  tracks: RunTracks,
  nowMs: number,
  ttlMs: number
): RunTracks {
  const next = new Map(tracks);
  let removed = 0;
  for (const [runId, track] of tracks) {
    if (nowMs - track.lastActivityAtMs > ttlMs) {
      next.delete(runId);
      removed += 1;
    }
  }
  return removed > 0 ? next : tracks;
}

/** Every tracked run as a resolver candidate. */
export function candidatesFrom(tracks: RunTracks): AgentWorkingSignal[] {
  const out: AgentWorkingSignal[] = [];
  for (const track of tracks.values()) {
    out.push({
      memberId: track.memberId,
      channelId: track.channelId,
      state: track.state,
      source: track.source,
      runId: track.runId,
      ...(track.startedAtMs !== undefined
        ? { startedAtMs: track.startedAtMs }
        : {}),
      // A run parked on an approval keeps no headline: the answer it is waiting
      // on is already a message in the timeline, and reprinting it as a live
      // status line is the "stacked on its own partial" pattern the mac client
      // rules out in MessageListView (composerFooterSignals).
      headlines:
        track.headline === undefined || track.state !== "working"
          ? []
          : [track.headline],
      lastActivityAtMs: track.lastActivityAtMs,
    });
  }
  return out;
}

/** Store key for a resolved signal, matching the store's own keying. */
export function signalKey(signal: {
  channelId: string;
  memberId: string;
}): string {
  return `${keyOf(signal.channelId)}|${keyOf(signal.memberId)}`;
}

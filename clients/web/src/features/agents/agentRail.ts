import type { Channel, RosterMember } from "@/lib/api";
import type {
  AgentPartialEvent,
  AgentProgressEvent,
  AgentStatusEvent,
} from "@/lib/realtime";
import {
  headlineFrom,
  type AgentWorkingSignal,
  type AgentWorkingSource,
} from "./agentWorkingSignal";

// =============================================================================
// agentRail: the pure half of the agent progress rail (AX-5 / MOMO-613). Which
// (channel, agent) pairs to watch, and how one `agent.status` / `agent.partial`
// frame changes what we believe about a run. AgentWorkingRail.tsx holds the
// React and realtime plumbing; everything decidable without a socket lives here
// so it can be pinned by tests.
// =============================================================================

/**
 * Ceiling on live agent subscriptions. The rail watches every (channel, agent)
 * membership pair rather than only the open channel, because the value of the
 * sidebar badge is telling you an agent is working somewhere you are NOT
 * looking. That product is channels x agents, so it needs a ceiling: past this
 * many pairs the rail watches the first N in a stable order and the rest simply
 * carry no badge (a missing badge is a smaller lie than a socket storm).
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
  const agents = members
    .filter((m) => m.kind === "agent" && m.status === "active")
    .slice()
    .sort((a, b) => keyOf(a.id).localeCompare(keyOf(b.id)));

  const out: AgentSubscription[] = [];
  for (const channel of channels) {
    for (const agent of agents) {
      if (out.length >= limit) return out;
      const memberOfChannel = agent.channelIds.some(
        (id) => keyOf(id) === keyOf(channel.id)
      );
      if (!memberOfChannel) continue;
      out.push({ channelId: channel.id, memberId: agent.id });
    }
  }
  return out;
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
  source: AgentWorkingSource;
  startedAtMs: number;
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
 * `awaiting_approval` is deliberately NOT terminal. momowebqa's mock agent ends
 * its turn exactly there, which is the whole reason the idle TTL exists: the
 * run is genuinely still open, it just has nobody to answer it.
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

export type RunTracks = ReadonlyMap<string, RunTrack>;

/**
 * Fold one realtime frame into the run table. Returns the same map instance when
 * nothing changed, so a caller can skip a re-render on a no-op frame.
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

  const existing = tracks.get(runId);
  const next = new Map(tracks);
  next.set(runId, {
    runId,
    memberId,
    channelId,
    source: "status",
    startedAtMs: existing?.startedAtMs ?? nowMs,
    lastActivityAtMs: nowMs,
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
    source: existing?.source ?? "status",
    startedAtMs: existing?.startedAtMs ?? nowMs,
    lastActivityAtMs: nowMs,
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
      source: track.source,
      runId: track.runId,
      startedAtMs: track.startedAtMs,
      headlines: track.headline === undefined ? [] : [track.headline],
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

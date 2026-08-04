import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSession } from "@/app/session";
import { useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import type { AgentProgressEvent } from "@/lib/realtime";
import {
  agentSubscriptionPairs,
  applyAgentEvent,
  candidatesFrom,
  parseSubscriptionKey,
  pruneTracks,
  signalKey,
  subscriptionKey,
  type AgentSubscription,
  type RunTracks,
} from "@momo/core/features/agents/agentRail";
import {
  clearAgentWorking,
  markAgentWorking,
  resetAgentWorking,
  resolveAgentWorkingSignals,
  sweepAgentWorking,
  ZOMBIE_CLEAR_MS,
} from "./agentWorkingSignal";
import { recordAgentProgress, resetWorkLogs } from "./workLogStore";

// =============================================================================
// AgentWorkingRail (AX-5 / MOMO-613): renders nothing, and is the only thing
// that puts current into the agentWorkingSignal store.
//
// It watches `agent:ws<ws>.<channel>.<agent>` for every membership pair in the
// workspace, folds `agent.status` / `agent.partial` into a run table, resolves
// that table through the ported mac rules, and publishes the result. Mounted in
// the shell rather than in the channel route on purpose: a badge that only
// lights for the channel you are already reading is a badge nobody needs.
// =============================================================================

/**
 * Zombie sweep cadence. Independent of any channel surface: a stranded turn must
 * not survive in the store just because nobody has the channel open. 15s is far
 * below the 2-minute clear it enforces, so the deletion lands promptly without
 * the timer itself being a busy loop.
 */
const SWEEP_INTERVAL_MS = 15_000;

export function AgentWorkingRail() {
  const { workspaceId, realtime } = useSession();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);

  const { channels, dms } = channelsQuery.groups;
  const members = directoryQuery.directory.members;

  // The subscribing effect depends on the pair KEY, never on the pair array: a
  // roster refetch that returns the same memberships builds a new array every
  // time, and tearing every subscription down and up again on each one would
  // drop the frames in between. The key is lossless, so the effect rebuilds the
  // pairs from it and needs no ref that could drift from its own dependencies.
  const pairsKey = useMemo(
    () => subscriptionKey(agentSubscriptionPairs([...channels, ...dms], members)),
    [channels, dms, members]
  );

  /** Live runs, keyed by run id. Not state: only the store drives renders. */
  const tracksRef = useRef<RunTracks>(new Map());
  /** Store keys this rail currently owns, so it can clear what it stops proving. */
  const ownedRef = useRef<Set<string>>(new Set());

  const publish = useCallback((nowMs: number) => {
    const resolved = resolveAgentWorkingSignals(
      candidatesFrom(tracksRef.current),
      nowMs
    );
    const owned = new Set<string>();
    for (const signal of resolved) {
      owned.add(signalKey(signal));
      markAgentWorking(signal);
    }
    for (const key of ownedRef.current) {
      if (owned.has(key)) continue;
      const [channelId, memberId] = key.split("|");
      clearAgentWorking(channelId, memberId);
    }
    ownedRef.current = owned;
  }, []);

  const onEvent = useCallback(
    (pair: AgentSubscription, event: AgentProgressEvent) => {
      const nowMs = Date.now();
      // 작업 패널(goal WEB-WP1)은 이 레일에서 **분기**한다. 새 구독을 만들지
      // 않는 이유는 구독이 (채널 x 에이전트) 곱이고 이미 상한이 걸려 있어서,
      // 패널이 자기 것을 하나 더 여는 순간 그 상한이 뜻하는 바가 달라지기
      // 때문이다. 스토어는 **보고 있는 run만** 받아 적으므로(workLogStore),
      // 아무도 패널을 안 열었으면 이 호출은 즉시 돌아온다.
      recordAgentProgress(event);
      const next = applyAgentEvent(tracksRef.current, event, pair, nowMs);
      if (next === tracksRef.current) return;
      tracksRef.current = next;
      publish(nowMs);
    },
    [publish]
  );

  useEffect(() => {
    if (!realtime) return;
    const stops = parseSubscriptionKey(pairsKey).map((pair) =>
      realtime.subscribeAgent(workspaceId, pair.channelId, pair.memberId, {
        onEvent: (event) => onEvent(pair, event),
      })
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [realtime, workspaceId, pairsKey, onEvent]);

  // The two-part zombie guard, on one timer: drop runs whose last activity is
  // past the hard clear, then re-publish so a signal that lost its last live run
  // disappears from the surfaces in the same pass.
  useEffect(() => {
    const id = setInterval(() => {
      const nowMs = Date.now();
      tracksRef.current = pruneTracks(tracksRef.current, nowMs, ZOMBIE_CLEAR_MS);
      sweepAgentWorking(nowMs);
      publish(nowMs);
    }, SWEEP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [publish]);

  // A different session (logout, workspace switch) inherits nothing: the store
  // is module state and a stale turn from the previous workspace would render
  // against the new one's channel ids.
  useEffect(() => {
    return () => {
      tracksRef.current = new Map();
      ownedRef.current = new Set();
      resetAgentWorking();
      resetWorkLogs();
    };
  }, [workspaceId]);

  return null;
}

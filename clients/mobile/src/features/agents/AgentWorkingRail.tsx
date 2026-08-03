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
} from '@momo/core/features/agents/agentRail';
import {resolveAgentWorkingSignals} from '@momo/core/features/agents/workingSignal';
import type {AgentProgressEvent} from '@momo/core/lib/realtimeEvents';
import {useCallback, useEffect, useMemo, useRef} from 'react';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useSession} from '../../session/useSession';
import {useChannels, useDirectory} from '../workspace/queries';
import {
  clearAgentWorking,
  markAgentWorking,
  resetAgentWorking,
  sweepAgentWorking,
  ZOMBIE_CLEAR_MS,
} from './workingSignal';

// =============================================================================
// AgentWorkingRail (goal RN-T2): renders nothing, and is the only thing that
// puts current into the phone's `workingSignal` store.
//
// It watches `agent:ws<WS>.<CHANNEL>.<AGENT>` for every membership pair in the
// workspace, folds `agent.status` / `agent.partial` into a run table through the
// core's `agentRail`, resolves that table through the core's rules, and
// publishes the result. Every judgement is the core's — which pairs to watch,
// what a frame means, when a run is over, how concurrent runs merge. This file
// is the socket and the timer.
//
// ## Why this and not `RUNNING_SESSION_PILL`
//
// #980 gave the 에이전트 탭 a 세션 실행 중 pill read off the work-session ledger,
// and `rows.ts` says in as many words that it is NOT 작업 중 because this client
// could not observe an open turn. That sentence is what this file retires. The
// two facts stay separate on the row, because they diverge in both directions:
// a running session with no open turn is an idle terminal, and an open turn with
// no session is an agent answering a message.
//
// ## Mounted in the shell, not in a screen
//
// Same reason the web rail is: a badge that only lights for the surface you are
// already looking at is a badge nobody needs. The 에이전트 tab has to be able to
// say an agent is working in a channel you have not opened.
//
// ## …but it detaches when the policy parks the socket
//
// The cap is 32 subscriptions against the timeline's one, so this is the rail
// where a phone's radio actually notices. `subscriptionsWanted` is the
// background policy's own answer (`socketWanted`), not the socket's status:
// after the 15s grace a backgrounded app HAS no socket, and centrifuge-js
// reports that as `connecting` forever. Holding 32 subscriptions across it would
// buy a subscribe storm plus 32 discarded recovery batches on every return, for
// frames about turns that have since moved on.
//
// The store is deliberately NOT cleared on that detach. A remembered turn is
// still true for up to 90 seconds (the TTL is the core's, and it is measured
// from the frame's own server timestamp), and clearing on every app-switch would
// erase a badge that is about to be re-proved. What the TTL does not cover, the
// sweep below deletes.
// =============================================================================

/**
 * Zombie sweep cadence. Independent of any surface: a stranded turn must not
 * survive in the store just because nobody has the channel open. 15s is far
 * below the 2-minute clear it enforces, so the deletion lands promptly without
 * the timer itself being a busy loop.
 */
const SWEEP_INTERVAL_MS = 15_000;

export function AgentWorkingRail(): null {
  const {workspaceId} = useSession();
  const {rail, subscriptionsWanted} = useRealtime();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);

  const {channels, dms} = channelsQuery.groups;
  const members = directoryQuery.directory.members;

  // The subscribing effect depends on the pair KEY, never on the pair array: a
  // roster refetch that returns the same memberships builds a new array every
  // time, and tearing every subscription down and up again on each one would
  // drop the frames in between. The key is lossless (`parseSubscriptionKey`
  // inverts it), so the effect rebuilds the pairs from it and needs no ref that
  // could drift from its own dependencies.
  const pairsKey = useMemo(
    () => subscriptionKey(agentSubscriptionPairs([...channels, ...dms], members)),
    [channels, dms, members],
  );

  /** Live runs, keyed by run id. Not state: only the store drives renders. */
  const tracksRef = useRef<RunTracks>(new Map());
  /** Store keys this rail currently owns, so it can clear what it stops proving. */
  const ownedRef = useRef<Set<string>>(new Set());

  const publish = useCallback((nowMs: number) => {
    const resolved = resolveAgentWorkingSignals(
      candidatesFrom(tracksRef.current),
      nowMs,
    );
    const owned = new Set<string>();
    for (const signal of resolved) {
      owned.add(signalKey(signal));
      markAgentWorking(signal);
    }
    for (const key of ownedRef.current) {
      if (owned.has(key)) continue;
      const [channelId, memberId] = key.split('|');
      clearAgentWorking(channelId, memberId);
    }
    ownedRef.current = owned;
  }, []);

  const onEvent = useCallback(
    (pair: AgentSubscription, event: AgentProgressEvent) => {
      const nowMs = Date.now();
      const next = applyAgentEvent(tracksRef.current, event, pair, nowMs);
      if (next === tracksRef.current) return;
      tracksRef.current = next;
      publish(nowMs);
    },
    [publish],
  );

  useEffect(() => {
    if (!rail || !subscriptionsWanted) return;
    const stops = parseSubscriptionKey(pairsKey).map(pair =>
      rail.subscribeAgent(workspaceId, pair.channelId, pair.memberId, {
        onEvent: event => onEvent(pair, event),
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [rail, subscriptionsWanted, workspaceId, pairsKey, onEvent]);

  // The two-part zombie guard, on one timer: drop runs whose last activity is
  // past the hard clear, then re-publish so a signal that lost its last live run
  // disappears from the surfaces in the same pass.
  //
  // Armed only while the socket is wanted. A backgrounded app's timers are
  // suspended by iOS anyway, so scheduling one there is asking for a wake-up
  // that either never comes or comes as a burst — and nothing can go stale while
  // nothing is arriving. The first tick after a return sweeps whatever aged out
  // during the gap, and until then the render-time TTL filter already refuses to
  // show it.
  useEffect(() => {
    if (!subscriptionsWanted) return;
    const id = setInterval(() => {
      const nowMs = Date.now();
      tracksRef.current = pruneTracks(tracksRef.current, nowMs, ZOMBIE_CLEAR_MS);
      sweepAgentWorking(nowMs);
      publish(nowMs);
    }, SWEEP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [subscriptionsWanted, publish]);

  // A different session (sign-out, workspace switch) inherits nothing: the store
  // is module state and a stale turn from the previous workspace would render
  // against the new one's channel ids.
  useEffect(() => {
    return () => {
      tracksRef.current = new Map();
      ownedRef.current = new Set();
      resetAgentWorking();
    };
  }, [workspaceId]);

  return null;
}

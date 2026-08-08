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
import {observeAgentProgress, resetEndedRuns} from './endedRuns';
import {useInvalidateInboxLedgers} from '../inbox/useInbox';
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

  // ===========================================================================
  // ## 승인이 도착하면 인박스가 그것을 안다 (goal RN-B4d / #1020)
  //
  // MAESTRO 30-approval 이 실측한 결함: 승인이 DB 에서 `pending` 이고 채널에는
  // 실시간으로 떠 있는 동안, 인박스는 60초 내내 「지금 결정할 일이 없습니다」였다.
  // 원인은 리얼타임이 아니다 — 채널이 그것을 증명했다. 원인은 **아무것도 인박스
  // 쿼리를 무효화하지 않는다**는 것이었다: 피드는 `FEED_STALE_MS` 15초를 쥐고
  // 있고, 탭은 언마운트가 아니라 `display:'none'` 이라 탭 전환이 마운트가 아니다.
  //
  // 그 신호가 **이미 이 레일을 지나가고 있었다.** 승인 대기는
  // `agent.status` 의 `run_status: "awaiting_approval"` 이고, 이 레일은 워크스페이스
  // 전체의 에이전트 채널을 이미 듣고 있다(그것이 이 파일이 셸에 사는 이유다). 인박스
  // 자신이 소켓을 하나 더 열 이유가 없다.
  //
  // 흔드는 조건은 **run_status 가 바뀐 프레임**뿐이다. 「승인 대기일 때」가 아니라
  // 「바뀌었을 때」인 이유는 두 방향이 다 필요하기 때문이다: 들어갈 때 행이 생기고,
  // 나갈 때(다른 클라이언트가 결정했거나 만료됐거나 실행이 끝났거나) 행이 사라진다.
  // 한 턴이 내는 상태 변화는 손에 꼽고, 스트리밍 프레임(`agent.partial`)은 여기
  // 닿지 않는다 — 그것이 없었다면 이 줄은 토큰마다 원장을 다시 읽는 폭풍이 된다.
  // ===========================================================================
  const invalidateInboxLedgers = useInvalidateInboxLedgers();
  /**
   * run id → 마지막으로 본 `run_status`. 같은 상태의 반복 프레임은 조용하다.
   *
   * 키는 **소문자로 접은 run id** 다. id 는 이 선을 대소문자가 섞인 채로 건너오고
   * (core `agentRail.keyOf` 의 이유와 같다), 트랙 맵도 같은 규칙으로 접혀 있다 —
   * 아래 청소가 두 맵을 같은 키로 비교하려면 여기서도 접어야 한다.
   */
  const runStatusRef = useRef<Map<string, string>>(new Map());

  const onEvent = useCallback(
    (pair: AgentSubscription, event: AgentProgressEvent) => {
      const nowMs = Date.now();
      if (event.type === 'agent.status') {
        const runId = (event.payload.run_id ?? '').toLowerCase();
        const runStatus = event.payload.run_status;
        if (runId !== '' && runStatusRef.current.get(runId) !== runStatus) {
          runStatusRef.current.set(runId, runStatus);
          invalidateInboxLedgers();
        }
      }
      // ADR-0155 — `applyAgentEvent` 가 끝난 run 을 트랙에서 지우기 전에 적는다.
      // 그 기록이 없으면 「run 은 끝났는데 stream 은 열림」을 영영 알 수 없다.
      observeAgentProgress(event);
      const next = applyAgentEvent(tracksRef.current, event, pair, nowMs);
      // 트랙이 그대로여도 위의 무효화는 이미 일어났고, 그래야 한다. 끝난 런은
      // `applyAgentEvent` 가 트랙에서 **지우고** 같은 맵을 돌려줄 수 있는데,
      // 인박스에게 그 프레임은 「행 하나가 사라졌다」는 소식이다.
      if (next === tracksRef.current) return;
      tracksRef.current = next;
      publish(nowMs);
    },
    [invalidateInboxLedgers, publish],
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
      // 상태 기억도 같은 청소를 받는다. 이 맵은 렌더에 닿지 않으므로 새는 것은
      // 화면이 아니라 메모리뿐이지만, 하루 종일 열려 있는 앱에서 「본 적 있는 런」은
      // 끝없이 늘어난다. 트랙에서 사라진 런은 여기서도 사라진다.
      for (const runId of runStatusRef.current.keys()) {
        if (!tracksRef.current.has(runId)) runStatusRef.current.delete(runId);
      }
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
      runStatusRef.current = new Map();
      resetAgentWorking();
      resetEndedRuns();
    };
  }, [workspaceId]);

  return null;
}

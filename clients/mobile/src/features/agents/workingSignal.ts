import {useEffect, useState, useSyncExternalStore} from 'react';
import {
  applyApprovalWaits,
  byOldestTurn,
  isStaleSignal,
  type AgentWorkingSignal,
  type ApprovalWait,
} from '@momo/core/features/agents/workingSignal';

// =============================================================================
// 「이 에이전트에게 지금 열린 턴이 있는가」 — the phone's half (goal RN-T2).
//
// The RULES are the core's (`@momo/core/features/agents/workingSignal`): the
// three types, the 90s TTL, `isStaleSignal`, the concurrent-run merge,
// `headlineFrom`, `elapsedLabel`, and the one that this whole file exists to
// serve — **no surface may render `awaiting_approval` as 작업 중**. Nothing
// here re-decides any of them.
//
// What IS here is the part the core cannot hold: a module-level mutable map, a
// `useSyncExternalStore` subscription over it, and a `setInterval` clock. The
// web client keeps the same three in
// `clients/web/src/features/agents/agentWorkingSignal.ts` and its header says
// why: they are platform state, and the purity gate rejects them on sight
// (ADR-0137 D3). Its comment then said "React Native will subscribe to its own
// realtime rail when it has one" — this is that store, written against the rail
// `src/realtime/` has had since RN-C3.
//
// ## A second store is not a second answer
//
// The constants and the meanings are the web file's, deliberately identical:
// `ZOMBIE_CLEAR_MS` is the same 120s over the same 90s TTL, the key is the same
// case-folded `channelId|memberId`, and the render-time staleness filter is the
// same one. Two clients that disagree about when a badge goes out have shipped
// a defect, not a variation. What is NOT copied is anything that could have
// lived in the core: every judgement below is a call into it.
//
// The one function web has no use for is `agentTurnsForMember`. The phone's
// 에이전트 tab is a list of AGENTS, not of channels, so a row there asks "does
// this agent have an open turn anywhere" — the same store, read down the other
// axis.
// =============================================================================

/**
 * Hard clear: past this, the entry is REMOVED from the store, not merely
 * hidden. The gap over the 90s TTL is deliberate and is the web file's number
 * for the web file's reason. Between 90s and 120s a run that resumes publishing
 * is still the same turn and keeps its original clock; after 120s of total
 * silence the entry is a zombie of a rail that went away, and nothing may
 * resurrect it.
 */
export const ZOMBIE_CLEAR_MS = 120_000;

/**
 * 만료(90초 TTL) 판정에 쓰는 시계의 격자, ms (goal RN-P2a).
 *
 * 화면의 경과 숫자는 1초마다 바뀌어야 하지만 **어떤 턴이 살아 있는가**는 그렇지
 * 않다. 그 판정에 1Hz 시계를 그대로 먹이면 파생되는 배열이 매초 새 동일성을 얻고,
 * 그 아래의 모든 `useMemo` 가 무효가 된다. 5초는 90초 TTL 대비 5.5% 의 지연이고,
 * 스토어의 zombie sweep 이 15초마다 도는 것보다 여전히 촘촘하다.
 *
 * 이 파일에 있는 이유는 소비자가 둘이 됐기 때문이다(#1137): 대화 화면의 채널
 * 스코프 필터와 ADE 요약 줄의 워크스페이스 스코프 필터가 **같은 격자**를 써야
 * 한다. 두 표면이 서로 다른 격자로 같은 신호를 거르면, 한 화면은 살아 있다고
 * 하고 다른 화면은 아니라고 하는 구간이 생긴다.
 */
export const TURN_STALENESS_GRID_MS = 5_000;

type Key = string;

function keyOf(channelId: string, memberId: string): Key {
  return `${channelId.toLowerCase()}|${memberId.toLowerCase()}`;
}

// ---- the store --------------------------------------------------------------

let signals: ReadonlyMap<Key, AgentWorkingSignal> = new Map();
const listeners = new Set<() => void>();

function emit(next: ReadonlyMap<Key, AgentWorkingSignal>): void {
  signals = next;
  for (const listener of listeners) listener();
}

function sameSignal(a: AgentWorkingSignal, b: AgentWorkingSignal): boolean {
  return (
    a.memberId === b.memberId &&
    a.channelId === b.channelId &&
    a.state === b.state &&
    a.source === b.source &&
    a.runId === b.runId &&
    a.startedAtMs === b.startedAtMs &&
    a.lastActivityAtMs === b.lastActivityAtMs &&
    JSON.stringify(a.server) === JSON.stringify(b.server) &&
    a.headlines.length === b.headlines.length &&
    a.headlines.every((headline, index) => headline === b.headlines[index])
  );
}

/**
 * Record (or refresh) a turn. The caller has already merged that agent's
 * concurrent runs through the core's `resolveAgentWorkingSignals`, so this is an
 * upsert and not a second merge policy: two merge rules in two places is how the
 * 에이전트 목록 and the 대화 화면 would end up disagreeing about one turn.
 */
export function markAgentWorking(signal: AgentWorkingSignal): void {
  const key = keyOf(signal.channelId, signal.memberId);
  const existing = signals.get(key);
  if (existing && sameSignal(existing, signal)) return;
  const next = new Map(signals);
  next.set(key, signal);
  emit(next);
}

/** Clear a turn (completed, cancelled, or stalled out). */
export function clearAgentWorking(channelId: string, memberId: string): void {
  const key = keyOf(channelId, memberId);
  if (!signals.has(key)) return;
  const next = new Map(signals);
  next.delete(key);
  emit(next);
}

/**
 * Zombie guard: delete every entry that has not been refreshed for
 * `ZOMBIE_CLEAR_MS`. Runs on a timer independent of any one surface, so a
 * stranded turn cannot survive in the store just because nobody is looking at
 * the channel it belongs to.
 */
export function sweepAgentWorking(nowMs: number): void {
  const next = new Map(signals);
  let removed = 0;
  for (const [key, signal] of signals) {
    // 서버가 답한 run은 서버가 끝낸다(ADR-0200). 우리 시계로 지우지 않는다.
    if (signal.server !== undefined) {
      continue;
    }
    if (nowMs - signal.lastActivityAtMs > ZOMBIE_CLEAR_MS) {
      next.delete(key);
      removed += 1;
    }
  }
  if (removed > 0) emit(next);
}

/** Drop everything (sign-out, workspace switch, tests). */
export function resetAgentWorking(): void {
  if (signals.size === 0) return;
  emit(new Map());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ReadonlyMap<Key, AgentWorkingSignal> {
  return signals;
}

/** Test/diagnostic seam: the raw store without a React subscription. */
export const agentWorkingSnapshot = snapshot;

/** All open turns, keyed by `channelId|memberId`. */
export function useAgentWorkingSignals(): ReadonlyMap<Key, AgentWorkingSignal> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Open turns in one channel, oldest first, with stale entries filtered at RENDER
 * time. The filter matters even with the sweep running: between 90s and 120s a
 * stranded signal is still in the store, and no surface may claim it is live.
 */
export function agentTurnsInChannel(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  channelId: string,
  nowMs: number,
): AgentWorkingSignal[] {
  const prefix = `${channelId.toLowerCase()}|`;
  const out: AgentWorkingSignal[] = [];
  for (const [key, signal] of all) {
    if (!key.startsWith(prefix)) continue;
    if (isStaleSignal(signal, nowMs)) continue;
    out.push(signal);
  }
  return out.sort(byOldestTurn);
}

/**
 * Open turns belonging to ONE agent, across every channel, oldest first.
 *
 * The 에이전트 탭 is a list of agents rather than of channels, so its row asks a
 * question the sidebar never has to: is this agent working ANYWHERE. Same store,
 * same staleness filter, same order — only the axis differs.
 */
export function agentTurnsForMember(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  memberId: string,
  nowMs: number,
): AgentWorkingSignal[] {
  const suffix = `|${memberId.toLowerCase()}`;
  const out: AgentWorkingSignal[] = [];
  for (const [key, signal] of all) {
    if (!key.endsWith(suffix)) continue;
    if (isStaleSignal(signal, nowMs)) continue;
    out.push(signal);
  }
  return out.sort(byOldestTurn);
}

/**
 * 열린 턴 **전체**(채널 너머)에 승인 원장을 덮은 사본 — 홈 「작업 중」 카드와 에이전트 탭이 읽는 판 (#5085).
 *
 * 승인 원장이 레일보다 이긴다(#3738, #5066): 사람을 기다리는 승인이 있는 에이전트의 턴은 레일이 뭐라 하든 승인 대기이고, 레일이 턴을
 * 잃었어도 승인이 살아 있는 동안은 그 턴이 존재한다. 대화 화면은 한 채널의 턴에 이 덮어쓰기를 하고
 * (`applyApprovalWaits(agentTurnsInChannel(…))`), 이 두 표면은 **채널 너머**를 읽어서 같은 일을 하지 못하고 있었다: 서버는 승인에 걸린
 * run 을 레일 프레임으로 알리지 않아(중간 프레임은 늘 `running`) 홈 카드와 에이전트 탭이 같은 에이전트를 「작업 중」이라고 말했다.
 *
 * 규칙은 코어 `applyApprovalWaits` 하나이고 여기에 새 판정은 없다. 그 규칙이 **채널 하나**를 받으므로 대기 승인이 있는 채널마다
 * 한 번씩 부를 뿐이다. 두 가지는 대화 화면과 같게 지킨다.
 *
 *  - 덮기 전에 **만료된 신호를 거른다**(`agentTurnsInChannel`). 90초를 넘긴 `working` 신호를 그대로 넘기면 덮어쓰기가 그 자리에서 승인
 *    대기로 바꾸고 옛 `lastActivityAtMs` 를 그대로 둬서, 아래 표면의 만료 거름이 그 턴을 지우고 살아 있는 승인은 아무 데도 안 보인다.
 *    먼저 거르면 덮어쓰기가 승인을 근거로 새 턴을 세운다.
 *  - 기한이 지난 승인은 기다림이 아니다(코어가 `nowMs` 로 거른다). 이 표면들은 시계를 마운트하지 않으므로 호출자가 렌더의 `Date.now()` 를 준다.
 *
 * 대기 승인이 없는 채널은 건드리지 않는다. 대기 승인이 있는 채널에서도 **지우는 것은 없다**(코어 규칙은 턴을 빼지 않는다): 덮은 턴은 같은
 * 키로 원래 항목을 바꾸고, 승인이 세운 턴은 더한다. 덮지 않은 만료 신호는 사본에도 남고 읽는 쪽의 만료 거름이 거른다(같은 키의 만료 신호는
 * 승인이 세운 새 턴이 덮어쓴다). 입력은 바꾸지 않고 사본을 돌려준다(대기가 없으면 같은 객체).
 */
export function withApprovalWaits(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  waits: readonly ApprovalWait[],
  nowMs: number,
): ReadonlyMap<Key, AgentWorkingSignal> {
  if (waits.length === 0) return all;
  // 대기 승인이 있는 채널들. 접은 id 로 합치고(와이어가 대소문자를 섞어 보낸다), 코어에는 받은 그대로 넘긴다.
  const channels = new Map<string, string>();
  for (const wait of waits) channels.set(wait.channelId.toLowerCase(), wait.channelId);

  const next = new Map(all);
  for (const channelId of channels.values()) {
    for (const turn of applyApprovalWaits(
      agentTurnsInChannel(all, channelId, nowMs),
      channelId,
      waits,
      nowMs,
    )) {
      next.set(keyOf(turn.channelId, turn.memberId), turn);
    }
  }
  return next;
}

/**
 * Does this channel have any entry at all in the store? Cheap and CLOCK-FREE,
 * so a surface can decide whether to mount a 1Hz clock before it has one.
 * Without it the conversation screen would re-render once a second because some
 * other channel's agent is busy — a render loop bought with nothing on screen,
 * and on a phone that is battery.
 */
export function hasChannelTurn(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  channelId: string,
): boolean {
  const prefix = `${channelId.toLowerCase()}|`;
  for (const key of all.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// ---- elapsed readout --------------------------------------------------------

/**
 * A once-per-second RE-RENDER, mounted only while a clock is actually on screen.
 * The elapsed readout is data cadence rather than animation (it changes exactly
 * as fast as the number it shows), so it keeps ticking under reduced motion.
 *
 * Hoist this to the surface that owns the list, not to each row: ten rows must
 * not mean ten intervals. And pass `false` while the realtime rail is down — a
 * clock that keeps counting on a dead socket is measuring our optimism, not the
 * agent's turn.
 *
 * What it returns is the RENDER's own `Date.now()`, never a value the interval
 * captured. Returning a frozen timestamp while disabled was a real defect on
 * web: the composer fed the same number to `agentTurnsInChannel`, whose whole
 * job is to drop signals older than the TTL, and a frozen now can never find one
 * stale. The rail being down is exactly when a signal most needs to expire, so
 * the TTL was inert precisely when it mattered. `enabled` decides whether this
 * component re-renders on a timer; it does not decide what time it is.
 */
export function useTickingNow(enabled: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    setTick(tick => tick + 1);
    const id = setInterval(() => setTick(tick => tick + 1), 1_000);
    return () => clearInterval(id);
  }, [enabled]);
  return Date.now();
}

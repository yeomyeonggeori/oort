import {
  fetchAgentRunProgress,
  resetRunLedgerIncludeProbe,
  type AgentRunProgress,
} from '@momo/core/lib/api';
import {serverSaysAbsent} from '@momo/core/features/capabilities/serverSurfaces';
import {WireShapeError} from '@momo/core/lib/wire';
import {
  isOpenRunPhase,
  serverFactsOf,
  signalFromProgress,
} from '@momo/core/features/agents/runPhase';
import type {
  AgentWorkingSignal,
  ServerRunFacts,
} from '@momo/core/features/agents/workingSignal';
import {useSyncExternalStore} from 'react';
import type {ChannelRail} from '../../realtime/channelRail';

// =============================================================================
// 서버가 파생한 run 상태의 폰 접합 (ADR-0200 D1·D3, U4 #3750). 웹의
// `clients/web/src/features/agents/agentRunProgressStore.ts`와 같은 규칙을 같은
// core(`runPhase`)로 읽는다. 규칙(phase → 낱말)은 core에 있고 여기는 그것이 아닌
// 것뿐이다: 모듈 전역 맵, `useSyncExternalStore` 구독, 그리고 **언제 다시 읽는가**.
//
// 다시 읽는 때는 셋이다.
//   1. `agent.run.event` 프레임(채널 토픽). 프레임에는 단계 문자열도 순번도 없다:
//      「원장이 바뀌었다」는 신호라 이 채널의 진행 목록을 통째로 다시 읽는다.
//   2. 재구독(`onResync`). 끊긴 동안의 프레임은 오지 않는다. 백그라운드 정책이 소켓을
//      15초 뒤에 접는 폰에서는 돌아올 때마다 일어나는 일이다.
//   3. **열린 run이 있는 동안 30초마다.** stage 프레임은 run당 2초에 하나로 합쳐 오고,
//      한 묶음의 마지막 행은 프레임 없이 끝날 수 있다. 앱이 백그라운드이면 이 함수를
//      멈춘다(`start`가 반환한 함수를 부르면 타이머가 사라진다): iOS가 어차피 멈춘 타이머를
//      예약하는 것은 돌아올 때 한꺼번에 터지는 호출을 사는 일이다.
//
// 구 서버(진행 읽기 경로가 없는 v0.1.22)는 404/405/501로 답한다. 그 답은 장애가 아니라
// 「이 서버에는 없다」이므로 한 번만 확인하고 접는다: 이후에는 요청도 타이머도 없고,
// 표면은 이 변경 이전처럼 프레임 시계 규칙으로 동작한다.
// =============================================================================

/** 열린 run이 있는 채널을 다시 읽는 간격. 서버 지시는 「30초 이내」다. */
export const RUN_PROGRESS_POLL_MS = 30_000;

/** 한 채널에서 읽는 run 수. 열린 run은 몇 건 되지 않고 나머지는 최근 기록이다. */
const PAGE_LIMIT = 30;

type FetchProgress = typeof fetchAgentRunProgress;

let byChannel: ReadonlyMap<string, readonly AgentRunProgress[]> = new Map();
let unsupported = false;
const listeners = new Set<() => void>();

// ---- run 하나의 원장 신호 (#3824) --------------------------------------------
// 웹과 같은 이유다: 깨우는 신호 행(`doorbell_rung`)은 서버가 진행의 `lastEventAtMs`에서
// 빼므로 진행 지문이 바뀌지 않는다. 프레임이 온 run을 따로 알려, 원장을 들고 있는
// 표면(메시지 아래 상태 줄·기록 시트)이 30초를 기다리지 않고 다시 읽게 한다.
const ledgerFrameListeners = new Map<string, Set<() => void>>();

/** 이 run의 원장에 행이 생겼다는 프레임을 듣는다. 반환값은 멈추는 함수다. */
export function subscribeRunLedgerFrames(
  runId: string,
  listener: () => void,
): () => void {
  const key = runId.toLowerCase();
  let set = ledgerFrameListeners.get(key);
  if (set === undefined) {
    set = new Set();
    ledgerFrameListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = ledgerFrameListeners.get(key);
    if (current === undefined) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      ledgerFrameListeners.delete(key);
    }
  };
}

/** 시험 seam: 프레임 하나가 이 run의 원장 구독자에게 닿는다. */
export function notifyRunLedgerFrame(runId: string): void {
  const set = ledgerFrameListeners.get(runId.toLowerCase());
  if (set === undefined) {
    return;
  }
  for (const listener of [...set]) {
    listener();
  }
}

// 내가 방금 보낸 메시지가 화면에 서면 그 채널을 한 번 당겨 읽는다(#3824: 1초 안에
// 「받았어요」). 지켜보지 않는 채널이면 아무 일도 하지 않는다.
let nudgeChannel: ((channelId: string) => void) | null = null;

export function nudgeRunProgress(channelId: string): void {
  nudgeChannel?.(channelId.toLowerCase());
}

/** 한 채널의 진행 목록(끝난 최근 run 포함). 서버가 모르는 채널이면 빈 배열. */
export function useChannelRuns(
  channelId: string | null | undefined,
): readonly AgentRunProgress[] {
  const all = useSyncExternalStore(subscribe, runProgressSnapshot, runProgressSnapshot);
  if (channelId === null || channelId === undefined) {
    return EMPTY_ROWS;
  }
  return all.get(channelId.toLowerCase()) ?? EMPTY_ROWS;
}

/** run id로 한 줄을 찾는다(기록 시트가 머리를 그릴 때). */
export function useRunRow(runId: string | null): AgentRunProgress | null {
  const all = useSyncExternalStore(subscribe, runProgressSnapshot, runProgressSnapshot);
  if (runId === null) {
    return null;
  }
  const key = runId.toLowerCase();
  for (const list of all.values()) {
    const hit = list.find(row => row.id === key);
    if (hit !== undefined) {
      return hit;
    }
  }
  return null;
}

const EMPTY_ROWS: readonly AgentRunProgress[] = [];

function emit(next: ReadonlyMap<string, readonly AgentRunProgress[]>): void {
  byChannel = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 테스트/진단 seam. */
export const runProgressSnapshot = (): ReadonlyMap<
  string,
  readonly AgentRunProgress[]
> => byChannel;

/** 이 서버가 진행 읽기를 싣지 않는다고 답했는가. */
export const runProgressUnsupported = (): boolean => unsupported;

/** 스토어가 바뀔 때마다 부른다. 레일이 신호를 다시 합치는 데 쓴다. */
export function subscribeRunProgress(listener: () => void): () => void {
  return subscribe(listener);
}

function allRows(): AgentRunProgress[] {
  const out: AgentRunProgress[] = [];
  for (const rows of byChannel.values()) {
    out.push(...rows);
  }
  return out;
}

/** 서버가 아는 run id 전부(끝난 것 포함). 레일은 이 run들의 옛 추정을 버린다. */
export function knownRunIds(): Set<string> {
  return new Set(allRows().map(row => row.id));
}

/** 열린 run을 열린 턴 신호로. 끝난 run은 신호가 아니다. */
export function runProgressSignals(): AgentWorkingSignal[] {
  const out: AgentWorkingSignal[] = [];
  for (const row of allRows()) {
    const signal = signalFromProgress(row);
    if (signal !== null) {
      out.push(signal);
    }
  }
  return out;
}

/** 이 run에 대한 서버의 답. 서버가 모르는 run(관리형·BYOA·옛 서버)이면 null. */
export function runFactsFor(runId: string): ServerRunFacts | null {
  const key = runId.toLowerCase();
  for (const rows of byChannel.values()) {
    const hit = rows.find(row => row.id === key);
    if (hit !== undefined) {
      return serverFactsOf(hit);
    }
  }
  return null;
}

export function useRunFacts(runId: string | null): ServerRunFacts | null {
  const rows = useSyncExternalStore(subscribe, runProgressSnapshot, runProgressSnapshot);
  if (runId === null) {
    return null;
  }
  const key = runId.toLowerCase();
  for (const list of rows.values()) {
    const hit = list.find(row => row.id === key);
    if (hit !== undefined) {
      return serverFactsOf(hit);
    }
  }
  return null;
}

function sameRows(
  a: readonly AgentRunProgress[] | undefined,
  b: readonly AgentRunProgress[],
): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export interface RunProgressOptions {
  workspaceId: string;
  /** 에이전트가 있는 채널들. */
  channelIds: readonly string[];
  rail: ChannelRail | null;
  /** 시험이 주입한다. */
  fetchProgress?: FetchProgress;
  pollMs?: number;
}

/**
 * 진행 읽기를 시작한다. 반환값은 멈추는 함수다(타이머·구독 정리, 이미 읽은 값은 남겨
 * 둔다: 워크스페이스 전환은 `resetRunProgress`가 비운다).
 */
export function startRunProgress(options: RunProgressOptions): () => void {
  const fetcher = options.fetchProgress ?? fetchAgentRunProgress;
  const channels = [
    ...new Set(options.channelIds.map(id => id.toLowerCase())),
  ];
  let stopped = false;
  const inflight = new Map<string, {dirty: boolean}>();

  async function refresh(channelId: string): Promise<void> {
    if (stopped || unsupported) {
      return;
    }
    const running = inflight.get(channelId);
    if (running !== undefined) {
      // 프레임이 몰리면 읽기를 겹치지 않고, 끝난 뒤 한 번 더 읽는다.
      running.dirty = true;
      return;
    }
    const slot = {dirty: false};
    inflight.set(channelId, slot);
    try {
      const rows = await fetcher(options.workspaceId, channelId, {
        state: 'all',
        limit: PAGE_LIMIT,
      });
      if (stopped) {
        return;
      }
      if (!sameRows(byChannel.get(channelId), rows)) {
        const next = new Map(byChannel);
        next.set(channelId, rows);
        emit(next);
      }
    } catch (error) {
      if (stopped) {
        return;
      }
      if (serverSaysAbsent(error) || error instanceof WireShapeError) {
        // 이 서버에는 없거나, 이 클라이언트가 읽지 못하는 모양이다. 한 번만 접고 옛
        // 규칙으로 돌아간다 — 읽지 못하는 것을 조용히 비어 있다고 말하지 않고,
        // 반복해서 두드리지도 않는다.
        unsupported = true;
        if (byChannel.size > 0) {
          emit(new Map());
        }
      }
      // 그 밖의 오류(네트워크·5xx·403)는 직전 답을 그대로 둔다. 다음 신호나 타이머가
      // 다시 읽는다.
    } finally {
      inflight.delete(channelId);
      if (slot.dirty && !stopped && !unsupported) {
        void refresh(channelId);
      }
    }
  }

  const unsubscribers: Array<() => void> = [];
  for (const channelId of channels) {
    const stop = options.rail?.subscribeRunEvents(options.workspaceId, channelId, {
      onRunEvent: frame => {
        void refresh(channelId);
        if (frame !== undefined) {
          notifyRunLedgerFrame(frame.payload.run_id);
        }
      },
      onResync: () => void refresh(channelId),
    });
    if (stop !== undefined) {
      unsubscribers.push(stop);
    }
  }
  for (const channelId of channels) {
    void refresh(channelId);
  }
  const nudge = (channelId: string) => {
    if (channels.includes(channelId)) {
      void refresh(channelId);
    }
  };
  nudgeChannel = nudge;

  const timer = setInterval(() => {
    for (const channelId of channels) {
      const rows = byChannel.get(channelId);
      if (rows?.some(row => isOpenRunPhase(row.phase)) === true) {
        void refresh(channelId);
      }
    }
  }, options.pollMs ?? RUN_PROGRESS_POLL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (nudgeChannel === nudge) {
      nudgeChannel = null;
    }
    for (const stop of unsubscribers) {
      stop();
    }
  };
}

/** 세션 종료·워크스페이스 전환: 이전 워크스페이스의 run을 물려주지 않는다. */
export function resetRunProgress(): void {
  unsupported = false;
  resetRunLedgerIncludeProbe();
  if (byChannel.size > 0) {
    emit(new Map());
  }
}

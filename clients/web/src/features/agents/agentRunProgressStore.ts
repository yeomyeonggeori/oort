import { useSyncExternalStore } from "react";
import {
  fetchAgentRunProgress,
  resetRunLedgerIncludeProbe,
  type AgentRunProgress,
} from "@momo/core/lib/api";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import { WireShapeError } from "@momo/core/lib/wire";
import {
  isOpenRunPhase,
  serverFactsOf,
  signalFromProgress,
} from "@momo/core/features/agents/runPhase";
import type {
  AgentWorkingSignal,
  ServerRunFacts,
} from "@momo/core/features/agents/workingSignal";
import type { RealtimeHandle } from "@momo/core/lib/realtimeEvents";

// =============================================================================
// 서버가 파생한 run 상태의 web 접합 (ADR-0200 D1·D3, #3747).
//
// 규칙(phase → 낱말)은 core의 `runPhase`에 있다. 여기는 그 규칙이 아닌 것뿐이다:
// 모듈 전역 맵, `useSyncExternalStore` 구독, 그리고 **언제 다시 읽는가**.
//
// 다시 읽는 때는 셋이다.
//   1. `agent.run.event` 프레임(채널 토픽). 프레임에는 단계 문자열도 순번도 없다.
//      「원장이 바뀌었다」는 신호일 뿐이라 이 채널의 진행 목록을 통째로 다시 읽는다.
//   2. 재구독(`onResync`). 끊긴 동안의 프레임은 오지 않는다.
//   3. **열린 run이 있는 동안 30초마다.** 서버 지시: stage 프레임은 run당 2초에
//      하나로 합쳐 오고, 한 묶음의 마지막 행은 프레임 없이 끝날 수 있다.
//
// 구 서버(진행 읽기 경로가 없는 v0.1.22)는 404/405/501로 답한다. 그 답은 장애가
// 아니라 「이 서버에는 없다」이므로 한 번만 확인하고 접는다: 이후에는 요청도
// 타이머도 없고, 표면은 이 PR 이전처럼 프레임 시계 규칙으로 동작한다.
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
// 진행 읽기는 채널 단위지만 원장은 run 단위다. 그리고 깨우는 신호 행(`doorbell_rung`)은
// 서버가 진행의 `lastEventAtMs`에서 뺀다 — 진행의 지문이 바뀌지 않으므로, 프레임을
// 버리면 「깨우는 신호 보냄」은 다음 30초 타이머까지 서지 않는다. 그래서 프레임이 온
// run을 따로 알려 준다. 원장을 들고 있는 훅이 듣고 다시 읽는다.
const ledgerFrameListeners = new Map<string, Set<() => void>>();

/** 이 run의 원장에 행이 생겼다는 프레임을 듣는다. 반환값은 멈추는 함수다. */
export function subscribeRunLedgerFrames(runId: string, listener: () => void): () => void {
  const key = runId.toLowerCase();
  let set = ledgerFrameListeners.get(key);
  if (set === undefined) {
    set = new Set();
    ledgerFrameListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = ledgerFrameListeners.get(key);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) ledgerFrameListeners.delete(key);
  };
}

/** 시험 seam: 프레임 하나가 이 run의 원장 구독자에게 닿는다. */
export function notifyRunLedgerFrame(runId: string): void {
  const set = ledgerFrameListeners.get(runId.toLowerCase());
  if (set === undefined) return;
  for (const listener of [...set]) listener();
}

// ---- 채널 하나를 지금 다시 읽기 (#3824) -------------------------------------------
// 보낸 메시지 아래 상태 줄은 1초 안에 「받았어요」를 말해야 한다. 서버는 run을 만들 때
// 프레임을 내지만, 소켓이 막 다시 붙는 중이면 그 프레임이 늦거나 오지 않는다. 내가 보낸
// 메시지가 화면에 서면 그 채널을 한 번 다시 읽는다(`nudgeRunProgress`). 지켜보지 않는
// 채널(에이전트가 없는 채널)이면 아무 일도 하지 않는다.
let nudgeChannel: ((channelId: string) => void) | null = null;

export function nudgeRunProgress(channelId: string): void {
  nudgeChannel?.(channelId.toLowerCase());
}

function emit(next: ReadonlyMap<string, readonly AgentRunProgress[]>): void {
  byChannel = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
  for (const rows of byChannel.values()) out.push(...rows);
  return out;
}

/** 서버가 아는 run id 전부(끝난 것 포함). 레일은 이 run들의 옛 추정을 버린다. */
export function knownRunIds(): Set<string> {
  return new Set(allRows().map((row) => row.id));
}

/** 열린 run을 열린 턴 신호로. 끝난 run은 신호가 아니다. */
export function runProgressSignals(): AgentWorkingSignal[] {
  const out: AgentWorkingSignal[] = [];
  for (const row of allRows()) {
    const signal = signalFromProgress(row);
    if (signal !== null) out.push(signal);
  }
  return out;
}

/** 이 run에 대한 서버의 답. 서버가 모르는 run(관리형·BYOA·옛 서버)이면 null. */
export function runFactsFor(runId: string): ServerRunFacts | null {
  const key = runId.toLowerCase();
  for (const rows of byChannel.values()) {
    const hit = rows.find((row) => row.id === key);
    if (hit !== undefined) return serverFactsOf(hit);
  }
  return null;
}

export function useRunFacts(runId: string | null): ServerRunFacts | null {
  const rows = useSyncExternalStore(subscribe, runProgressSnapshot, runProgressSnapshot);
  if (runId === null) return null;
  const key = runId.toLowerCase();
  for (const list of rows.values()) {
    const hit = list.find((row) => row.id === key);
    if (hit !== undefined) return serverFactsOf(hit);
  }
  return null;
}

/** 한 채널의 진행 목록(끝난 최근 run 포함). 서버가 모르는 채널이면 빈 배열. */
export function useChannelRuns(channelId: string | null): readonly AgentRunProgress[] {
  const all = useSyncExternalStore(subscribe, runProgressSnapshot, runProgressSnapshot);
  return channelId === null ? EMPTY_ROWS : (all.get(channelId.toLowerCase()) ?? EMPTY_ROWS);
}

/** run id로 한 줄을 찾는다(다른 채널의 앞선 일의 제목을 읽을 때). */
export function useRunRow(runId: string | null): AgentRunProgress | null {
  const all = useSyncExternalStore(subscribe, runProgressSnapshot, runProgressSnapshot);
  if (runId === null) return null;
  const key = runId.toLowerCase();
  for (const list of all.values()) {
    const hit = list.find((row) => row.id === key);
    if (hit !== undefined) return hit;
  }
  return null;
}

const EMPTY_ROWS: readonly AgentRunProgress[] = [];

function sameRows(
  a: readonly AgentRunProgress[] | undefined,
  b: readonly AgentRunProgress[]
): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export interface RunProgressOptions {
  workspaceId: string;
  /** 에이전트가 있는 채널들. */
  channelIds: readonly string[];
  realtime: RealtimeHandle | null;
  /** 시험이 주입한다. */
  fetchProgress?: FetchProgress;
  pollMs?: number;
}

/**
 * 진행 읽기를 시작한다. 반환값은 멈추는 함수다(타이머·구독 정리, 이미 읽은 값은
 * 남겨 둔다: 워크스페이스 전환은 `resetRunProgress`가 비운다).
 */
export function startRunProgress(options: RunProgressOptions): () => void {
  const fetcher = options.fetchProgress ?? fetchAgentRunProgress;
  const channels = [...new Set(options.channelIds.map((id) => id.toLowerCase()))];
  let stopped = false;
  const inflight = new Map<string, { dirty: boolean }>();

  async function refresh(channelId: string): Promise<void> {
    if (stopped || unsupported) return;
    const running = inflight.get(channelId);
    if (running !== undefined) {
      // 프레임이 몰리면 읽기를 겹치지 않고, 끝난 뒤 한 번 더 읽는다.
      running.dirty = true;
      return;
    }
    const slot = { dirty: false };
    inflight.set(channelId, slot);
    try {
      const rows = await fetcher(options.workspaceId, channelId, {
        state: "all",
        limit: PAGE_LIMIT,
      });
      if (stopped) return;
      if (!sameRows(byChannel.get(channelId), rows)) {
        const next = new Map(byChannel);
        next.set(channelId, rows);
        emit(next);
      }
    } catch (error) {
      if (stopped) return;
      if (serverSaysAbsent(error) || error instanceof WireShapeError) {
        // 이 서버에는 없거나, 이 클라이언트가 읽지 못하는 모양이다. 한 번만 접고
        // 옛 규칙으로 돌아간다 — 읽지 못하는 것을 조용히 비어 있다고 말하지 않고,
        // 반복해서 두드리지도 않는다.
        unsupported = true;
        if (byChannel.size > 0) emit(new Map());
      }
      // 그 밖의 오류(네트워크·5xx·403)는 직전 답을 그대로 둔다. 다음 신호나 타이머가
      // 다시 읽는다.
    } finally {
      inflight.delete(channelId);
      if (slot.dirty && !stopped && !unsupported) void refresh(channelId);
    }
  }

  const unsubscribers: Array<() => void> = [];
  for (const channelId of channels) {
    const stop = options.realtime?.subscribeRunEvents?.(
      options.workspaceId,
      channelId,
      {
        onRunEvent: (frame) => {
          void refresh(channelId);
          notifyRunLedgerFrame(frame.payload.run_id);
        },
        onResync: () => void refresh(channelId),
      }
    );
    if (stop !== undefined) unsubscribers.push(stop);
  }
  for (const channelId of channels) void refresh(channelId);
  const nudge = (channelId: string) => {
    if (channels.includes(channelId)) void refresh(channelId);
  };
  nudgeChannel = nudge;

  const timer = setInterval(() => {
    for (const channelId of channels) {
      const rows = byChannel.get(channelId);
      if (rows?.some((row) => isOpenRunPhase(row.phase)) === true) {
        void refresh(channelId);
      }
    }
  }, options.pollMs ?? RUN_PROGRESS_POLL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (nudgeChannel === nudge) nudgeChannel = null;
    for (const stop of unsubscribers) stop();
  };
}

/** 세션 종료·워크스페이스 전환: 이전 워크스페이스의 run을 물려주지 않는다. */
export function resetRunProgress(): void {
  unsupported = false;
  resetRunLedgerIncludeProbe();
  if (byChannel.size > 0) emit(new Map());
}

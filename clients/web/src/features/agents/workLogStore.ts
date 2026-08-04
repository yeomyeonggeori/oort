import { useEffect, useSyncExternalStore } from "react";
import type { AgentProgressEvent } from "@momo/core/lib/realtimeEvents";
import {
  appendProgress,
  openWorkLog,
  type WorkLog,
  type WorkLogTarget,
} from "@momo/core/features/agents/workLog";

// =============================================================================
// 작업 패널의 web 접합 (goal WEB-WP1).
//
// 규칙은 전부 `@momo/core/features/agents/workLog`에 있다. 여기 남는 것은 그
// 규칙이 아닌 것뿐이다: 모듈 전역 맵, `useSyncExternalStore` 구독, 그리고 어떤
// run을 지금 보고 있는지. agentWorkingSignal.ts가 RN-A1에서 정확히 같은 모양으로
// 갈린 이유와 같다. 폰 시트는 core 절반을 그대로 쓰고 저장소는 자기 것을 갖는다.
//
// ## 왜 "보는 동안만" 쌓는가 (D1 = 휘발 관전 v0)
//
// 이 스토어는 **구독된 run만** 기록한다. 패널을 닫으면 그 run의 로그는 지워지고,
// 다시 열면 그 시점부터 다시 쌓인다. 두 가지를 동시에 얻는다:
//
//   - 저장하지 않겠다는 결정(D1)이 코드에서 참이다. 앱 세션 메모리조차 "보고 있는
//     동안"으로 좁혀지므로, 아무도 안 보는 run의 델타가 탭을 켜 둔 하루 동안
//     쌓이는 일이 없다.
//   - 다시 열었을 때 "이 지점부터 관전" 고지가 **항상** 참이 된다. 앞부분이
//     있는 척할 수 있는 경로가 아예 없다.
//
// TTL/zombie는 workingSignal 규율을 준용하되 자리가 다르다. 90초 TTL은 삭제가
// 아니라 문장이다(`workLogLiveness` → 신호 소실): 패널이 열려 있는 동안 조용해진
// run을 지워 버리면 사람이 보고 있던 화면이 이유 없이 비고, "끝났다"로도
// 읽힌다. 하드 클리어(zombie)는 마지막 구독자가 놓는 순간이다.
// =============================================================================

type RunKey = string;

function keyOf(runId: string): RunKey {
  return runId.toLowerCase();
}

let logs: ReadonlyMap<RunKey, WorkLog> = new Map();
const watchers = new Map<RunKey, number>();
const listeners = new Set<() => void>();

function emit(next: ReadonlyMap<RunKey, WorkLog>): void {
  logs = next;
  for (const listener of listeners) listener();
}

/**
 * 이 run을 보기 시작한다. 첫 구독자가 로그를 열고, 마지막 구독자가 놓을 때
 * 로그가 사라진다(D1). 반환값은 놓는 함수다.
 */
export function watchWorkLog(target: WorkLogTarget, nowMs: number): () => void {
  const key = keyOf(target.runId);
  watchers.set(key, (watchers.get(key) ?? 0) + 1);
  if (!logs.has(key)) {
    const next = new Map(logs);
    next.set(key, openWorkLog(target, nowMs));
    emit(next);
  }

  let released = false;
  return () => {
    if (released) return; // 이중 정리가 남의 구독을 놓아 주면 안 된다
    released = true;
    const count = (watchers.get(key) ?? 1) - 1;
    if (count > 0) {
      watchers.set(key, count);
      return;
    }
    watchers.delete(key);
    if (!logs.has(key)) return;
    const next = new Map(logs);
    next.delete(key);
    emit(next);
  };
}

/**
 * 레일이 받은 프레임 하나를 넘긴다. 아무도 안 보는 run이면 아무 일도 없다 —
 * 이 한 줄이 "휘발 관전"을 정책이 아니라 사실로 만든다.
 */
export function recordAgentProgress(event: AgentProgressEvent): void {
  const runId = event.payload.run_id;
  if (typeof runId !== "string" || runId === "") return;
  const key = keyOf(runId);
  const current = logs.get(key);
  if (current === undefined) return;
  const next = appendProgress(current, event, Date.now());
  if (next === current) return;
  const map = new Map(logs);
  map.set(key, next);
  emit(map);
}

/** 세션 종료·워크스페이스 전환: 남은 것을 물려주지 않는다. */
export function resetWorkLogs(): void {
  watchers.clear();
  if (logs.size === 0) return;
  emit(new Map());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ReadonlyMap<RunKey, WorkLog> {
  return logs;
}

/** 테스트/진단 seam: React 구독 없이 원본을 본다. */
export const workLogSnapshot = snapshot;

/**
 * 이 run의 로그를 구독한다. `target`이 null이면 아무것도 구독하지 않는다(패널이
 * 닫혀 있는 경우).
 */
export function useWorkLog(target: WorkLogTarget | null): WorkLog | null {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  const runId = target?.runId ?? null;
  const memberId = target?.memberId ?? null;
  const channelId = target?.channelId ?? null;

  useEffect(() => {
    if (runId === null || memberId === null || channelId === null) return;
    return watchWorkLog({ runId, memberId, channelId }, Date.now());
  }, [runId, memberId, channelId]);

  return runId === null ? null : (all.get(keyOf(runId)) ?? null);
}

// ---- 무엇을 열어 두었는가 -----------------------------------------------------

/** 패널이 지금 열고 있는 run. 열려 있지 않으면 null. */
export interface WorkPanelTarget extends WorkLogTarget {
  /**
   * run을 연 자리. 진입점이 둘(대화 활동 줄, 에이전트 허브의 현재 작업)이고,
   * 닫을 때 캐럿을 어디로 돌려줄지는 연 쪽이 안다.
   */
  origin: "activity" | "hub";
}

let panelTarget: WorkPanelTarget | null = null;
const panelListeners = new Set<() => void>();

function emitPanel(next: WorkPanelTarget | null): void {
  panelTarget = next;
  for (const listener of panelListeners) listener();
}

export function openWorkPanel(target: WorkPanelTarget): void {
  const same =
    panelTarget !== null &&
    keyOf(panelTarget.runId) === keyOf(target.runId) &&
    panelTarget.origin === target.origin;
  if (same) return;
  emitPanel(target);
}

export function closeWorkPanel(): void {
  if (panelTarget === null) return;
  emitPanel(null);
}

function subscribePanel(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

function panelSnapshot(): WorkPanelTarget | null {
  return panelTarget;
}

/** 테스트/진단 seam: React 구독 없이 지금 열려 있는 대상을 본다. */
export const workPanelSnapshot = panelSnapshot;

export function useWorkPanelTarget(): WorkPanelTarget | null {
  return useSyncExternalStore(subscribePanel, panelSnapshot, panelSnapshot);
}

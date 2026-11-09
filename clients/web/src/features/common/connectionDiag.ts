import {
  appendConnectionDiag,
  parseConnectionDiag,
  serializeConnectionDiag,
  startWakeWatch,
  type ConnectionDiagEntry,
  type ConnectionDiagKind,
} from "@momo/core/features/connection/diagnosticLog";
import { isDesktop } from "@/lib/tauri";

// =============================================================================
// 연결 판정 진단 기록의 웹 저장소 (#5587). 모양·상한·읽는 법은 코어 `diagnosticLog.ts`가 갖고, 여기는 이 기기의 localStorage에
// 두고 꺼내는 일만 한다.
//
// - **데스크탑 앱에서만** 남긴다: 기록을 꺼내 보는 자리(설정 > 업데이트)가 데스크탑에만 있다. 브라우저 탭에 아무도 못 보는 기록을
//   쌓지 않는다.
// - 시각과 종류 낱말만 남긴다(코어의 닫힌 표). 서버로 보내지 않는다. 저장소가 없거나 가득 차도 앱은 그대로다(전부 try/catch).
// - 늦게 깬 타이머를 재는 시계는 앱에 하나다(`startConnectionDiagWatch`가 두 번 불려도 한 번만 건다).
// =============================================================================

const STORAGE_SLOT = "momo.connection.diag.v1";

let cache: ConnectionDiagEntry[] | null = null;
let stopWatch: (() => void) | null = null;
const listeners = new Set<() => void>();

function enabled(): boolean {
  return isDesktop();
}

function load(): ConnectionDiagEntry[] {
  if (cache !== null) return cache;
  let raw: unknown = null;
  try {
    const stored = window.localStorage.getItem(STORAGE_SLOT);
    raw = stored === null ? null : JSON.parse(stored);
  } catch {
    raw = null; // 저장소가 없거나 깨진 값: 빈 기록에서 시작한다.
  }
  cache = parseConnectionDiag(raw, Date.now());
  return cache;
}

const EMPTY: readonly ConnectionDiagEntry[] = [];

/** 지금까지의 기록(오래된 것부터). 데스크탑이 아니면 늘 비어 있다. 바뀌지 않았으면 같은 배열이다(`useSyncExternalStore`가 읽는다). */
export function readConnectionDiag(): readonly ConnectionDiagEntry[] {
  return enabled() ? load() : EMPTY;
}

/** 한 건을 남긴다. 데스크탑이 아니면 아무것도 하지 않는다. */
export function recordConnectionDiag(kind: ConnectionDiagKind, at: number = Date.now()): void {
  if (!enabled()) return;
  const next = appendConnectionDiag(load(), { at, kind });
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_SLOT, serializeConnectionDiag(next));
  } catch {
    // 저장소가 가득 찼거나 막혔다: 이번 실행 동안은 메모리의 기록이 남는다.
  }
  notify();
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 기록을 읽는 화면의 오류가 기록을 남기는 쪽으로 번지지 않게.
    }
  }
}

/**
 * 기록을 비운다(설정 카드가 기록을 읽지 못했을 때의 「기록 비우기」, 수리 1회차 H1). 저장소 칸과 메모리를 함께 비우고, 다음 기록부터
 * 새로 쌓는다. 저장소가 막혀 있어도 메모리는 비운다.
 */
export function clearConnectionDiag(): void {
  cache = [];
  try {
    window.localStorage.removeItem(STORAGE_SLOT);
  } catch {
    // 저장소가 막혔다: 이번 실행 동안은 빈 메모리 기록으로 간다.
  }
  notify();
}

/** 기록이 늘 때마다 알린다(설정 카드가 열려 있는 동안 다시 그린다). 돌려주는 함수가 해지다. */
export function subscribeConnectionDiag(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 늦게 깬 타이머를 재는 시계를 건다. 앱에 하나만 서고, 데스크탑이 아니면 걸지 않는다. */
export function startConnectionDiagWatch(): void {
  if (stopWatch !== null || !enabled()) return;
  stopWatch = startWakeWatch({
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onLate: (kind, at) => recordConnectionDiag(kind, at),
  });
}

/** 시험 전용: 메모리 기록과 시계를 처음으로 되돌린다(저장소는 시험이 비운다). */
export function resetConnectionDiagForTest(): void {
  stopWatch?.();
  stopWatch = null;
  cache = null;
  listeners.clear();
}

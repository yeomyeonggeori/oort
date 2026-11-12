import { startWakeWatch, type ConnectionDiagKind } from "@momo/core/features/connection/diagnosticLog";

// =============================================================================
// 늦게 깬 시계를 앱에 하나만 둔다 (#5587 → #5660). 5초마다 깨는 시계가 예정보다 10초 넘게 늦게 깨면 그동안 이 페이지가 돌지 않은
// 것이다(맥 잠자기, 웹뷰 멈춤). 이 사실을 읽는 쪽이 둘이다: 진단 기록(`connectionDiag.ts`, 데스크탑만)과 소켓을 다시 열지 정하는
// 연결 공급자(`connectionModel.tsx`). 둘이 각자 시계를 걸면 같은 깨어남을 두 시계가 따로 잰다: 듣는 쪽이 있는 동안 시계는 하나다.
// =============================================================================

export type LateWakeListener = (kind: ConnectionDiagKind, at: number, lateMs: number) => void;

const listeners = new Set<LateWakeListener>();
let stop: (() => void) | null = null;

function notify(kind: ConnectionDiagKind, at: number, lateMs: number): void {
  for (const listener of [...listeners]) {
    try {
      listener(kind, at, lateMs);
    } catch {
      // 한 쪽의 오류가 다른 쪽에 닿지 않게.
    }
  }
}

/** 늦게 깬 순간마다 알린다. 첫 구독이 시계를 걸고 마지막 해지가 거둔다. 돌려주는 함수가 해지다. */
export function subscribeLateWake(listener: LateWakeListener): () => void {
  listeners.add(listener);
  if (stop === null) {
    stop = startWakeWatch({
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onLate: notify,
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stop !== null) {
      stop();
      stop = null;
    }
  };
}

/** 시험 전용: 구독과 시계를 처음으로 되돌린다. */
export function resetWakeWatchForTest(): void {
  listeners.clear();
  stop?.();
  stop = null;
}

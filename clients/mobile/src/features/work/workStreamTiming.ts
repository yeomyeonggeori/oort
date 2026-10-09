import {
  uuidEq,
} from '@momo/core/lib/api';
import type {WorkSession} from '@momo/core/lib/api';
import type {WorkSessionEvent} from '@momo/core/features/work/workSessionModel';

// =============================================================================
// 첫 글자까지 · 총 시간 (N2 #3594).
//
// 기록하는 곳은 이 모듈의 메모리 링 하나다(`realtime/diagnostics.ts`와 같은 규율: 로컬·
// 한정·내용 없음). 화면에 보이지 않고 저장·전송하지 않는다. 개발 빌드(`__DEV__`)에서는
// 한 세션이 끝날 때 한 줄을 콘솔에 남기고, 시험과 캡처 하네스는 `workStreamTimings()`로
// 읽는다. 문자열은 하나도 담지 않는다: 세션 id와 숫자뿐이다.
//
// 시계는 서버 시각(세션 `startedAtMs` ↔ 이벤트 `atMs`)이다. 폰 시계와 섞지 않으므로 폰
// 시계가 어긋나도 값이 변하지 않는다. 호스트가 찍은 `event_ts`가 서버 시계와 어긋나면 그만큼
// 어긋난다 - 그래서 음수가 나오면 0으로 자른다(거짓 음수를 기록하지 않는다).
// =============================================================================

export interface WorkStreamTiming {
  sessionId: string;
  /** 시작 → 첫 `agent.partial`, ms. 아직 한 조각도 없으면 null. */
  firstTextMs: number | null;
  /** 시작 → 끝(종료 시각, 없으면 마지막 이벤트), ms. 이벤트가 없으면 null. */
  totalMs: number | null;
  /** 세션이 끝났는가(totalMs가 확정인가). */
  complete: boolean;
  /** 지금까지 받은 답 조각 수. */
  deltas: number;
}

export function computeStreamTiming(
  session: Pick<WorkSession, 'id' | 'startedAtMs' | 'endedAtMs' | 'status'>,
  events: readonly WorkSessionEvent[],
): WorkStreamTiming {
  let first: number | null = null;
  let last: number | null = null;
  let deltas = 0;
  for (const event of events) {
    if (!uuidEq(event.sessionId, session.id)) continue;
    last = last === null ? event.atMs : Math.max(last, event.atMs);
    if (event.type !== 'agent.partial') continue;
    deltas += 1;
    first = first === null ? event.atMs : Math.min(first, event.atMs);
  }
  const clamp = (value: number) => Math.max(0, value);
  const end = session.endedAtMs ?? last;
  return {
    sessionId: session.id,
    firstTextMs: first === null ? null : clamp(first - session.startedAtMs),
    totalMs: end === null ? null : clamp(end - session.startedAtMs),
    complete: session.status === 'ended' && session.endedAtMs !== undefined,
    deltas,
  };
}

export const STREAM_TIMING_CAPACITY = 16;

let ring: WorkStreamTiming[] = [];
let logged = new Set<string>();

/** 같은 세션의 값은 덮어쓴다(링 한 칸). 끝난 세션은 개발 빌드에서 한 번만 한 줄 남긴다. */
export function recordWorkStreamTiming(timing: WorkStreamTiming): void {
  if (timing.deltas === 0 && timing.totalMs === null) return;
  const key = timing.sessionId.toLowerCase();
  ring = ring.filter(entry => entry.sessionId.toLowerCase() !== key);
  ring.push(timing);
  if (ring.length > STREAM_TIMING_CAPACITY) {
    ring = ring.slice(ring.length - STREAM_TIMING_CAPACITY);
  }
  if (typeof __DEV__ !== 'undefined' && __DEV__ && timing.complete) {
    if (logged.has(key)) return;
    logged.add(key);
    console.info(
      `[work-stream] session=${timing.sessionId} firstTextMs=${String(
        timing.firstTextMs,
      )} totalMs=${String(timing.totalMs)} deltas=${timing.deltas}`,
    );
  }
}

export function workStreamTimings(): readonly WorkStreamTiming[] {
  return ring;
}

export function __resetWorkStreamTimings(): void {
  ring = [];
  logged = new Set();
}

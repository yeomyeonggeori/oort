import {useEffect, useState} from 'react';

// =============================================================================
// 작업 기록 시트의 마감 시계 (#4658). 시트는 열린 run을 그리는 동안 **1초 시계를 마운트하지 않는다**(옛 `useTickingNow`): 입력창 레일
// (#4620, `railClock`)과 같은 규칙이다. 시간만으로 사실이 바뀌는 순간(유예 마감 · 분 숫자가 오르는 때 · 조용함·머문 시간의 문턱)은
// 코어가 계산하고(`runDeadline.nextRunDeadlineMs`) 이 훅이 그 순간에 **한 번만** 다시 그린다. 끝난 run은 마감이 없다.
// =============================================================================

/** `setTimeout`이 한 번에 받는 상한(2^31 - 1ms). 넘기면 즉시 불린다. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * `deadlineMs`에 **한 번** 다시 그린다. 마감이 없으면 시계가 없다 — 이것이 시트에 남은 유일한 타이머이고 간격(`setInterval`)이 아니다.
 *
 * 불린 뒤에는 `tick`이 올라 효과가 다시 돈다: 마감이 지났으면 부르는 쪽이 다음 마감을 계산해 넘기고(`nextRunDeadlineMs`는 `nowMs`보다
 * 뒤의 순간만 돌려준다), 타이머가 벽시계보다 1ms 일찍 불려 같은 마감이 아직 남았으면 같은 마감을 남은 만큼 다시 건다 — 스스로 바로잡는다.
 */
export function useRerenderAt(deadlineMs: number | null): void {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (deadlineMs === null) {
      return undefined;
    }
    const id = setTimeout(
      () => setTick(current => current + 1),
      Math.min(Math.max(deadlineMs - Date.now(), 0), MAX_TIMEOUT_MS),
    );
    return () => clearTimeout(id);
  }, [deadlineMs, tick]);
}

import { useEffect, useState } from "react";

/** 브라우저 타이머가 받는 가장 긴 지연(32비트 부호 있는 정수). 넘으면 즉시 발화한다. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * 정해진 **한 시각**에 한 번만 다시 그린다. 돌려주는 값은 이 렌더의 시계(`Date.now()`)다.
 *
 * 매초 도는 시계(`useTickingNow`)와 다른 이유: 레일·칩·예외 줄은 경과를 말하지 않으므로 글자가
 * 시간에 따라 바뀌는 순간은 「받음」이 「아직 받지 않았어요」로 넘어가는 유예 마감 하나뿐이다. 그 한 순간을
 * 위해 줄마다 1Hz 재렌더를 세우면 타임라인의 모든 보이는 행이 초당 한 번 다시 그려진다
 * (폰 #4613이 잡은 「매초 갱신」과 같은 모양).
 *
 * `deadlineMs`가 null이면 타이머가 없다. 이미 지났으면 이번 렌더가 지난 뒤의 시계로 그려지므로
 * 더 할 일이 없다. 마감이 바뀌면(새 run·가져감) 타이머가 다시 선다.
 */
export function useRerenderAt(deadlineMs: number | null): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (deadlineMs === null) return undefined;
    const delay = deadlineMs - Date.now();
    if (delay <= 0) return undefined;
    // +1: 타이머가 마감 바로 앞에서 깨어나 같은 판정을 되풀이하지 않게 한다.
    const id = window.setTimeout(
      () => setTick((tick) => tick + 1),
      Math.min(delay + 1, MAX_TIMEOUT_MS)
    );
    return () => window.clearTimeout(id);
  }, [deadlineMs]);
  return Date.now();
}

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 상태줄이 문장을 쥐고 있는 시간 (ADR-0182 D5 ② = 3s).
 *
 * 숫자를 여기 한 번만 적는다. `3000ms` 같은 손기입 duration은 사다리 밖이라 프리플라이트가
 * 막고(ADR-0179 D10), 이 값은 CSS duration이 아니라 **문장이 남아 있는 시간**이라 모션
 * 사다리와 다른 축이다.
 */
export const TRANSIENT_STATUS_HOLD_MS = 3_000;

/**
 * 3초 동안만 서는 상태줄의 문장 (ADR-0182 ②). 토스트가 금지된 자리의 대안 문법이다.
 *
 * 팔레트 하단 상태줄(`usePaletteStatus`)이 처음 쓴 타이머를 그 표면에서 떼어 낸 것이다. 컴포저의
 * 예약 확정 줄이 같은 규율로 같은 시간을 쥐어야 하고(ADR-0208 부록 B 0.3), 같은 타이머를 두
 * 번 적으면 한쪽만 고쳐지는 날이 온다. 표면이 달라서 갈리는 것은 「언제 비우는가」 하나뿐이라
 * (팔레트는 열릴 때, 컴포저는 호출부가 정한다) 그것만 호출부 몫으로 남겼다.
 *
 * `announce(text)`는 이전 문장과 타이머를 바꿔치기한다: 3초 안에 다시 말하면 3초가 처음부터다.
 * `announce(null)`과 `clear()`는 즉시 비운다. 언마운트하면 타이머도 함께 끝난다.
 */
export function useTransientStatus(): {
  status: string | null;
  announce: (text: string | null) => void;
  clear: () => void;
} {
  const [status, setStatus] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  const announce = useCallback(
    (text: string | null) => {
      stopTimer();
      setStatus(text);
      if (text === null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setStatus(null);
      }, TRANSIENT_STATUS_HOLD_MS);
    },
    [stopTimer]
  );

  const clear = useCallback(() => announce(null), [announce]);

  return { status, announce, clear };
}

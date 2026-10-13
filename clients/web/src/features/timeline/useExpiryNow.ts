import { useEffect, useState } from "react";
import { EXPIRY_WARN_MS } from "@momo/core/features/approvals/expiry";

/**
 * 승인 카드의 기한을 지켜보는 시계 (#3738).
 *
 * 1초 틱이 아니라 **다음 경계까지 한 번** 잔다. 카드는 타임라인에 수십 장이 서
 * 있을 수 있고, 그 모두가 초마다 다시 그려질 이유는 없다. 경계는 둘이다:
 *
 *   - 만료 10분 전 → 경고 줄이 선다.
 *   - 경고 중에는 분이 바뀔 때(올림한 남은 분이 줄 때) → 숫자 하나가 움직인다.
 *   - 만료 정각 → 결정 컨트롤이 내려가고 「다시 제안」이 선다.
 *
 * `active`가 거짓이면(이미 끝난 카드·기한을 모르는 카드) 타이머를 만들지 않는다.
 * 반환값은 **이 렌더 자신의 `Date.now()`**다 — 타이머가 붙잡은 옛 값을 돌려주면
 * 시계가 멈춘 채 판정이 낡는다(`useTickingNow`가 적어 둔 같은 결함).
 */
export function useExpiryNow(
  expiresAtMs: number | undefined,
  active: boolean
): number {
  const [tick, bump] = useState(0);
  useEffect(() => {
    if (!active || expiresAtMs === undefined) return;
    const now = Date.now();
    const remaining = expiresAtMs - now;
    if (remaining <= 0) return;
    // 경고 창 밖: 창이 열리는 순간까지. 창 안: 다음 분 경계(남은 시간이 N분 → N-1분이
    // 되는 순간)까지, 단 만료를 넘기지 않는다.
    const delay =
      remaining > EXPIRY_WARN_MS
        ? remaining - EXPIRY_WARN_MS
        : Math.min(remaining, ((remaining - 1) % 60_000) + 1);
    // setTimeout 상한(2^31-1 ms ≈ 24.8일)을 넘는 기한은 그 상한에서 다시 잔다.
    const id = setTimeout(() => bump((n) => n + 1), Math.min(delay, 2_147_483_000));
    return () => clearTimeout(id);
    // `tick`이 의존성인 이유: 타이머는 한 번만 울리고, 울린 뒤 다음 경계를 다시 잡는
    // 것은 이 효과를 다시 도는 일이다.
  }, [active, expiresAtMs, tick]);
  return Date.now();
}

import { useEffect, useRef, useState } from "react";

// =============================================================================
// 느린 전송의 표지 (#4468, 폰 #4455와 같은 규칙) — 정상 전송에는 아무것도 깜빡이지 않는다.
//
// 옛 메아리(`PendingRow`)는 실패가 아니면 언제나 「전송 중」 줄을 그렸다. 정상 전송은 수백 ms 안에 서버 사본(`MessageRow`)으로
// 바뀌므로 그 줄은 **잠깐 서고 사라지는 글자**였고, 사라질 때 행이 한 줄(22px) 줄었다. 본문도 흐린 색(`text-ink-muted`)에서
// 진한 색으로, 첨부는 불투명도 0.7에서 1로 한 번 튀었다. 그래서 정상 전송의 메아리는 서버 사본과 **같은 모양**으로 서고,
// **오래 걸리는 전송만** 작은 시계 하나로 조용히 알린다. 새 줄은 만들지 않는다(시계는 흐름에 자리를 차지하지 않는다).
//
// ## 기준 시간 1.5초 = 폰과 같은 값
//
// 폰의 상수(`clients/mobile/src/features/conversation/sendSlow.ts` 의 `SEND_SLOW_MS`)는 폰 트리 안에 있고 이 훅은 React 를
// 부르므로 코어(`packages/momo-core`, 순수 규칙만 둔다 — `scripts/purity.mjs`)로 옮길 수 없다. 그래서 **같은 값을 같은
// 의미로** 이 파일에 둔다. 값의 근거는 폰 파일의 머리말이 정본이다: Nielsen 응답 시간 한계 1.0초(지연을 알아채는 한계)
// + 0.5초 여유, 정상 경로(수백 ms)를 건드리지 않고, 요청 마감(`REQUEST_TIMEOUT_MS`, 15초) 아래다. **한쪽을 고치면 다른 쪽도
// 같이 고친다.**
//
// ## 시작 시각
//
// 첫 시도는 **보낸 시각**(`createdAtMs`)에서 센다. 가상 목록이 화면 밖으로 내보냈다 다시 마운트한 메아리가 마운트 시각부터
// 다시 세면 이미 3초째 전송 중인 행이 시계 없이 또 1.5초를 보낸다. 반대로 이미 한계를 넘긴 채 마운트되면 첫 렌더부터 시계가
// 서 있다(한 프레임 늦게 생기지 않는다). 「다시 보내기」(`failed` → `sending`)는 새 시도라 그때부터 다시 센다 —
// `retryPending` 은 보낸 시각을 그대로 두므로(멱등키 재사용) 보낸 시각만 보면 재시도가 곧바로 시계를 띄운다.
//
// ## 보낸 시각이 지금보다 뒤일 때 (폰 파일에 없는 한 줄)
//
// 기기 시계가 뒤로 감기면(자동 보정) 보낸 시각이 지금보다 미래일 수 있다(디자인 갤러리의 고정 행도 미래 시각이다). 폰 식 그대로
// `SEND_SLOW_MS - (now - startedAt)` 이면 기다릴 시간이 1.5초가 아니라 미래까지의 거리가 되고, 브라우저의 `setTimeout` 은
// 2^31-1 ms(약 24.8일)를 넘는 값을 곧바로 터뜨린다 — 시계가 즉시 선다. 그래서 경과를 0 아래로 내리지 않는다: 아무리 미래여도
// 기다리는 시간은 최대 `SEND_SLOW_MS` 다.
// =============================================================================

/** 이 시간이 지나도록 전송 중이면 시계가 선다(ms). 폰 `SEND_SLOW_MS` 와 같은 값이다. 위 설명이 근거. */
export const SEND_SLOW_MS = 1500;

/** 이번 시도가 시작된 뒤 흐른 시간(ms). 시작이 미래면 0 — 위 마지막 절. */
const elapsedMs = (startedAtMs: number): number => Math.max(0, Date.now() - startedAtMs);

/**
 * 이 메아리의 지금 시도가 느린가. 실패한 행(`failed`)에는 거짓이다(실패는 자기 줄이 있다).
 *
 * 폰 훅(`useSlowSend(createdAtMs, status)`)과 달리 상태 글자 대신 `failed` 불리언을 받는다 — 직접 문구 장부(`direct-copy.mjs`)가
 * `"sending"`·`"failed"` 같은 한 낱말 글자를 문구로 세므로, 상태 비교는 이미 그 비교를 지고 있는 `PendingRow` 한 곳에만 둔다.
 *
 * `createdAtMs` 가 유한한 수가 아니면(알 수 없으면) 마운트 시각부터 센다.
 */
export function useSlowSend(createdAtMs: number, failed: boolean): boolean {
  // 이번 시도가 시작된 시각. 렌더 중에는 처음 한 번만 채운다(지연 초기화).
  const startedAt = useRef<number | null>(null);
  if (startedAt.current === null) {
    startedAt.current = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
  }
  const wasFailed = useRef(failed);

  const [slow, setSlow] = useState(() => !failed && elapsedMs(startedAt.current ?? 0) >= SEND_SLOW_MS);

  useEffect(() => {
    if (failed) {
      wasFailed.current = true;
      setSlow(false);
      return undefined;
    }
    // 실패했다가 다시 보내기: 새 시도.
    if (wasFailed.current) startedAt.current = Date.now();
    wasFailed.current = false;
    const left = SEND_SLOW_MS - elapsedMs(startedAt.current ?? 0);
    if (left <= 0) {
      setSlow(true);
      return undefined;
    }
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), left);
    return () => clearTimeout(timer);
  }, [failed]);

  return slow;
}

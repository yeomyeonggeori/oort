import {useEffect, useRef, useState} from 'react';

// =============================================================================
// 느린 전송의 표지 (#4455) — 정상 전송에는 아무것도 깜빡이지 않는다.
//
// 옛 메아리(`PendingRow`)는 실패가 아니면 언제나 「전송 중」 줄을 그렸다. 정상 전송은 수백 ms 안에
// 서버 사본으로 바뀌므로 그 줄은 **잠깐 서고 사라지는 글자**였고, 사라질 때 행이 14.7pt 줄었다
// (#4331 Maestro 실측 content 1509→1494.3). Buzz 는 정상 전송 중에 타임라인에 아무 글자도 흐림도
// 그리지 않는다(`channel_detail_page` 아래에 pending 표시 코드가 없고, 「Sending message」는
// 컴포저 전송 버튼 안 스피너의 접근성 라벨뿐이다). 그래서 정상 전송의 메아리는 서버 사본과 같은
// 모양으로 서고, **오래 걸리는 전송만** 작은 시계 하나로 조용히 알린다. 새 줄은 만들지 않는다.
//
// ## 기준 시간 1.5초
//
//   - 아래 한계. Nielsen 의 응답 시간 한계: 0.1초는 즉각, **1.0초는 사용자의 생각 흐름이 끊기지
//     않는 한계(지연은 알아챈다)**, 10초는 주의가 머무는 한계다. 1초 밑의 지연에는 보통 별도의
//     피드백이 필요 없고, 그 위로는 「언제 끝나는지」를 알려야 한다
//     (https://www.nngroup.com/articles/response-times-3-important-limits/). 1.0초 + 0.5초의
//     여유 — 사람이 지연을 알아챈 직후에 표지가 선다.
//   - 정상 경로를 건드리지 않는 여유. #4331 하네스의 가짜 서버가 확정본을 돌려주는 때가 ≈ 250ms 다
//     (운영 서버의 POST 응답 시간은 이 이슈에서 측정하지 않았다 — `runtime-unverified`). 등장
//     애니메이션(300ms)과 자격 창(1초)이 모두 끝난 뒤에 서므로 입장 움직임과 겹치지 않는다.
//   - 위 한계. 요청 마감은 `REQUEST_TIMEOUT_MS`(15초)이고 그 뒤에야 「전송 실패」가 선다. 1.5초
//     ~ 15초 사이가 이 표지의 몫이다.
//   2초도 방어할 수 있는 값이다(이슈는 1.5~2초). 1초 한계를 넘긴 지연을 더 오래 모른 체할 이유를
//   못 찾아 짧은 쪽을 골랐다. 값은 이 상수 하나다.
//
// ## 시작 시각
//
// 첫 시도는 **보낸 시각**(`createdAtMs`)에서 센다. 목록이 가상화되어 화면 밖으로 나갔다 돌아온
// 메아리가 마운트 시각부터 다시 세면, 이미 3초째 전송 중인 행이 표지 없이 다시 1.5초를 보낸다.
// 반대로 이미 한계를 넘긴 채 마운트되면 첫 렌더부터 표지가 서 있다(한 프레임 늦게 생기지 않는다).
// 「다시 보내기」(`failed` → `sending`)는 새 시도라 그때부터 다시 센다 — `retryPending` 은 보낸
// 시각을 그대로 두므로(멱등키 재사용) 보낸 시각만 보면 재시도가 곧바로 표지를 띄운다.
// =============================================================================

/** 이 시간이 지나도록 전송 중이면 표지가 선다(ms). 위 설명이 근거. */
export const SEND_SLOW_MS = 1500;

/**
 * 이 메아리의 지금 시도가 느린가. 실패한 행에는 거짓이다(실패는 자기 줄이 있다).
 *
 * `createdAtMs` 가 유한한 수가 아니면(알 수 없으면) 마운트 시각부터 센다.
 */
export function useSlowSend(
  createdAtMs: number,
  status: 'sending' | 'failed',
): boolean {
  // 이번 시도가 시작된 시각. 렌더 중에는 처음 한 번만 채운다(지연 초기화).
  const startedAt = useRef<number | null>(null);
  if (startedAt.current === null) {
    startedAt.current = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
  }
  const previous = useRef(status);

  const [slow, setSlow] = useState(
    () => status === 'sending' && Date.now() - (startedAt.current ?? 0) >= SEND_SLOW_MS,
  );

  useEffect(() => {
    if (status !== 'sending') {
      previous.current = status;
      setSlow(false);
      return undefined;
    }
    // 실패했다가 다시 보내기: 새 시도.
    if (previous.current === 'failed') startedAt.current = Date.now();
    previous.current = status;
    const left = SEND_SLOW_MS - (Date.now() - (startedAt.current ?? 0));
    if (left <= 0) {
      setSlow(true);
      return undefined;
    }
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), left);
    return () => clearTimeout(timer);
  }, [status]);

  return slow;
}

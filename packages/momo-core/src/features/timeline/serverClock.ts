// =============================================================================
// 서버 시계 어림 (#5624)
//
// 보내자마자 서는 줄(에코)은 이 기기의 시계로 시각을 얻고, 확정본은 서버가 찍은 시각을 싣고 온다. 같은 분 묶음 규칙(#5603)에서는
// 두 시각의 분이 다르면 묶음이 갈린다: 기기 시계가 서버와 1분 넘게 어긋난 사람은 이어 보내는 글마다 에코에 머리(64px)가 섰다가
// 확정 때 이어진 줄(36px)로 접히며 대화가 28px 출렁였다(검수 실측 72px, 어긋남 0이면 44px).
//
// 그래서 에코의 시각을 **서버 시계로** 어림한다. 표본은 에코 하나가 확정본으로 정착할 때마다 하나다(훅의 `applyBatch` —
// `pinSettledEchoes`가 돌려준 짝): 에코를 만든 기기 시각(`PendingMessage.createdAtMs`)과 확정본이 도착한 기기 시각 사이 어딘가에서
// 서버가 확정본의 `createdAtMs`를 찍었으므로, 그 값에서 두 순간의 가운데를 빼면 서버와 기기의 차이다. 확정본은 보내기 응답으로 오든
// 실시간 프레임으로 오든 같은 문을 지나므로 둘 다 표본이 된다. 오차는 왕복의 절반을 넘지 않는다. 본문의 밀리초 값이라 `Date` 머리(1초
// 단위, 다른 출처에서 읽히지 않을 수 있다)에 기대지 않는다.
//
// 거르는 것은 왕복 한도(`SERVER_CLOCK_MAX_ROUND_TRIP_MS`) 하나다. 다시 보낸 글(같은 멱등키 — 서버는 처음 만든 메시지를 돌려준다)·되살린
// 옛 실패 행·느린 연결·개인 에이전트 호출처럼 응답이 다른 일을 기다린 짝은 「보낸 시각 ~ 도착」 창이 넓어져 이 한도에서 버려진다. 그래서
// 한도를 풀면 지난 시각이 차이를 지어낸다. 가장 최근에 쓸 수 있었던 표본이 이긴다 — 기기 시계는 세션 중에도 뛴다(사람이 시각을 고치거나,
// 운영체제가 맞춘다).
//
// 이 값은 **에코의 묶음·날 줄·시각 글자에만** 쓴다(코어 `echoAtMs` = 기기 시각 + 지금의 차이; 에코 행에 따로 저장한 서버 시각은 없다).
// 기기의 `Date.now()`와 견주는 타이머(느린 전송 안내·도착 연출·자동 재전송)는 기기 시계 그대로인 `createdAtMs`를 읽는다. 정렬은 여전히
// seq가 정한다.
//
// 웹·데스크탑·폰이 이 한 곳을 쓴다. 한 JS 실행(웹 탭 하나, 앱 하나)에 값 하나다 — 서버는 하나이고, 채널마다 다를 이유가 없다.
// =============================================================================

/**
 * 표본으로 받는 가장 긴 왕복. 오차는 그 절반을 넘지 않으므로 2초 안이다 — 분 경계에 아주 가깝지 않은 한 묶음 판정을 바꾸지 못하고,
 * 분 경계에 가까운 경우는 확정본이 에코의 묶음을 그대로 잇는 것(`pinSettledEchoes`)이 맡는다.
 */
export const SERVER_CLOCK_MAX_ROUND_TRIP_MS = 4_000;

/** 에코 하나의 왕복: 기기 시계 두 순간과, 그 사이에 서버가 찍은 시각. */
export interface ServerClockSample {
  /** 에코를 만든 기기 시계(`PendingMessage.createdAtMs` — 요청이 떠나기 직전). 다시 보낸 글이면 첫 시도의 시각이다. */
  sentAtMs: number;
  /** 확정본이 도착한 기기 시계(보내기 응답이든 실시간 프레임이든). */
  receivedAtMs: number;
  /** 서버가 그 사이에 찍은 시각 — 확정본의 `createdAtMs`. */
  serverAtMs: number;
}

/**
 * 표본 하나가 말하는 차이(서버 − 기기, ms). 쓸 수 없는 표본이면 null: 수가 아니거나, 답이 요청보다 먼저 왔거나(기기 시계가 그 사이에
 * 뒤로 뛰었다), 왕복이 `SERVER_CLOCK_MAX_ROUND_TRIP_MS`보다 길다.
 */
export function serverClockOffsetMs(sample: ServerClockSample): number | null {
  const { sentAtMs, receivedAtMs, serverAtMs } = sample;
  if (![sentAtMs, receivedAtMs, serverAtMs].every(Number.isFinite)) return null;
  const roundTrip = receivedAtMs - sentAtMs;
  if (roundTrip < 0 || roundTrip > SERVER_CLOCK_MAX_ROUND_TRIP_MS) return null;
  return Math.round(serverAtMs - (sentAtMs + receivedAtMs) / 2);
}

// 한 실행에 값 하나. 아직 잰 적이 없으면 0(기기 시계 그대로) — 예전과 같은 동작이다.
let offsetMs = 0;

/**
 * 정착한 짝 하나로 차이를 다시 잰다. 쓴 표본이면 true.
 *
 * 훅은 정착한 짝을 가리지 않고 모두 넣는다 — 다시 보낸 글(서버가 처음 만든 메시지를 그대로 돌려주어 그 `createdAtMs`가 지난 시각이다)도
 * 창(`sentAtMs` = 첫 에코의 기기 시각)이 그만큼 넓어서 왕복 한도가 버린다. 한도가 유일한 거름이다.
 */
export function observeServerClock(sample: ServerClockSample): boolean {
  const measured = serverClockOffsetMs(sample);
  if (measured === null) return false;
  offsetMs = measured;
  return true;
}

/** 지금까지 잰 차이(서버 − 기기, ms). 잰 적이 없으면 0. */
export function serverClockOffsetNowMs(): number {
  return offsetMs;
}

/** 기기 시계의 한 순간을 서버 시계로 옮긴다. 지금 화면 코드는 쓰지 않는다(에코는 `echoAtMs`로 렌더마다 지금의 차이를 더한다) — 시험이 잰다. */
export function serverNowMs(deviceNowMs: number = Date.now()): number {
  return deviceNowMs + offsetMs;
}

/** 시험 전용: 잰 값을 잊는다. */
export function resetServerClockForTests(): void {
  offsetMs = 0;
}

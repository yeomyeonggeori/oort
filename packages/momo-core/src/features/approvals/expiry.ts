// =============================================================================
// 승인의 기한 — 「곧 만료」와 「이미 만료」를 클라이언트가 어떻게 아는가 (#3738)
//
// 실측(2026-10-13): 그록봇이 올린 `channel.create` 승인 카드를 사람이 보지 못했고
// 1시간 뒤 `approval_expired`로 끝났다. 그 사이 화면은 「작업 중」→「신호 소실」로만
// 말했다. 이 파일은 그 뒤 두 번째 방어선이다: 놓친 카드가 **죽기 전에** 한 번 더
// 말하고, 죽은 뒤에는 **다음 행동**(다시 제안해 달라고 하기)을 건넨다.
//
// ## 시계는 클라이언트의 것이고, 기한은 서버의 것이다
//
// 기한(`expires_at_ms`)은 서버가 카드 props 에 박아 보낸 사실이다. 카드 메시지는
// 스냅샷이라 서버가 만료시켜도 이 메시지의 `status` 는 저절로 바뀌지 않는다(REST
// 가 바뀐다). 그래서 「만료됐다」는 판정은 **스냅샷의 status 가 expired 이거나
// 기한이 지났거나**, 둘 중 하나로 선다. 기한만 보면 서버가 일찍 거둔 승인을 못
// 잡고, status 만 보면 새로고침 전까지 죽은 카드에 버튼이 서 있다.
//
// 기기 시계가 어긋나 있으면 이 판정도 어긋난다. 그 비용은 낮다: 일찍 만료로 읽으면
// 사람은 새 제안을 청하고(무해), 늦게 읽으면 누른 결정이 서버에서 거절된다(기존
// 경로가 말한다).
// =============================================================================

/** 만료 이 시간 전부터 경고한다. 이슈 #3738 「만료 10분 전 경고」. */
export const EXPIRY_WARN_MS = 10 * 60_000;

export type ExpiryPhase = "none" | "soon" | "expired";

/**
 * 남은 시간으로 본 국면.
 *
 * `soon` 은 (0, 10분] 이다 — 정확히 10분 남은 순간부터 경고하고, 0 이하는 만료다.
 * 기한을 모르면(`undefined`) `none` 이다: 없는 기한을 지어 경고하지 않는다.
 */
export function expiryPhase(
  expiresAtMs: number | null | undefined,
  nowMs: number
): ExpiryPhase {
  if (expiresAtMs === null || expiresAtMs === undefined) return "none";
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) return "expired";
  return remaining <= EXPIRY_WARN_MS ? "soon" : "none";
}

/** 올림한 남은 분. 59초 남았으면 「1분」이다 — 0분이라고 말하지 않는다. */
export function minutesLeft(expiresAtMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((expiresAtMs - nowMs) / 60_000));
}

/** 경고 줄. 숫자 하나만 움직이고 문장은 그대로다. */
export function expirySoonCopy(expiresAtMs: number, nowMs: number): string {
  return `${minutesLeft(expiresAtMs, nowMs)}분 안에 만료돼요. 결정하지 않으면 에이전트가 다시 제안해야 해요.`;
}

/** 만료 뒤 카드가 컨트롤 대신 말하는 줄. */
export const EXPIRED_CARD_COPY =
  "승인 시간이 지나서 더 이상 결정할 수 없어요.";

/** 만료 뒤의 다음 행동 버튼. */
export const REPROPOSE_LABEL = "다시 제안해 달라고 하기";

/**
 * 「다시 제안해 달라고 하기」가 입력창에 넣는 초안.
 *
 * 멘션은 `@handle` 한 토큰이다(서버가 멘션을 판정한다 — 클라이언트는 본문에서
 * 이름을 해석하지 않는다). 뒤에 공백을 둬서 사람이 이어 쓸 수 있게 한다.
 */
export function reproposeDraft(handle: string): string {
  return `@${handle} 아까 올린 승인 요청이 만료됐어요. 다시 제안해 주세요. `;
}

/**
 * 인박스 「처리할 일」 줄의 기한 말. 서버가 정한 기한이 이미 지난 줄은 결정 컨트롤이
 * 서지 않는다(`FeedItem.deadlinePassed`) — 여기는 그 줄이 무엇을 말하는지만 정한다.
 */
export const EXPIRED_ROW_COPY = "시간이 지났어요";

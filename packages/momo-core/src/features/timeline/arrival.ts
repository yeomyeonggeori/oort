import { uuidEq } from "../../lib/api";

/**
 * ADR-0179 D3 — 메시지 도착 모션의 재생 여부. 단일점.
 *
 * 와이어 `Message` 에 출처를 싣지 않는다. Postgres 는 도착 경로를 모르고,
 * 클라는 REST 페이지·실시간 프레임·리플레이 게이트를 가른 뒤에야 1비트를
 * 소비한다. 반환은 불리언이 아니라 **재생 횟수 0 또는 1** 이다.
 *
 * `settlesPending` 은 두지 않는다. 낙관 행은 항상 자기 작성이라 자기-작성
 * 가드가 이미 0 이고, 런타임이 만들 수 없는 OTHER+settlesPending 픽스처로만
 * 그 팔을 증명할 수 있었다.
 */

export type MessageArrivalProvenance = "live" | "rest" | "replay";

export type ArrivalEventType = "message.new" | "message.edited" | "rest";

/** Unmounted live grants kept for first mount. Older ones drop so a
 *  scrolled-up backlog cannot cascade on jump-to-bottom. */
export const MAX_PENDING_ARRIVAL_GRANTS = 1;

/** Consumed ledger cap per channel visit. Virtuoso remounts only recent rows. */
export const MAX_CONSUMED_ARRIVAL_IDS = 64;

export function capArrivalSet(ids: Set<string>, max: number): void {
  while (ids.size > max) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
}

export interface ArrivalDecisionInput {
  messageId: string;
  authorMemberId: string;
  selfMemberId: string;
  provenance: MessageArrivalProvenance;
  eventType: ArrivalEventType;
  alreadyHeld: boolean;
  reducedMotion: boolean;
}

export function shouldPlayMessageArrival(input: ArrivalDecisionInput): boolean {
  if (input.reducedMotion) return false;
  if (input.alreadyHeld) return false;
  if (input.provenance !== "live") return false;
  if (input.eventType !== "message.new") return false;
  if (uuidEq(input.authorMemberId, input.selfMemberId)) return false;
  return true;
}

/**
 * 1회 소비 장부. 같은 id 의 두 번째 호출은 가상화 재마운트이므로 0.
 * 자격이 없는 경로는 장부에 넣지 않는다 — 넣으면 나중에 진짜 라이브가
 * 같은 id 로 와도 영구히 0 이 된다.
 */
export function takeArrivalPlay(
  consumedIds: Set<string>,
  input: ArrivalDecisionInput
): 0 | 1 {
  const key = input.messageId.toLowerCase();
  if (consumedIds.has(key)) return 0;
  if (!shouldPlayMessageArrival(input)) return 0;
  consumedIds.add(key);
  return 1;
}

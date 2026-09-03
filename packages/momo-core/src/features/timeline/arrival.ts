import { uuidEq } from "../../lib/api";

/**
 * ADR-0179 D3 — 메시지 도착 모션의 재생 여부. 단일점.
 *
 * 와이어 `Message` 에 출처를 싣지 않는다. Postgres 는 도착 경로를 모르고,
 * 클라는 REST 페이지·실시간 프레임·리플레이 게이트를 가른 뒤에야 1비트를
 * 소비한다. 반환은 불리언이 아니라 **재생 횟수 0 또는 1** 이다.
 */

export type MessageArrivalProvenance = "live" | "rest" | "replay";

export type ArrivalEventType = "message.new" | "message.edited" | "rest";

export interface ArrivalDecisionInput {
  messageId: string;
  authorMemberId: string;
  selfMemberId: string;
  provenance: MessageArrivalProvenance;
  eventType: ArrivalEventType;
  settlesPending: boolean;
  alreadyHeld: boolean;
  reducedMotion: boolean;
}

export function shouldPlayMessageArrival(input: ArrivalDecisionInput): boolean {
  void input;
  void uuidEq;
  return false;
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
  void consumedIds;
  void input;
  return 0;
}

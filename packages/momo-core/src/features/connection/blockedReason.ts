import type { MessageArgs, MessageKey } from "../../i18n/generated/messages";
import { CONNECTION_KEYS } from "./copyKeys";
import type { ConnectionView } from "./model";

// =============================================================================
// 막힌 자리의 한 문장이 **막은 원인**에 맞는 사전 키를 고르는 규칙 (#5260, #5239 후속, #5201 S-B).
//
// 쓰기를 막을지는 연결 상태 모델의 게이트(`canSend`)가 답한다. 막았을 때 무슨 말을 하나는 자리마다의 사전 틀
// (`blocked.<틀>.offline` · `blocked.<틀>.serverUnreachable`)이 있고, 이 함수가 원인에 맞는 쪽을 고른다:
//
//   기기 오프라인        `blocked.<틀>.offline`            「오프라인이라 …」
//   서버에 닿지 못함     `blocked.<틀>.serverUnreachable`  「서버에 닿지 못해 …」 (오프라인이라고 말하지 않는다)
//   로그인 만료          `connection.session.expired`      앱이 곧 로그인 화면으로 돌아간다
//
// 실시간만 끊김·알 수 없음에는 말이 없다: 모델이 그 원인으로는 막지 않으므로(모르면 막지 않는다, #5201 결정 ③) 호출부가
// 이 문장을 그리는 일이 없다. 모델이 없는 자리(셸 밖·단위 시험)에서 막혔다고 한 호출은 브라우저 오프라인뿐이라
// (`view`가 없다) 기기 오프라인 문장이다.
//
// 완결된 문장 틀이 원인마다 따로 있다(ADR-0213: 조각을 이어 붙이지 않는다). 순수하고 사전을 읽지 않는다: 키만 고른다.
// =============================================================================

type OfflineFrame<K, V> = K extends `blocked.${infer F}.offline`
  ? K extends keyof MessageArgs ? (MessageArgs[K] extends V ? F : never) : never
  : never;
type ServerFrame<K, V> = K extends `blocked.${infer F}.serverUnreachable`
  ? K extends keyof MessageArgs ? (MessageArgs[K] extends V ? F : never) : never
  : never;

/** 두 원인의 문장이 모두 사전에 있고 값을 받지 않는 틀의 이름. 한쪽만 있는 틀은 타입에서 빠져 쓸 수 없다. */
export type BlockedFrame = Extract<OfflineFrame<MessageKey, Record<string, never>>, ServerFrame<MessageKey, Record<string, never>>>;

/** 마지막 동기화 시각(`relativeTime`)을 값으로 받는 틀(읽기가 막힌 목록의 띠). */
export type BlockedStaleFrame = Extract<
  OfflineFrame<MessageKey, { relativeTime: string }>,
  ServerFrame<MessageKey, { relativeTime: string }>
>;

export type BlockedKey =
  | `blocked.${BlockedFrame}.offline`
  | `blocked.${BlockedFrame}.serverUnreachable`
  | typeof CONNECTION_KEYS.sessionExpired;

export type BlockedStaleKey = `blocked.${BlockedStaleFrame}.offline` | `blocked.${BlockedStaleFrame}.serverUnreachable`;

/** 이 틀이 지금 연결 모습에서 읽어야 할 사전 키. `view`가 `null`이면 모델이 없는 자리다. */
export function blockedKey(frame: BlockedFrame, view: ConnectionView | null): BlockedKey {
  if (view?.phase === "expired") return CONNECTION_KEYS.sessionExpired;
  return view?.cause === "serverUnreachable" ? `blocked.${frame}.serverUnreachable` : `blocked.${frame}.offline`;
}

/**
 * 값을 받는 틀(`BlockedStaleFrame`)의 키. 로그인 만료에는 마지막 동기화를 말할 자리가 없어 `null`이다: 앱이 곧 로그인 화면으로
 * 돌아가는 그 순간이라 호출부가 만료 문장(`CONNECTION_KEYS.sessionExpired`)을 대신 읽는다.
 */
export function blockedStaleKey(frame: BlockedStaleFrame, view: ConnectionView | null): BlockedStaleKey | null {
  if (view?.phase === "expired") return null;
  return view?.cause === "serverUnreachable" ? `blocked.${frame}.serverUnreachable` : `blocked.${frame}.offline`;
}

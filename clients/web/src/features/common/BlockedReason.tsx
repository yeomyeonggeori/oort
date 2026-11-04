import { useContext } from "react";
import {
  blockedKey,
  blockedStaleKey,
  type BlockedFrame,
  type BlockedStaleFrame,
} from "@momo/core/features/connection/blockedReason";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import { ConnectionContext } from "@/features/common/connectionContext";
import { useFormatMessage } from "@/i18n/useFormatMessage";

export type { BlockedFrame, BlockedStaleFrame };

// =============================================================================
// 막힌 자리의 한 문장이 **막은 원인**을 말하게 하는 문 (#5260, #5239 후속, #5201 S-B).
//
// 쓰기를 막을지는 `useOffline()` 한 곳이 답하고(#5220), 막았을 때 무슨 말을 하나는 이 문이 답한다. 입력창·승인 줄
// (`blockedLines.ts`, #5239)이 연결 상태 모델의 `composerNote`·`approvalNote`를 읽었다면, 그 밖의 자리(허들 띠·결정 무대·
// 받은함 답장·설정류의 잠금 사유와 띠)는 자리마다 사전 틀(`blocked.<틀>.…`)을 갖고, 코어의 `blockedKey`가 원인에
// 맞는 쪽을 고른다(기기 오프라인 · 서버에 닿지 못함 · 로그인 만료. 규칙과 이유는 그 파일 머리).
//
// 이 문장을 그리는 것은 호출부가 막혔을 때(`offline`)뿐이다. 실시간만 끊김·알 수 없음은 모델이 막지 않으므로
// 문장도 서지 않는다.
// =============================================================================

/**
 * 막았을 때 이 자리가 말하는 문장. 속성(`title`·`aria-*`)이나 계산에 문자열이 필요할 때 쓴다. 화면에 글로 놓을 때는
 * `<BlockedReason frame="…" />`가 같은 길이다. 조기 `return` 뒤처럼 훅을 못 부르는 자리도 컴포넌트는 부를 수 있다.
 */
// eslint-disable-next-line react-refresh/only-export-components -- 같은 문장을 글(<BlockedReason>)과 문자열(속성·계산)로 읽는 한 쌍이라 한 파일에 둔다.
export function useBlockedReason(frame: BlockedFrame): string {
  const view = useContext(ConnectionContext)?.view ?? null;
  const formatMessage = useFormatMessage();
  return formatMessage(blockedKey(frame, view));
}

/** 막았을 때의 문장을 글로 놓는다. 자리의 마크업(`<p>`, `InlineBanner`의 `message` …)은 호출부가 갖는다. */
export function BlockedReason({ frame }: { frame: BlockedFrame }) {
  return <>{useBlockedReason(frame)}</>;
}

/**
 * 읽기가 막힌 목록의 띠 문장: 「오프라인이에요 / 서버에 닿지 못했어요. 마지막 동기화 …」. `relativeTime`은 로케일 서비스를
 * 거친 값이다(문장 조각을 이어 붙이지 않는다). 로그인 만료에는 만료 문장이다.
 */
// eslint-disable-next-line react-refresh/only-export-components -- `useBlockedReason`과 한 쌍이라 같은 파일에 둔다.
export function useBlockedStale(frame: BlockedStaleFrame, relativeTime: string): string {
  const view = useContext(ConnectionContext)?.view ?? null;
  const formatMessage = useFormatMessage();
  const key = blockedStaleKey(frame, view);
  return key === null ? formatMessage(CONNECTION_KEYS.sessionExpired) : formatMessage(key, { relativeTime });
}

/**
 * 읽기가 막힌 목록의 띠 문장. 받은 적이 있으면 마지막 동기화 시각을(`relativeTime`), 없으면(`null`) 「한 번도 받지 못했어요」를
 * 말한다. 시각 문구는 호출부가 로케일 서비스로 만들어 값으로 넘긴다.
 */
export function BlockedListLine({ relativeTime }: { relativeTime: string | null }) {
  const stale = useBlockedStale("lastSyncedList", relativeTime ?? "");
  const never = useBlockedReason("neverReceivedList");
  return <>{relativeTime === null ? never : stale}</>;
}

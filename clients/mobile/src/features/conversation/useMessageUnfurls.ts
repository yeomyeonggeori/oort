import {
  clearMessageUnfurls,
  emptyUnfurls,
  mergeColdMessageUnfurls,
  messageMayHaveUnfurls,
  replaceMessageUnfurls,
  unfurlsFor,
  type MessageUnfurl,
  type UnfurlMap,
} from '@momo/core/features/timeline/unfurl';
import {
  fetchMessageUnfurls,
  removeMessageUnfurls,
  type Message,
} from '@momo/core/lib/api';
import type {UnfurlEvent} from '@momo/core/lib/realtimeEvents';
import {useCallback, useRef, useState} from 'react';

// =============================================================================
// 한 방의 링크 카드 상태 (ADR-0170 D5, #4883).
//
// 웹 `clients/web/src/features/timeline/useTimeline.ts` 의 같은 이름 배선을 훅 하나로 떼어 낸 것이다 — 폰의
// `useTimeline` 은 이미 크고, 이 상태는 메시지 줄과 **같은 문(`applyBatch`)을 지나지 않는** 곁가지(가장자리 서버
// 투영)라서 따로 서도 잃는 것이 없다. 규칙은 전부 코어(`unfurl.ts`)의 것이고 여기에는 배선만 있다:
//
//   읽기      링크가 있을 수 있는 메시지마다 **한 번**, 답이 늦게 와도 방을 옮겼으면 버린다. 실패(서버 꺼짐·옛 서버·
//             연결 끊김)는 **조용한 부재**다 — 읽히는 메시지에 오류 상태를 얹지 않는다(D4/D5).
//   합치기    찬 읽기 답은 실시간 답(지우기 묘비 포함)이 먼저 와 있으면 덮지 않는다(`mergeColdMessageUnfurls`).
//   실시간    프레임은 그 메시지의 전체 투영이라 통째로 바꾼다. 빈 목록은 묘비다.
//   지우기    작성자만(서버가 403). 성공하면 이 화면도 곧바로 비우고, 다른 기기는 `message.unfurl.removed` 로 맞춘다.
// =============================================================================

/** 카드가 없는 모든 줄이 나눠 쓰는 빈 목록 — 줄의 `memo` 비교가 동일성으로 끝나게 한다. */
export const NO_UNFURLS: readonly MessageUnfurl[] = [];
export const NO_UNFURL_MAP: UnfurlMap = {};

/**
 * 한 메시지의 카드 행. 코어 `unfurlsFor` 는 없으면 **매번 새 `[]`** 를 돌려주므로 그대로 줄 prop 에 넣으면 링크 없는
 * 모든 줄의 `memo` 가 깨진다(`MessageRow` 의 `sameMessageRowProps` 는 이 prop 을 동일성으로 본다). 빈 것은 한 상수로 모은다.
 */
export function unfurlRowsFor(
  map: UnfurlMap,
  messageId: string,
): readonly MessageUnfurl[] {
  const rows = unfurlsFor(map, messageId);
  return rows.length === 0 ? NO_UNFURLS : rows;
}

export interface MessageUnfurlsApi {
  /** `message id(소문자) -> 카드 투영`. 빈 목록은 묘비. */
  unfurls: UnfurlMap;
  /** 링크가 있을 수 있는 메시지의 카드를 한 번씩 읽는다. 답이 오기 전 방이 바뀌었으면 버린다. */
  hydrate: (messages: readonly Message[], channel: string) => void;
  /** 방을 옮기거나 다시 읽을 때: 투영과 「읽었다」 기록을 모두 비운다. */
  reset: () => void;
  /** 실시간 프레임 하나(전체 투영 또는 지우기). 읽기 기록도 채워 늦은 찬 읽기가 덮지 못하게 한다. */
  applyFrame: (event: UnfurlEvent) => void;
  /** 메시지가 지워졌다: 카드도 함께 묘비로. */
  clear: (messageId: string) => void;
  /** 작성자가 이 메시지의 미리보기를 모두에게서 지운다. 실패하면 **던진다** — 문장은 부른 쪽이 고른다. */
  remove: (message: Message) => Promise<void>;
}

export function useMessageUnfurls(
  workspaceId: string,
  currentChannel: () => string | null,
): MessageUnfurlsApi {
  const [unfurls, setUnfurls] = useState<UnfurlMap>(emptyUnfurls);
  const mapRef = useRef<UnfurlMap>(unfurls);
  const readsRef = useRef<Set<string>>(new Set());

  const apply = useCallback((next: UnfurlMap) => {
    mapRef.current = next;
    setUnfurls(next);
  }, []);

  const hydrate = useCallback(
    (messages: readonly Message[], channel: string) => {
      const candidates = messages.filter(message => {
        const folded = message.id.toLowerCase();
        if (!messageMayHaveUnfurls(message.body)) return false;
        if (readsRef.current.has(folded)) return false;
        readsRef.current.add(folded);
        return true;
      });
      for (const message of candidates) {
        void (async () => {
          let rows: MessageUnfurl[] = [];
          try {
            rows = await fetchMessageUnfurls(workspaceId, message.id);
          } catch {
            // 서버가 꺼졌거나 옛 서버거나 닿지 않는다 — 부속물이 없을 뿐 읽히는 메시지의 오류가 아니다.
            // 뒤따르는 실시간 프레임이 이 조용한 부재를 덮을 수 있다.
          }
          if (currentChannel() !== channel) return;
          apply(mergeColdMessageUnfurls(mapRef.current, message.id, rows));
        })();
      }
    },
    [workspaceId, currentChannel, apply],
  );

  const reset = useCallback(() => {
    readsRef.current = new Set();
    apply(emptyUnfurls());
  }, [apply]);

  const applyFrame = useCallback(
    (event: UnfurlEvent) => {
      const messageId = event.payload.message_id;
      readsRef.current.add(messageId.toLowerCase());
      apply(
        event.type === 'message.unfurl'
          ? replaceMessageUnfurls(mapRef.current, messageId, event.payload.unfurls)
          : clearMessageUnfurls(mapRef.current, messageId),
      );
    },
    [apply],
  );

  const clear = useCallback(
    (messageId: string) => apply(clearMessageUnfurls(mapRef.current, messageId)),
    [apply],
  );

  const remove = useCallback(
    async (message: Message) => {
      await removeMessageUnfurls(workspaceId, message.id);
      apply(clearMessageUnfurls(mapRef.current, message.id));
    },
    [workspaceId, apply],
  );

  return {unfurls, hydrate, reset, applyFrame, clear, remove};
}

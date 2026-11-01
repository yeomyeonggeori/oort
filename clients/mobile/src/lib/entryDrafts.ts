import {useEffect, useState} from 'react';

import {useHoldOnEntry} from './useDismissOnEntry';

// =============================================================================
// 알림 입구가 닫아 버린 시트의 초안 (#4667).
//
// 알림은 열려 있던 임시 표면을 모두 걷는다(`lib/useDismissOnEntry.ts`). 그 가운데 글을 쓰던 시트 —
// 메시지 고치기·새 채널 이름 — 는 닫는 길이 곧 폐기다: X·스크림·끌어내리기는 쓴 것을 버린다. 사람이 닫은 것이
// 아니라 **알림이 걷은** 시트의 글까지 사라지면, 알림 한 번이 쓰던 문장을 지운다.
//
// 그래서 방송을 받는 순간 쓰던 글을 맡기고(`useHoldDraftOnEntry`), 같은 시트가 다시 서면 한 번 돌려준다
// (`useRestoredEntryDraft`). **방송이 올 때만** 맡는다 — 사람이 직접 X 로 닫는 평소의 폐기는 그대로다. 키스트로크마다
// 쓰는 길(`conversation/drafts.ts`, 컴포저)과 다른 점이 이것이다: 그쪽은 「보내기 전의 글은 사라지지 않는다」가
// 약속이고, 이쪽은 「알림이 대신 닫은 시트의 글만 돌려준다」는 약속이다.
//
// 이 앱 실행 안의 **메모리에만** 둔다. 디스크에 쓰지 않는다(`work/delegate/session.ts` 와 같은 이유 — 사람이 쓴 본문이고
// 보내기 전에는 서버도 본 적이 없다). 앱이 죽으면 사라지는 것이 약속이다. 돌려주면 지운다: 두 번째로 연 시트에 같은
// 글이 또 나타나지 않고, 그 시트를 사람이 닫으면 평소처럼 버려진다.
// =============================================================================

const held = new Map<string, unknown>();

/** 시트가 서는 첫 렌더가 이미 들고 있어야 하므로(한 프레임 뒤에 채우면 글이 깜빡인다) 읽기는 동기다. */
function peek<T>(key: string | undefined): T | undefined {
  return key === undefined ? undefined : (held.get(key) as T | undefined);
}

/**
 * 시트가 서는 순간 맡겨 둔 초안. 없으면 `undefined`. 읽은 뒤(마운트 뒤의 효과에서) 비운다 — 초기화 함수는 두 번 불릴
 * 수 있어 거기서 지우면 두 번째 부름이 빈손이 된다.
 */
export function useRestoredEntryDraft<T>(key: string | undefined): T | undefined {
  const [restored] = useState(() => peek<T>(key));
  useEffect(() => {
    if (key !== undefined) held.delete(key);
  }, [key]);
  return restored;
}

/**
 * 알림 입구가 이 시트를 닫을 때 쓰던 글을 맡긴다. `read` 가 `undefined` 를 주면 맡길 것이 없다(저장 중이거나 바뀐 것이
 * 없다). `key` 가 없으면 아무것도 하지 않는다 — 어느 글인지 모르는 시트가 남의 글 자리에 쓰지 않는다.
 */
export function useHoldDraftOnEntry<T>(
  key: string | undefined,
  read: () => T | undefined,
): void {
  useHoldOnEntry(() => {
    if (key === undefined) return;
    const draft = read();
    if (draft !== undefined) held.set(key, draft);
  });
}

/** 메시지 고치기 시트의 자리 — 같은 메시지의 고치기만 그 글을 돌려받는다(`MessageRow` 가 메시지 id 로 짓는다). */
export const messageEditDraftKey = (messageId: string): string => `message-edit:${messageId}`;

/** 시험 이음매: 맡겨 둔 것을 읽는다(지우지 않는다). */
export function __peekEntryDraft<T>(key: string): T | undefined {
  return peek<T>(key);
}

/** 시험 이음매. */
export function __resetEntryDrafts(): void {
  held.clear();
}

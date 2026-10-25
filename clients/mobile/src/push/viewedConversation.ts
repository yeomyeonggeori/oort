import {useEffect} from 'react';

import {appStateForeground} from '../features/readState/useViewingBeat';

// =============================================================================
// 지금 어느 대화가 앞에 있는가 (#4310).
//
// 알림 처리기(`foregroundPresentation.ts`)는 React 트리 밖에서, 알림 하나가 도착한 그
// 순간에 이 답을 **동기로** 읽어야 한다. 그런데 어느 방이 열려 있는지는 `AppShell` 의
// 리듀서에, 열린 스레드는 `ConversationScreen` 의 지역 상태에 있어서 처리기가 닿지
// 못한다. 그래서 대화 화면이 서 있는 동안 자기가 무엇을 가리키는지를 여기에 **올려
// 둔다.** 읽는 곳은 하나(`viewedConversation`), 쓰는 곳도 하나(`ConversationScreen`)다.
//
// ## 「앞」은 새로 정의하지 않는다
//
// 보고 있다 = 대화 화면이 서 있고 **앱이 `active` 인 것** 둘 다다. 두 번째 조건은
// 「보고 있음」 존재 신호(`useViewingBeat`, ADR-0204 증보 3)가 이미 내린 판정을 그대로
// 쓴다: `inactive`(알림 센터·전화·앱 전환기)도 앞이 아니다. 그 순간 사람은 이 방을 보고
// 있지 않고, 잘못 「안 본다」고 한 쪽의 대가는 배너가 한 번 뜨는 것이다 — 잘못
// 「본다」고 한 쪽의 대가는 사람이 못 본 알림이 목록에도 남지 않는 것이다. 앱이 배경으로
// 가면 `AppState` 가 곧바로 그 답을 바꾸므로 화면이 마운트된 채여도 「보는 대화 없음」이
// 된다(앱은 그 사이 어떤 cleanup 도 돌리지 않는다).
//
// 이 판정을 두 번 쓰는 대신 읽을 때마다 `appStateForeground` 에 묻는다. 구독도, 값을
// 들고 있는 변수도 없어서 둘이 어긋날 일이 없다.
// =============================================================================

export interface ViewedConversation {
  workspaceId: string;
  channelId: string;
  /** 스레드 판이 열려 있으면 그 루트. 채널 본류를 보고 있으면 null. */
  threadRootId: string | null;
}

/**
 * 올린 값을 상자에 담는다. 내리는 쪽이 「내가 올린 그것」인지를 **동일성**으로 가려야 해서다:
 * 이 화면은 방을 갈아 끼울 때 언마운트되지 않고(셸이 위치로 렌더한다) 전환 중에는 두 화면이
 * 잠깐 겹칠 수 있다. 나중 것이 올라간 뒤 앞 것의 cleanup 이 늦게 오면, 값이 같지 않은데도
 * 비워 버려 지금 보고 있는 방이 「없음」이 된다.
 */
let published: {view: ViewedConversation} | null = null;

/**
 * 이 화면이 지금 가리키는 대화를 올린다. 돌려주는 함수가 내리는 쪽이며, 아직 **자기 것이
 * 올라가 있을 때만** 비운다.
 */
export function publishViewedConversation(view: ViewedConversation): () => void {
  const entry = {view};
  published = entry;
  return () => {
    if (published === entry) published = null;
  };
}

/**
 * 지금 앞에 있는 대화, 없으면 null. 앱이 `active` 가 아니면 화면이 올려 둔 값이 있어도 null 이다.
 */
export function viewedConversation(): ViewedConversation | null {
  if (published === null) return null;
  return appStateForeground.isForeground() ? published.view : null;
}

/**
 * 대화 화면이 자기가 가리키는 방(과 열린 스레드)을 처리기가 읽을 자리에 올린다.
 *
 * 값이 바뀌면 cleanup 이 먼저 돌고 곧바로 새 값이 올라간다 — 같은 커밋 안이라 그 사이에
 * 도착한 알림이 빈 틈을 볼 수 없다. 둘 중 하나라도 비어 있으면 올리지 않는다(`useViewingBeat`
 * 와 같은 가드): 어느 방인지 모르는 화면이 「이 방을 본다」고 말하게 두지 않는다.
 */
export function useReportViewedConversation(
  workspaceId: string,
  channelId: string,
  threadRootId: string | null,
): void {
  useEffect(() => {
    if (workspaceId === '' || channelId === '') return undefined;
    return publishViewedConversation({workspaceId, channelId, threadRootId});
  }, [workspaceId, channelId, threadRootId]);
}

/** 시험 전용: 올라가 있던 값을 비운다. */
export function __resetViewedConversation(): void {
  published = null;
}

import type {
  StatusChangeEventPayload,
  VideoPlayer,
  VideoPlayerEvents,
} from 'expo-video';

// =============================================================================
// 플레이어의 사건을 구독하는 한 길 (#5208).
//
// 사건 이름은 호출하는 쪽의 **객체 키**다 — 이 함수는 이름을 적지 않는다. 그래서 `{ playingChange: …, timeUpdate: … }` 처럼 읽히고,
// 형은 `VideoPlayerEvents` 가 이름마다 핸들러 모양을 정한다. 구독은 한 번에 풀린다.
// =============================================================================

type Handlers = { [Name in keyof VideoPlayerEvents]?: VideoPlayerEvents[Name] };

export function listenToPlayer(player: VideoPlayer, handlers: Handlers): () => void {
  const subscriptions = (Object.keys(handlers) as Array<keyof VideoPlayerEvents>).map(name =>
    player.addListener(name, handlers[name] as never),
  );
  return () => {
    for (const subscription of subscriptions) {
      try {
        subscription.remove();
      } catch {
        // 이미 해제된 플레이어의 구독이다 — 화면이 내려가는 순서에서 플레이어가 먼저 풀릴 수 있고, 지울 것이 없다.
      }
    }
  };
}

/** 이 상태 알림이 재생 실패인가. 네이티브는 오류를 **먼저** 적고 상태를 바꾸지만, 오류 칸이 이전 알림에서 남을 수 있어 상태 이름으로 가른다. */
export function isPlayerFailure(payload: StatusChangeEventPayload): boolean {
  return payload.status === 'error';
}

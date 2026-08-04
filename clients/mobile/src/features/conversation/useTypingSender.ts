import {ApiError, publishTyping, requestTypingGrant} from '@momo/core/lib/api';
import {
  emptyTypingSendState,
  nextTypingAction,
  typingGrantFrom,
  withTypingGrant,
  withTypingPublished,
  withTypingRefusal,
  type TypingSendState,
} from '@momo/core/features/chat/typing';
import {useCallback, useEffect, useRef} from 'react';

// =============================================================================
// 「작성 중」 송신 — 키를 누를 때마다 한 번 묻고, 대개는 아무것도 안 한다.
//
// ## 타이머가 없다. 그것이 이 파일의 전부다
//
// 3초 인터벌을 돌리는 판이 먼저 떠오르고, 그 판은 폰에서 특히 나쁘다: 흐림·탭
// 전환·뒤로가기·앱 백그라운드·언마운트마다 그것을 끄는 코드가 필요하고, 그 중
// **하나만 잊어도 컴포저를 떠난 사람이 계속 작성 중으로 남는다.** 그리고 폰에서는
// 잊을 자리가 웹보다 많다 — iOS 는 앱을 재우면서 이 트리에 아무 커밋도 일으키지
// 않는다(이 레포가 읽음 커서에서 이미 겪은 결함, #1011).
//
// 코어의 `nextTypingAction` 은 순수 함수이고, 이 훅은 그것을 **키스트로크에**
// 매단다. 그래서 「입력이 멈추면 송신도 멈춘다」가 코드가 아니라 **구조**로
// 성립한다: 키를 안 누르면 이 훅은 불리지 않고, 불리지 않으면 아무것도 나가지
// 않으며, 나머지는 TTL 이 한다. 정리할 것이 하나도 없으므로 백그라운드 처리도
// 언마운트 처리도 **필요 없다** — 없는 타이머는 끌 수도 없다.
//
// ## 상태는 ref 다
//
// 이 상태는 화면에 하나도 그려지지 않는다(grant 토큰·마지막 발행 시각·백오프).
// `useState` 로 들면 키스트로크마다 렌더가 한 번씩 더 돌고, 그 렌더는 컴포저의
// 동기 쓰기 계약 바로 옆에서 일어난다 — 이 클라이언트가 한글 조합으로 가장 비싸게
// 산 자리다(spike #837).
//
// ## 실패는 코어가 해석한다
//
// 403/429/503/502 가 각각 다른 다음 행동을 뜻하고, 그 판정은 `withTypingRefusal`
// 하나에 있다. 여기서 status 를 꺼내 넘기는 것 말고 하는 일이 없다.
// =============================================================================

/**
 * HTTP status, 알 수 없으면 0.
 *
 * 0 은 「네트워크가 답을 안 줬다」이고, 코어의 `withTypingRefusal` 은 그것을 5xx
 * 와 같이 다룬다 — 상태를 바꾸지 않고 다음 키가 재시도가 된다. 그것이 맞다:
 * 지하철에서 한 번 끊긴 것과 서버가 「하지 마라」라고 답한 것은 다른 사건이고,
 * 앞엣것 때문에 자격을 버리면 신호가 돌아오자마자 grant 를 다시 받아야 한다.
 */
function statusOf(error: unknown): number {
  return error instanceof ApiError ? error.status : 0;
}

/**
 * 이 채널에 대한 「작성 중」 송신기.
 *
 * 돌려주는 함수를 컴포저의 `onTyping` 에 그대로 물린다. 동일성이 고정이므로
 * (`channelId`·`workspaceId` 가 바뀔 때만 새로 만들어진다) 컴포저의 `onChangeText`
 * 가 키스트로크마다 다시 만들어지지 않는다.
 */
export function useTypingSender(
  workspaceId: string,
  channelId: string,
  /** 레일이 죽어 있으면 발행하지 않는다 — 아무도 못 받을 신호다. */
  enabled: boolean,
): () => void {
  const stateRef = useRef<TypingSendState>(emptyTypingSendState());
  // 한 번에 한 요청. 3초 간격이라 겹칠 일은 드물지만, 겹치면 grant 를 두 번 받고
  // 늦게 온 쪽이 먼저 온 쪽을 덮어 `lastPublishAtMs` 가 뒤로 간다.
  const inFlightRef = useRef(false);

  // 채널이 바뀌면 자격도 버린다. grant 는 (사람, 워크스페이스, 채널)에 묶여 있어
  // 다른 방에서는 403 이고, 그 403 은 새 방의 첫 타를 한 번 삼킨다.
  useEffect(() => {
    stateRef.current = emptyTypingSendState();
    inFlightRef.current = false;
  }, [workspaceId, channelId]);

  return useCallback(() => {
    if (!enabled) return;
    if (inFlightRef.current) return;
    const nowMs = Date.now();
    const action = nextTypingAction(stateRef.current, nowMs);
    if (action.kind === 'wait') return;

    inFlightRef.current = true;
    const settle = () => {
      inFlightRef.current = false;
    };

    if (action.kind === 'grant') {
      void requestTypingGrant(workspaceId, channelId)
        .then(wire => {
          stateRef.current = withTypingGrant(
            stateRef.current,
            typingGrantFrom(wire),
            Date.now(),
          );
          // 자격을 막 받았으면 그것으로 **바로 한 번 보낸다.** 안 그러면 첫 글자가
          // grant 만 받고 끝나고, 보는 쪽에는 다음 키까지 아무 표시도 안 뜬다.
          const publish = nextTypingAction(stateRef.current, Date.now());
          if (publish.kind !== 'publish') return undefined;
          return publishTyping(workspaceId, channelId, publish.grant).then(
            () => {
              stateRef.current = withTypingPublished(
                stateRef.current,
                Date.now(),
              );
            },
          );
        })
        .catch((error: unknown) => {
          stateRef.current = withTypingRefusal(
            stateRef.current,
            statusOf(error),
            {nowMs: Date.now()},
          );
        })
        .finally(settle);
      return;
    }

    void publishTyping(workspaceId, channelId, action.grant)
      .then(() => {
        stateRef.current = withTypingPublished(stateRef.current, Date.now());
      })
      .catch((error: unknown) => {
        stateRef.current = withTypingRefusal(
          stateRef.current,
          statusOf(error),
          {nowMs: Date.now()},
        );
      })
      .finally(settle);
  }, [workspaceId, channelId, enabled]);
}

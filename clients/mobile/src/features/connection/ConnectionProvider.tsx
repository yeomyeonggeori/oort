import NetInfo from '@react-native-community/netinfo';
import type {ConnectionView} from '@momo/core/features/connection/model';
import {
  deviceEvent,
  isRecovered,
  restEvent,
} from '@momo/core/features/connection/screenState';
import {subscribeRestOutcome} from '@momo/core/lib/http';
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {isOnlineFromNetInfo} from '../../query/queryClient';
import {appStateForeground} from '../readState/useViewingBeat';
import type {DisplayEvent} from '../../realtime/connectionDisplay';
import {createConnectionStore} from './connectionStore';
import {onAppBackground} from './appBackground';
import {connectionEventOf} from './connectionEvents';
import {recordDeviceOnline} from './deviceOnline';

// =============================================================================
// 연결 상태 모델을 돌리는 폰 공급자 (#5222, #5201 S-D). 웹 `ConnectionProvider`(#5220)의 짝이다.
//
// 코어 모델(#5219)의 입력 넷을 여기서 모은다.
//   · 기기 온라인 — NetInfo. 첫 보고가 오기 전은 모른다(`null`): 모르면 막지 않는다. 시작할 때 `false` 로 두면 온라인인
//     사람이 화면을 열 때마다 한 순간 「오프라인이에요」가 뜬다(`useOnline` 과 같은 이유).
//   · 소켓 — 전송이 밖에서 받은 사건(`onSocketEvent`: 날것의 상태·다시 열기·끝남). `RealtimeProvider` 가 이 공급자 안에서
//     전송을 만들고 사건을 `feed` 로 넘긴다. 앱 복귀·망 복귀·손으로 누른 「지금 다시 연결」이 모두 같은 `resume` 길이라
//     여기서 따로 듣지 않는다.
//   · REST 결과 — `subscribeRestOutcome` 한 번. 폰의 푸시 API 호출도 같은 `fetchWithDeadline` 이라 함께 들어온다.
//   · 만료 — 폰은 만료가 서면 앱이 곧바로 로그인 화면으로 돌아가 이 트리가 사라진다. 사건을 받지 않는다.
//   · 앱이 뒤로 갔다/돌아왔다(AppState) — 뒤에 가 있던 시간은 화면을 보는 사람이 없던 시간이다(#5403). 그 사이 쌓인 「끊김이 보였다」
//     기억·복구 표시는 남기지 않고, 돌아온 순간 소켓이 붙어 있지 않으면 틈을 새 침묵으로 다시 시작한다(코어 `visibility`). 전송의 다시 열기
//     (`resume`)가 이 알림보다 먼저 와도 결과가 같다. `inactive`(알림 센터를 당긴 정도)는 뒤로 간 것이 아니다.
//
// 사건에는 일어난 순간의 시각(`at`)을 한 번 찍어 저장소(`connectionStore.ts`)에 넣는다(리듀서는 시계를 읽지 않는다). 시간만으로 바뀌는
// 판정(침묵 → 「연결 중」 → 「끊김」, 복구 표시 끝)은 저장소가 `nextWakeAt` 에 타이머 하나로 깨운다. 이 공급자가 하는 일은 사건을 모아
// 먹이는 것과 상태를 React 에 읽히는 것뿐이다: 말하는 규칙은 코어에 있다.
// =============================================================================

export interface ConnectionContextValue {
  /** 지금 화면이 어떤 모습이어야 하나(코어 모델의 출력). */
  view: ConnectionView;
  /** 「다시 연결됐어요」를 지금 그리나(「끊김」이 보였다 정상으로 돌아온 뒤 2초). */
  recovered: boolean;
  /**
   * 복구 표시가 끝나는 시각(epoch ms), 서 있지 않으면 null. 깨움 시계가 늦거나 사라져도 읽는 쪽이 자기 렌더 시각과 견주어 거둘 수 있게
   * 건넨다(#5403) - 상태는 깨움이 와야 바뀌므로 시각 없이 읽으면 낡은 표시가 보내기 같은 다음 사건까지 남는다.
   */
  recoveredUntil: number | null;
}

/**
 * 공급자 밖(격리 하네스·시험)에서는 null 이다. 그때 화면은 연결에 대해 아무 말도 하지 않고, 게이트는 NetInfo 만으로
 * 같은 질문에 답한다(`useConnectionGates`).
 */
const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function useConnection(): ConnectionContextValue | null {
  return useContext(ConnectionContext);
}

/** 전송이 밖에서 받은 소켓 사건을 모델에 먹이는 함수. */
export type SocketFeed = (event: DisplayEvent) => void;

/** 공급자가 없거나 사라진 동안 전송이 부르는 자리. 아무것도 하지 않는다. */
export const NO_FEED: SocketFeed = () => undefined;

export function ConnectionProvider({
  feedRef,
  children,
}: {
  /**
   * 이 공급자가 `current` 를 채운다. `RealtimeProvider` 가 만드는 전송이 `onSocketEvent` 로 부른다. 컨텍스트 대신 ref 인
   * 까닭: 전송은 effect 안에서 만들어지고 사건이 오는 시점은 렌더 밖이며, 공급자가 둘이 서로를 감쌀 필요가 없다.
   */
  feedRef: React.MutableRefObject<SocketFeed>;
  children: React.ReactNode;
}): React.JSX.Element {
  // 첫 보고가 오기 전의 기기 온라인은 모른다(`null`): 모르면 막지 않는다.
  const [store] = useState(() => createConnectionStore(null));
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  // 깨움 시계: 마운트에서 켜고 언마운트에서 거둔다(아래 구독보다 먼저 선언해 먼저 돈다).
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  // 소켓: 전송이 부른다. 공급자가 사라지면 아무것도 먹이지 않는 함수로 되돌린다.
  useEffect(() => {
    const feed: SocketFeed = event =>
      store.emit(at => connectionEventOf(event, at));
    feedRef.current = feed;
    return () => {
      if (feedRef.current === feed) feedRef.current = NO_FEED;
    };
  }, [store, feedRef]);

  // 앱: 뒤로 가면 아무도 보지 않는다. 돌아오면 새로 시작하고, `inactive` → `active` 는 시각만 따라간다(스토어 `setVisible`). 뒤로 가는 것은
  // `onAppBackground`(앞에 있는 동안의 `inactive` 는 뒤로 간 것이 아니다), 앞으로 돌아오는 것은 「보고 있음」 신호와 같은 어댑터(`appStateForeground`)가
  // 알린다. 마운트 시점에 앞이 아니면(푸시로 깨어난 앱) 뒤에 있는 것으로 시작한다.
  useEffect(() => {
    if (!appStateForeground.isForeground()) store.setVisible(false);
    const stopBackground = onAppBackground(() => store.setVisible(false));
    const stopForeground = appStateForeground.subscribe(active => {
      if (active) store.setVisible(true);
    });
    return () => {
      stopBackground();
      stopForeground();
    };
  }, [store]);

  // 기기: NetInfo 는 구독 즉시 현재 상태를 한 번 보고한다. 모름(`null`)은 막지 않는 쪽이라 첫 보고 전의 기본이다.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(netState => {
      const online = isOnlineFromNetInfo(netState);
      // 화면 밖 코드(올리기 저장소 · 보내기 실패의 원인 판정)가 한 번 읽는 값도 여기서 옮겨 적는다.
      recordDeviceOnline(online);
      store.emit(at => deviceEvent(at, online));
    });
    return () => {
      unsubscribe();
      recordDeviceOnline(null);
    };
  }, [store]);

  // REST 결과 전부(서버에 닿았나). 요청이 어떻게 끝나든 요청 쪽은 이 구독을 모른다.
  useEffect(
    () => subscribeRestOutcome(outcome => store.emit(() => restEvent(outcome))),
    [store],
  );

  const value = useMemo<ConnectionContextValue>(
    () => ({
      view: state.view,
      recovered: isRecovered(state),
      recoveredUntil: state.recoveredUntil,
    }),
    [state],
  );
  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

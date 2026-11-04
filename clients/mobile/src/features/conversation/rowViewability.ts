import {createContext, useContext, useSyncExternalStore} from 'react';

// =============================================================================
// 「이 줄이 한 번이라도 화면에 보였는가」 (#4883, ADR-0170 증보 D9).
//
// 웹은 카드의 사이트 아이콘을 `IntersectionObserver` 로 **보일 때 처음** 부른다 — 프록시가 그때 사이트로 나가기
// 때문이다. React Native 에는 그 도구가 없고, 대화 목록은 가상화(`FlatList`, 기본 창 21 화면)라서 **마운트됨은 보임이
// 아니다**: 열 화면 위의 줄도 마운트돼 있다. 마운트 시점에 아이콘을 부르면 방을 열 때 멀리 있는 기록의 사이트들을
// 서버가 한꺼번에 찾아 나선다.
//
// 그래서 목록 자신이 아는 사실 하나를 쓴다: `FlatList` 의 `onViewableItemsChanged`(`Timeline`)가 알려 주는 **보이는
// 줄의 키**. 이 저장소는 그 키를 받아 「한 번 보인 줄」을 단조롭게 쌓고(웹의 「한 번 보이면 계속 보인 것으로 쳐요」와
// 같다), 보인 줄이 **새로 생길 때만** 구독자를 깨운다 — 줄이 화면을 떠나도 아무도 다시 그려지지 않는다.
//
// 목록이 없는 곳(측정 하네스·시험·검색 미리보기)에서는 제공자가 없고, 그때는 「보였다」로 친다(웹의
// `IntersectionObserver` 가 없는 엔진과 같다) — 아이콘이 영영 막히는 일이 없다.
//
// 이것이 웹과 **같은 보장은 아니다**: `FlatList` 의 「보임」은 한 조각이라도 화면에 걸친 줄이고(`itemVisiblePercentThreshold: 0`),
// 줄 안의 카드 위치까지 재지 않는다. 한 줄 안에 카드가 셋이어도 같은 줄이라 함께 켜진다.
// =============================================================================

export interface RowViewability {
  /** 이 줄이 한 번이라도 화면에 보였는가. 단조롭다. */
  seen: (rowKey: string) => boolean;
  subscribe: (listener: () => void) => () => void;
  /** `FlatList` 가 알려 준 지금 보이는 줄들의 키. 새로 보인 줄이 있을 때만 구독자를 깨운다. */
  update: (viewableKeys: readonly string[]) => void;
}

export function createRowViewability(): RowViewability {
  const everSeen = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    seen: rowKey => everSeen.has(rowKey),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(viewableKeys) {
      let added = false;
      for (const key of viewableKeys) {
        if (!everSeen.has(key)) {
          everSeen.add(key);
          added = true;
        }
      }
      if (added) listeners.forEach(listener => listener());
    },
  };
}

export const RowViewabilityContext = createContext<RowViewability | null>(null);

/**
 * 목록 항목의 키. 메시지 줄은 코어 `buildTimelineItems` 가 `m-<seq>` 로 키를 짓는다 — 같은 모양을 한 곳에 적고,
 * `__tests__/rowViewability.test.tsx` 가 코어가 실제로 만든 키와 맞대어 본다(어긋나면 아이콘이 영영 안 켜진다).
 */
export function messageRowKey(seq: number): string {
  return `m-${seq}`;
}

function neverSeen(): boolean {
  return false;
}

const noSubscribe = (): (() => void) => () => {};

/** 이 줄이 한 번이라도 보였는가. 목록(제공자)이 없으면 `true`. */
export function useRowSeen(rowKey: string): boolean {
  const store = useContext(RowViewabilityContext);
  return useSyncExternalStore(
    store === null ? noSubscribe : store.subscribe,
    store === null ? () => true : () => store.seen(rowKey),
    neverSeen,
  );
}

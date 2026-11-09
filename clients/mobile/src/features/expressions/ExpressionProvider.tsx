import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {Directory, File, Paths} from 'expo-file-system';
import {focusManager} from '@tanstack/react-query';
import {useSession} from '../../session/useSession';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useConnectionGates} from '../connection/useConnectionGates';
import {
  createPhoneExpressionStore,
  type ExpressionSnapshot,
  type PhoneExpressionStore,
} from './store';
import {expressionTransport} from './transport';
import {openPhoneExpressionDisk} from './disk/open';
import {
  forgetExpressionShelf,
  NON_SECRET_KEYS,
  nonSecretStore,
} from '../../storage/kv';
import {warmEmojiCatalog} from '../emoji/catalogMemory';

export const PhoneExpressions = createContext<PhoneExpressionStore | null>(
  null,
);
const EMPTY: ExpressionSnapshot = {
  items: [],
  shelf: [],
  state: 'ready',
  revision: 0,
};
const subscribeEmpty = () => () => {};
const emptySnapshot = () => EMPTY;
export function useExpressionStore() {
  return useContext(PhoneExpressions);
}
/** 대화 줄이 그릴 표현 목록(`ExpressionSnapshot.shelf`) — 처음 읽는 동안에도 마지막으로 읽은 목록이 있다(#5451). */
export function useExpressionItems() {
  const store = useExpressionStore();
  return useSyncExternalStore(
    store?.subscribe ?? subscribeEmpty,
    () => store?.snapshot().shelf ?? EMPTY.shelf,
  );
}
export function useExpressions() {
  const store = useContext(PhoneExpressions);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? subscribeEmpty,
    store?.snapshot ?? emptySnapshot,
  );
  return {store, ...snapshot};
}

export function ExpressionProvider({children}: {children: React.ReactNode}) {
  const {workspaceId, member} = useSession();
  const {rail, status} = useRealtime();
  const store = useMemo(() => {
    // 세션 폴더: 이 provider 가 사는 동안만 쓰는 임시 파일(초안 미리보기·반응 칩의 무한 반복 GIF·보관 칸에 못 쓴 그림)이다. 이모티콘 그림의 기기 캐시는 이것이 아니라 아래 `disk`
    // (`Paths.cache/<칸 이름>`, ADR-0218 §14)다. 앱이 죽어 남은 옛 폴더는 다음 시작 청소가 지운다(`disk/boot.ts`).
    const directory = new Directory(
      Paths.cache,
      `oort-expressions-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    return createPhoneExpressionStore(
      workspaceId,
      member.id,
      expressionTransport,
      {
        write(key, bytes) {
          if (!directory.exists)
            directory.create({intermediates: true, idempotent: true});
          const file = new File(directory, key);
          file.write(bytes);
          return file.uri;
        },
        remove(uri) {
          try {
            const file = new File(uri);
            if (file.exists) file.delete();
          } catch {
            /* already reclaimed */
          }
        },
      },
      {
        read() {
          try {
            return JSON.parse(
              nonSecretStore().getString(NON_SECRET_KEYS.expressionUsage) ??
                'null',
            );
          } catch {
            return null;
          }
        },
        write(value) {
          nonSecretStore().set(
            NON_SECRET_KEYS.expressionUsage,
            JSON.stringify(value),
          );
        },
      },
      {
        read() {
          try {
            const raw = nonSecretStore().getString(
              NON_SECRET_KEYS.expressionShelf,
            );
            return raw === undefined ? null : JSON.parse(raw);
          } catch {
            return null;
          }
        },
        write(value) {
          nonSecretStore().set(
            NON_SECRET_KEYS.expressionShelf,
            JSON.stringify(value),
          );
        },
        clear() {
          forgetExpressionShelf();
        },
      },
      // 칸을 못 열면(`null`: id 가 uuid 모양이 아니다) 예전처럼 세션 폴더만 쓴다(닫힌 쪽).
      openPhoneExpressionDisk(workspaceId, member.id),
    );
  }, [workspaceId, member.id]);
  // 표준 목록(「기본」 탭)을 시트가 열리기 전에 한 번 풀어 둔다 — 처음 열 때도 격자가 바로 선다(#5330).
  useEffect(() => {
    void warmEmojiCatalog();
  }, []);
  // 오프라인 판정은 웹과 같은 「보내기 가능 여부」다(#5585, 웹 `useOffline` = `!canSend`): 기기 오프라인이거나 서버에 닿지 못함이 확정일 때만
  // 오프라인이다. 소켓은 수신용이라 소켓만 끊긴 것으로는 오프라인이 아니다 — 앞 판은 `status !== 'disconnected'` 를 함께 보아 소켓만 끊겨도
  // 저장소가 그림을 모두 걷었고, 보관함이 비어 모든 이모티콘이 `:이름:` 글자가 됐다(대화 높이가 바뀌었다).
  const {canSend} = useConnectionGates();
  // 첫 읽기보다 먼저 선다: 처음부터 보낼 수 없으면 읽기를 내지 않는다(앞 판의 `setOnline` → `refresh` 순서와 같다).
  useEffect(() => {
    store.setOnline(canSend);
  }, [canSend, store]);
  useEffect(() => {
    store.start();
    void store.refresh(true);
    const stopFocus = focusManager.subscribe(focused => {
      if (focused) void store.refresh(true);
    });
    return () => {
      stopFocus();
      store.dispose();
    };
  }, [store]);
  useEffect(() => {
    if (status === 'connected') {
      // 실시간이 다시 이어졌다: 끊긴 동안의 알림은 오지 않았으니 전체 목록이 적용될 때까지 디스크 읽기 문을 닫는다. 저장소의 첫 연결은 재연결이 아니라 문을 올리지 않는다(ADR §14 M2.4-1).
      store.reconnected();
      void store.refresh(true);
    } else if (status === 'disconnected' && canSend) {
      // 소켓만 끊겼다(표시 유예 10초가 지났다, 보낼 수는 있다): 그린 그림은 그대로 두고, 알림을 못 받는 동안 새로 서는 칸이 디스크에서 읽지 않게
      // 문만 올린다(ADR §14 B-2 보충의 「끊김 한 번에 10초 이하」를 지킨다). 여기서 목록을 읽지 않는다 — 그 전체 읽기가 문을 도로 내리면 끊긴 동안 내내
      // 디스크 읽기가 열린다. 문은 다시 이어진 뒤(`connected`)나 앱이 앞으로 올 때의 전체 읽기가 내린다.
      store.socketLost();
    }
  }, [status, canSend, store]);
  useEffect(
    () =>
      rail?.subscribeExpressions?.(workspaceId, {
        onChanged: version => store.changed(version ?? null),
        onDetail: detail => store.detailed(detail),
        onResync: () => {
          store.resetNotices();
          void store.refresh(true);
        },
      }),
    [rail, workspaceId, store],
  );
  return (
    <PhoneExpressions.Provider value={store}>
      {children}
    </PhoneExpressions.Provider>
  );
}

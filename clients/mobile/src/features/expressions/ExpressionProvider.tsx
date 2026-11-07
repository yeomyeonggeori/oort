import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {Directory, File, Paths} from 'expo-file-system';
import {onlineManager, focusManager} from '@tanstack/react-query';
import {useSession} from '../../session/useSession';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {
  createPhoneExpressionStore,
  type ExpressionSnapshot,
  type PhoneExpressionStore,
} from './store';
import {expressionTransport} from './transport';
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
    // No adoption across sessions: files live only as long as this provider.
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
    );
  }, [workspaceId, member.id]);
  // 표준 목록(「기본」 탭)을 시트가 열리기 전에 한 번 풀어 둔다 — 처음 열 때도 격자가 바로 선다(#5330).
  useEffect(() => {
    void warmEmojiCatalog();
  }, []);
  useEffect(() => {
    store.start();
    store.setOnline(onlineManager.isOnline());
    void store.refresh(true);
    const stopOnline = onlineManager.subscribe(value => store.setOnline(value));
    const stopFocus = focusManager.subscribe(focused => {
      if (focused) void store.refresh(true);
    });
    return () => {
      stopOnline();
      stopFocus();
      store.dispose();
    };
  }, [store]);
  useEffect(() => {
    if (status === 'connected') {
      store.setOnline(onlineManager.isOnline());
      void store.refresh(true);
    } else
      store.setOnline(onlineManager.isOnline() && status !== 'disconnected');
  }, [status, store]);
  useEffect(
    () =>
      rail?.subscribeExpressions?.(workspaceId, {
        onChanged: () => store.changed(),
        onResync: () => {
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

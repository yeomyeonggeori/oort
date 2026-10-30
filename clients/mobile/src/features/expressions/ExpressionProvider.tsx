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
import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';

export const PhoneExpressions = createContext<PhoneExpressionStore | null>(
  null,
);
const EMPTY: ExpressionSnapshot = {items: [], state: 'ready', revision: 0};
const subscribeEmpty = () => () => {};
const emptySnapshot = () => EMPTY;
export function useExpressionStore() {
  return useContext(PhoneExpressions);
}
export function useExpressionItems() {
  const store = useExpressionStore();
  return useSyncExternalStore(
    store?.subscribe ?? subscribeEmpty,
    () => store?.snapshot().items ?? EMPTY.items,
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
    );
  }, [workspaceId, member.id]);
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

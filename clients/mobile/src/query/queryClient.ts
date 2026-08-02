import NetInfo from '@react-native-community/netinfo';
import {QueryClient, focusManager, onlineManager} from '@tanstack/react-query';
import {AppState, type AppStateStatus} from 'react-native';

// =============================================================================
// react-query on React Native (ADR-0137 D3 C군).
//
// The ADR is specific about scope: **the standard two bridges and nothing
// more.** react-query's defaults are written for a browser, where it can read
// `window.addEventListener('focus')` and `navigator.onLine` itself. Neither
// exists here, so without these two the library silently behaves as if the app
// were always focused and always online — refetching nothing on resume and
// retrying into a dead radio.
//
//   focusManager  <- AppState   "is the person looking at this?"
//   onlineManager <- NetInfo    "is there a network?"
//
// That is the whole list. The hooks themselves (`useTimeline`, `useInbox`, …)
// are host wiring by the same ADR and are NOT in the core; they arrive with the
// v0 UI batch (이행 순서 4) and bind to the same queries this client already has.
// =============================================================================

/**
 * Reachability, not just connectivity. `isInternetReachable` is null while
 * NetInfo is still probing, and treating "unknown" as offline would pause every
 * query during the first moments after launch — the exact moment the person is
 * waiting on content. Unknown therefore reads as online: the request either
 * works or fails on its own deadline (`@momo/core/lib/http.ts`), which is a
 * bounded and honest failure rather than a silent stall.
 */
export function isOnlineFromNetInfo(state: {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}): boolean {
  if (state.isConnected === false) {
    return false;
  }
  return state.isInternetReachable !== false;
}

/**
 * Install both bridges. Returns a teardown so a test can install and remove them
 * without leaking listeners into the next test.
 */
export function installReactQueryBridges(): () => void {
  const onAppStateChange = (status: AppStateStatus) => {
    focusManager.setFocused(status === 'active');
  };
  const appStateSub = AppState.addEventListener('change', onAppStateChange);
  // Seed from the current value rather than waiting for the first transition:
  // the app is already active when this runs, and react-query would otherwise
  // hold its browser default until the person backgrounded the app once.
  focusManager.setFocused(AppState.currentState === 'active');

  // `onlineManager.setEventListener` returns void — it keeps the cleanup its
  // setup function returns for its OWN use and hands nothing back. Capturing the
  // NetInfo unsubscribe here is therefore the only way to release it; relying on
  // a return value leaks a listener on every remount, which a fast-refreshing
  // dev session stacks up quickly.
  let unsubscribeNetInfo: (() => void) | undefined;
  onlineManager.setEventListener(setOnline => {
    unsubscribeNetInfo = NetInfo.addEventListener(state => {
      setOnline(isOnlineFromNetInfo(state));
    });
    return unsubscribeNetInfo;
  });

  return () => {
    appStateSub.remove();
    unsubscribeNetInfo?.();
  };
}

/**
 * The client. `retry: 1` because `@momo/core/lib/http.ts` already bounds every
 * request with a 15s deadline and surfaces a `NetworkError` rather than hanging:
 * react-query's default of three retries would stack that deadline up to 45
 * seconds of a spinner before the person is told anything.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        // A phone leaves and re-enters the network constantly. Refetching on
        // every reconnect is right; refetching on every focus is not, because on
        // iOS a notification banner alone can cycle focus.
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
    },
  });
}

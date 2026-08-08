import NetInfo from '@react-native-community/netinfo';
import {focusManager, onlineManager} from '@tanstack/react-query';
import {AppState} from 'react-native';
import {
  createQueryClient,
  installReactQueryBridges,
  isOnlineFromNetInfo,
} from '../src/query/queryClient';

// =============================================================================
// ADR-0137 D3 C군: the two standard bridges, and the assertion that there are
// only two. react-query reads `window` and `navigator` for these on the web;
// neither exists here, so without them the library believes the app is always
// focused and always online — refetching nothing on resume and retrying into a
// dead radio, both silently.
// =============================================================================

type NetInfoMock = typeof NetInfo & {
  __emit: (state: {isConnected: boolean | null; isInternetReachable: boolean | null}) => void;
  __listeners: Set<unknown>;
};

const netInfo = NetInfo as NetInfoMock;

describe('onlineManager <- NetInfo', () => {
  it('treats a probe still in flight as online, not offline', () => {
    // `isInternetReachable` is null while NetInfo probes. Reading that as
    // offline would pause every query in the first moments after launch — the
    // exact moment someone is waiting for content. A request that is wrong about
    // this fails on the core's own 15s deadline, which is bounded and honest.
    expect(
      isOnlineFromNetInfo({isConnected: true, isInternetReachable: null}),
    ).toBe(true);
  });

  it('is offline only when the platform actually says so', () => {
    expect(
      isOnlineFromNetInfo({isConnected: false, isInternetReachable: null}),
    ).toBe(false);
    expect(
      isOnlineFromNetInfo({isConnected: true, isInternetReachable: false}),
    ).toBe(false);
    expect(
      isOnlineFromNetInfo({isConnected: true, isInternetReachable: true}),
    ).toBe(true);
  });

  it('drives onlineManager from NetInfo events', () => {
    const teardown = installReactQueryBridges();
    try {
      netInfo.__emit({isConnected: false, isInternetReachable: false});
      expect(onlineManager.isOnline()).toBe(false);

      netInfo.__emit({isConnected: true, isInternetReachable: true});
      expect(onlineManager.isOnline()).toBe(true);
    } finally {
      teardown();
    }
  });
});

describe('focusManager <- AppState', () => {
  it('seeds from the current state instead of waiting for a transition', () => {
    const teardown = installReactQueryBridges();
    try {
      // The app is already active when the bridge is installed. Without the
      // seed, react-query would hold its browser default until the person
      // backgrounded the app once.
      expect(focusManager.isFocused()).toBe(AppState.currentState === 'active');
    } finally {
      teardown();
    }
  });

  it('follows AppState changes', () => {
    // `emit` is on the RN jest mock, not in AppState's public types. When it is
    // absent the assertion is skipped rather than asserted falsely — a test that
    // silently checks nothing is worse than one that admits it.
    const emitter = AppState as unknown as {
      emit?: (event: string, value: string) => void;
    };
    if (typeof emitter.emit !== 'function') {
      return;
    }
    const teardown = installReactQueryBridges();
    try {
      emitter.emit('change', 'background');
      expect(focusManager.isFocused()).toBe(false);
      emitter.emit('change', 'active');
      expect(focusManager.isFocused()).toBe(true);
    } finally {
      teardown();
    }
  });
});

describe('teardown', () => {
  it('removes both listeners so a remount does not stack them', () => {
    const before = netInfo.__listeners.size;
    const teardown = installReactQueryBridges();
    expect(netInfo.__listeners.size).toBe(before + 1);
    teardown();
    expect(netInfo.__listeners.size).toBe(before);
  });
});

describe('the query client', () => {
  it('does not stack retries on top of the core’s deadline', () => {
    // `@momo/core/lib/http.ts` already bounds every request at 15s. Three
    // retries — react-query's default — would mean 45 seconds of spinner before
    // the person is told anything at all.
    const defaults = createQueryClient().getDefaultOptions().queries;
    expect(defaults?.retry).toBe(1);
    expect(defaults?.refetchOnReconnect).toBe(true);
    // On iOS a notification banner alone cycles focus; refetching on that is
    // noise, and reconnect already covers the case that matters.
    expect(defaults?.refetchOnWindowFocus).toBe(false);
  });
});

/**
 * Test doubles for the three native modules this client depends on.
 *
 * They are in-memory implementations rather than `jest.fn()` stubs on purpose:
 * the things worth asserting are about WHERE a value went — the refresh token
 * into the keychain and never into MMKV — and a stub that records calls without
 * storing anything cannot answer that question.
 */

// ---- react-native-mmkv -------------------------------------------------------
// The non-secret store. `__store` is exposed so a test can look inside and prove
// what is (and is not) in there.
jest.mock('react-native-mmkv', () => {
  const store = new Map();
  // v4 exports a FACTORY (`createMMKV`); `MMKV` is a type only. Mirroring that
  // here means a file written against the v3 constructor fails in tests too,
  // rather than passing against a mock that is kinder than the real module.
  return {
    __store: store,
    createMMKV: () => ({
      getString: key => (store.has(key) ? store.get(key) : undefined),
      set: (key, value) => store.set(key, String(value)),
      remove: key => store.delete(key),
      clearAll: () => store.clear(),
    }),
  };
});

// Node already provides `crypto.getRandomValues`, so the shim has nothing to do
// here. On a device it is the only source of secure randomness there is.
jest.mock('react-native-get-random-values', () => ({}));

// ---- react-native-keychain ---------------------------------------------------
// Keyed by service, matching the real API's shape closely enough that a wrong
// service name in the app fails here too.
jest.mock('react-native-keychain', () => {
  const items = new Map();
  return {
    __items: items,
    ACCESSIBLE: {
      WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
      AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
        'AccessibleAfterFirstUnlockThisDeviceOnly',
    },
    setGenericPassword: jest.fn(async (username, password, options = {}) => {
      const service = options.service ?? 'default';
      items.set(service, {username, password, service, options});
      return {service, storage: 'keychain'};
    }),
    getGenericPassword: jest.fn(async (options = {}) => {
      const service = options.service ?? 'default';
      return items.has(service) ? items.get(service) : false;
    }),
    resetGenericPassword: jest.fn(async (options = {}) => {
      return items.delete(options.service ?? 'default');
    }),
  };
});

// ---- react-native-safe-area-context ------------------------------------------
// The real module reads insets from a native view, so under Jest every screen
// that calls `useSafeAreaInsets` throws "No safe area value available".
//
// Written here rather than pulled from the package's own `jest/mock` because
// that file is untranspiled TSX and this one states the values a test is
// asserting against. **Zeros on purpose**: a test that passes only because the
// harness invented a 44pt top inset is not testing this app's layout. The
// device build is where insets are real, and the simulator captures are where
// they are checked.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const insets = {top: 0, right: 0, bottom: 0, left: 0};
  const frame = {x: 0, y: 0, width: 390, height: 844};
  return {
    SafeAreaProvider: ({children}) => React.createElement(React.Fragment, null, children),
    SafeAreaConsumer: ({children}) => children(insets),
    SafeAreaView: ({children}) => React.createElement(React.Fragment, null, children),
    SafeAreaInsetsContext: React.createContext(insets),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: {insets, frame},
  };
});

// ---- centrifuge --------------------------------------------------------------
// The realtime client. Faked rather than stubbed for the same reason as the two
// stores above: what is worth asserting is BEHAVIOUR over the socket — that a
// resubscribe reporting `recovered: false` triggers a REST backfill and one
// reporting `recovered: true` does not, that publications fold in by seq, that
// the last unsubscribe is what actually tears a channel down. A `jest.fn()` that
// records `connect()` was called cannot answer any of those.
//
// The real module would also try to open a WebSocket, and there is no such
// global under Jest's node environment — so without this every test that mounts
// the signed-in shell would fail on a transport error rather than on anything
// it meant to check.
//
// `__clients` exposes the instances so a test can drive them: `__emit` on the
// client for connection state, `__emit` on a subscription for `subscribed` and
// `publication`.
jest.mock('centrifuge', () => {
  const clients = [];

  class FakeSubscription {
    constructor(channel, options) {
      this.channel = channel;
      this.options = options;
      this.state = 'unsubscribed';
      this.handlers = new Map();
      this.subscribeCount = 0;
      this.unsubscribeCount = 0;
    }
    on(event, fn) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event).add(fn);
      return this;
    }
    off(event, fn) {
      this.handlers.get(event)?.delete(fn);
      return this;
    }
    subscribe() {
      this.subscribeCount += 1;
      this.state = 'subscribed';
    }
    unsubscribe() {
      this.unsubscribeCount += 1;
      this.state = 'unsubscribed';
    }
    /** Drive an event as the server would. */
    __emit(event, ctx) {
      for (const fn of [...(this.handlers.get(event) ?? [])]) fn(ctx);
    }
    /** Everything a real `subscribed` does: the event, then the replay flush. */
    __subscribed({recovered = false, publications = []} = {}) {
      this.state = 'subscribed';
      this.__emit('subscribed', {
        recovered,
        hasRecoveredPublications: recovered && publications.length > 0,
      });
      // centrifuge-js flushes recovered publications SYNCHRONOUSLY right after
      // `subscribed`. The replay gate's whole correctness rests on that, so the
      // fake does it in the same order rather than on a later tick.
      for (const data of publications) this.__emit('publication', {data});
    }
  }

  class FakeCentrifuge {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.state = 'disconnected';
      this.subs = new Map();
      this.handlers = new Map();
      this.connectCount = 0;
      this.disconnectCount = 0;
      clients.push(this);
    }
    on(event, fn) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event).add(fn);
      return this;
    }
    off(event, fn) {
      this.handlers.get(event)?.delete(fn);
      return this;
    }
    __emit(event, ctx) {
      for (const fn of [...(this.handlers.get(event) ?? [])]) fn(ctx);
    }
    connect() {
      this.connectCount += 1;
      if (this.state === 'connected') return;
      this.state = 'connected';
      this.__emit('connecting', {});
      this.__emit('connected', {});
    }
    disconnect() {
      this.disconnectCount += 1;
      this.state = 'disconnected';
      this.__emit('disconnected', {});
    }
    newSubscription(channel, options) {
      const sub = new FakeSubscription(channel, options);
      this.subs.set(channel, sub);
      return sub;
    }
    getSubscription(channel) {
      return this.subs.get(channel) ?? null;
    }
    removeSubscription(sub) {
      this.subs.delete(sub.channel);
    }
  }

  return {
    __esModule: true,
    Centrifuge: FakeCentrifuge,
    __clients: clients,
    __reset: () => {
      clients.length = 0;
    },
  };
});

// ---- @react-native-community/netinfo ----------------------------------------
jest.mock('@react-native-community/netinfo', () => {
  const listeners = new Set();
  return {
    __esModule: true,
    default: {
      addEventListener: jest.fn(listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      __emit: state => {
        for (const listener of listeners) {
          listener(state);
        }
      },
      __listeners: listeners,
    },
  };
});

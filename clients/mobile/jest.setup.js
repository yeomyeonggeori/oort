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

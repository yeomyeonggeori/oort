/**
 * Test doubles for the native modules this client exercises under Jest.
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

// ---- expo-modules-core / expo-notifications ----------------------------------
// Mocked rather than transformed. Both packages ship ESM (`expo-notifications`'s
// entry point opens with `import { isRunningInExpoGo } from 'expo'`) and the
// `transformIgnorePatterns` above deliberately excludes node_modules, so any
// suite that transitively imports them would die on `Cannot use import statement
// outside a module`. Widening the transform to cover the whole Expo dependency
// tree would slow every run to buy nothing: there is no native side under Jest,
// so the real modules could not do anything anyway.
//
// `requireOptionalNativeModule` returns null on purpose — that is precisely what
// it does in a build where the native module is absent, and it is the branch
// `src/push/native.ts` must handle without throwing.
//
// `requireNativeViewManager` answers with a plain `View`, and that is a narrow
// claim on purpose. What is worth holding under Jest is the SHAPE of the tree
// the keyboard pane sits in — that the padding is a constant, that no
// `transform` style is set from JS, that the list and the composer are both
// inside the moving pane. The lift itself is native
// (`modules/momo-keyboard-native`) and no double of it here could say anything
// true about its timing; that number is measured natively, on a simulator, by
// `measure/`, and nowhere else.
jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: jest.fn(() => null),
  requireNativeModule: jest.fn(() => {
    throw new Error('native module unavailable under Jest');
  }),
  requireNativeViewManager: jest.fn(() => require('react-native').View),
}));

jest.mock('expo-notifications', () => ({
  // The real value, copied from
  // node_modules/expo-notifications/src/NotificationsEmitter.ts:16. A test that
  // invented its own string would pass while the app compared against a
  // different one.
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationCategoryAsync: jest.fn(async (identifier, actions) => ({
    identifier,
    actions,
  })),
  getPermissionsAsync: jest.fn(async () => ({
    granted: true,
    canAskAgain: true,
    status: 'granted',
  })),
  requestPermissionsAsync: jest.fn(async () => ({
    granted: true,
    canAskAgain: true,
    status: 'granted',
  })),
  getDevicePushTokenAsync: jest.fn(async () => ({type: 'ios', data: 'AABBCC'})),
  addNotificationResponseReceivedListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
  // Present so that importing it is an error a test can see, rather than
  // `undefined is not a function` at the call site. Nothing in this client may
  // call it: it mints an Expo-service token and routes our notifications through
  // EPNS (ADR-0137 D7 정오 5항).
  getExpoPushTokenAsync: jest.fn(async () => {
    throw new Error(
      'getExpoPushTokenAsync must never be called by this client — use getDevicePushTokenAsync',
    );
  }),
}));

// ---- expo-file-system -------------------------------------------------------
// Expo already links this module for the bare app; timeline attachments now use
// its native downloader so a 100MB file never takes a second trip through the
// JS heap. Jest keeps the same File/Directory shape and an in-memory disk. Tests
// can set `__state.failure` or `__state.progress` to drive the three UI states.
jest.mock('expo-file-system', () => {
  const files = new Set();
  const directories = new Set(['file:///cache']);
  const state = {
    downloads: [],
    uploads: [],
    failure: null,
    uploadFailure: null,
    uploadStatus: 200,
    progress: [{bytesWritten: 1, totalBytes: 2}, {bytesWritten: 2, totalBytes: 2}],
    uploadProgress: [{bytesSent: 1, totalBytes: 2}, {bytesSent: 2, totalBytes: 2}],
    sizes: new Map(),
  };
  const uriOf = value =>
    typeof value === 'string' ? value : value && typeof value.uri === 'string' ? value.uri : '';
  const join = values =>
    values
      .map(uriOf)
      .filter(Boolean)
      .join('/')
      .replace(/([^:]\/)\/+?/g, '$1');

  class Directory {
    constructor(...parts) {
      this.uri = join(parts);
    }
    get exists() {
      return directories.has(this.uri);
    }
    create() {
      directories.add(this.uri);
    }
  }

  class File {
    constructor(...parts) {
      this.uri = join(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    get size() {
      return state.sizes.get(this.uri) ?? 0;
    }
    delete() {
      files.delete(this.uri);
    }
    static async downloadFileAsync(url, destination, options = {}) {
      state.downloads.push({url, destination, options});
      for (const progress of state.progress) options.onProgress?.(progress);
      if (state.failure) throw state.failure;
      files.add(destination.uri);
      return destination;
    }
    createUploadTask(url, options = {}) {
      let cancelled = false;
      state.uploads.push({url, file: this, options});
      return {
        uploadAsync: async () => {
          for (const progress of state.uploadProgress) {
            options.onProgress?.(progress);
          }
          if (cancelled) throw new Error('upload cancelled');
          if (state.uploadFailure) throw state.uploadFailure;
          return {body: '', headers: {}, status: state.uploadStatus};
        },
        cancel: () => {
          cancelled = true;
        },
        release: () => {},
      };
    }
  }

  const cache = new Directory('file:///cache');
  return {
    Directory,
    File,
    UploadType: {BINARY_CONTENT: 0, MULTIPART: 1},
    Paths: {cache},
    __files: files,
    __state: state,
    __reset: () => {
      files.clear();
      directories.clear();
      directories.add('file:///cache');
      state.downloads.length = 0;
      state.uploads.length = 0;
      state.failure = null;
      state.uploadFailure = null;
      state.uploadStatus = 200;
      state.progress = [
        {bytesWritten: 1, totalBytes: 2},
        {bytesWritten: 2, totalBytes: 2},
      ];
      state.uploadProgress = [
        {bytesSent: 1, totalBytes: 2},
        {bytesSent: 2, totalBytes: 2},
      ];
      state.sizes.clear();
    },
  };
});

// ---- expo image/document pickers -------------------------------------------
// The bare app links both Expo modules through CocoaPods. Under Jest their ESM
// entries cannot run, so these doubles expose the native outcomes the Composer
// needs to distinguish: picked, cancelled, permission denied and provider error.
jest.mock('expo-image-picker', () => {
  const state = {
    result: {canceled: true, assets: null},
    failure: null,
    permission: {status: 'granted', accessPrivileges: 'all'},
  };
  return {
    __state: state,
    __reset: () => {
      state.result = {canceled: true, assets: null};
      state.failure = null;
      state.permission = {status: 'granted', accessPrivileges: 'all'};
    },
    launchImageLibraryAsync: jest.fn(async () => {
      if (state.failure) throw state.failure;
      return state.result;
    }),
    getMediaLibraryPermissionsAsync: jest.fn(async () => state.permission),
  };
});

jest.mock('expo-document-picker', () => {
  const state = {result: {canceled: true, assets: null}, failure: null};
  return {
    __state: state,
    __reset: () => {
      state.result = {canceled: true, assets: null};
      state.failure = null;
    },
    getDocumentAsync: jest.fn(async () => {
      if (state.failure) throw state.failure;
      return state.result;
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

// ---- expo-clipboard ----------------------------------------------------------
// The clipboard, faked as an actual box rather than a spy. What is worth
// asserting about 복사 is WHAT LANDED — the markdown source a person can paste
// back, not the rendered text — and a `jest.fn()` that records a call without
// keeping the value cannot answer that.
jest.mock('expo-camera', () => {
  const React = require('react');
  const {View} = require('react-native');
  const state = {
    permission: {granted: true, canAskAgain: true, status: 'granted'},
    onBarcodeScanned: null,
  };
  return {
    __state: state,
    __reset: () => {
      state.permission = {granted: true, canAskAgain: true, status: 'granted'};
      state.onBarcodeScanned = null;
    },
    __scan: data => {
      state.onBarcodeScanned?.({data});
    },
    useCameraPermissions: () => [
      state.permission,
      async () => state.permission,
    ],
    CameraView: props => {
      state.onBarcodeScanned = props.onBarcodeScanned ?? null;
      return React.createElement(View, {testID: props.testID ?? 'qr-camera-view'});
    },
  };
});

jest.mock('expo-clipboard', () => {
  const box = {value: null};
  return {
    __box: box,
    setStringAsync: async text => {
      box.value = text;
      return true;
    },
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

// ---- 시스템 색 스킴 (U2) ------------------------------------------------------
// React Native 의 jest 프리셋은 `useColorScheme` 을 **`'light'` 로** 목킹한다. 이
// 스위트는 그 사실보다 먼저 쓰였고, 폰이 다크 한 벌이던 시절의 낱값을 60 개 파일이
// 단정한다(`expect(style.color).toBe(color.text)`). 스킴이 둘이 된 지금 그 단정들은
// **다크 스킴에 대한 단정**이고, 그 사실은 여기 한 곳에 적힌다.
//
// 그래서 기본을 `'dark'` 로 뒤집는다. 라이트를 보고 싶은 테스트는 그렇다고 말해야
// 하고(`__setSystemColorScheme('light')`), 말한 것이 화면까지 닿게 실제 구독자를
// 깨운다 — 값만 바꾸고 알리지 않는 목은 「시스템이 바뀌면 화면이 따라간다」를
// 검사할 수 없다.
//
// **둘을 함께 목킹한다.** `design/theme.tsx` 는 두 경로로 시스템을 읽는다:
// 프로바이더는 `useColorScheme()` 으로 **구독**하고, 프로바이더 밖의 폴백은
// `Appearance.getColorScheme()` 으로 **묻기만** 한다(구독은 앱 전체에 하나여야
// 하므로). 하나만 목킹하면 그 둘이 테스트에서 서로 다른 답을 하게 된다.
const momoColorScheme = {
  current: 'dark',
  listeners: new Set(),
};
global.__momoColorScheme = momoColorScheme;

jest.mock('react-native/Libraries/Utilities/Appearance', () => {
  const store = global.__momoColorScheme;
  return {
    __esModule: true,
    getColorScheme: () => store.current,
    setColorScheme: next => {
      store.current = next ?? 'dark';
    },
    addChangeListener: listener => {
      store.listeners.add(listener);
      return {remove: () => store.listeners.delete(listener)};
    },
  };
});

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => {
  const React = require('react');
  const store = global.__momoColorScheme;
  const subscribe = onChange => {
    store.listeners.add(onChange);
    return () => store.listeners.delete(onChange);
  };
  const read = () => store.current;
  const useColorScheme = () => React.useSyncExternalStore(subscribe, read, read);
  const announce = () => {
    for (const onChange of [...store.listeners]) onChange();
  };
  useColorScheme.__setSystemColorScheme = next => {
    store.current = next;
    announce();
  };
  useColorScheme.__reset = () => {
    store.current = 'dark';
    announce();
  };
  return {__esModule: true, default: useColorScheme};
});

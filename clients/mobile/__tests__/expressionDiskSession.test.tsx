// #5455 B-2 — 이모티콘 그림의 기기 캐시(폰)의 **세션 경계와 시작 순서**: ADR-0218 §14 M2.5 · MA7(시작 청소) · MA8(세션 경계).
//
// 로그아웃(`signOut`)·토큰 만료·복원 거절에서 모든 보관 칸·shelf·잰 크기가 지워지는지를 **`SessionProvider` 정리 효과와 `leftSession` 효과 둘 다**에서 잰다 — `ExpressionProvider` 의
// `dispose` 에만 걸지 않는다(만료된 채 앱이 켜져 로그인 화면으로 가면 그 provider 가 뜨지 않는다). 파일은 `expo-file-system` 의 메모리 구현(`fixtures/memoryExpoFs.ts`) 위의 진짜 백엔드다.
import {onlineManager, QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Text} from 'react-native';
import {Paths} from 'expo-file-system';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {useAuthGate, SessionProvider, useSession} from '../src/session/useSession';
import {
  __resetSessionStore,
  initSessionStore,
  keychainSettled,
  markAuthExpired,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {NON_SECRET_KEYS, nonSecretStore} from '../src/storage/kv';
import {attachmentSizeMemory, unfurlHeightMemory} from '../src/storage/measureMemory';
import {startExpressionDiskBoot} from '../src/features/expressions/disk/boot';
import {
  compartmentNamesSync,
  createFileDiskBackend,
} from '../src/features/expressions/disk/fileBackend';
import {
  destroyExpressionDisks,
  forgetExpressionDisk,
} from '../src/features/expressions/disk/signOut';
import {readSessionGeneration} from '../src/features/expressions/disk/generation';
import {diskName, ME, OTHER_ME, OTHER_WS, uuid, WS} from './fixtures/expressionDiskWorld';
import type {MemoryFsState} from './fixtures/memoryExpoFs';

jest.mock('expo-file-system', () =>
  jest.requireActual('./fixtures/memoryExpoFs').createMemoryExpoFs(),
);

const fs = (jest.requireMock('expo-file-system') as {__fs: MemoryFsState}).__fs;
const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
const keychainItems = (jest.requireMock('react-native-keychain') as {__items: Map<string, {password: string}>}).__items;
const DAY = 86_400_000;
const SHA = 'ab'.repeat(32);
const cache = () => Paths.cache.uri;
const folder = (name: string) => `${cache()}${name}/`;
const entry = (n: number, size = 'large') => `${uuid(n)}_${size}_${SHA}.png`;
const otherName = `oort-expr-img-v1.${OTHER_WS}.${OTHER_ME}`;

/** 보관 칸 폴더와 그 안의 파일을 직접 만든다(앞서 켠 앱이 남긴 것). */
function plant(name: string, entries: Array<{file: string; modified?: number}> = [{file: entry(1)}]) {
  fs.dirs.add(folder(name));
  for (const {file, modified} of entries) {
    fs.files.set(`${folder(name)}${file}`, {bytes: new Uint8Array(10), modified: modified ?? fs.clock.now});
  }
}
const present = (name: string) => fs.dirs.has(folder(name));
const plantEverything = () => {
  plant(diskName());
  plant(otherName);
  fs.dirs.add(`${cache()}oort-expressions-1700000000-abc/`);
  fs.files.set(`${cache()}oort-expressions-1700000000-abc/1.png`, {bytes: new Uint8Array(4), modified: 0});
  fs.files.set(`${cache()}oort-expression-transfer-1700000000-xyz`, {bytes: new Uint8Array(4), modified: 0});
  nonSecretStore().set(NON_SECRET_KEYS.expressionShelf, JSON.stringify({v: 2}));
  attachmentSizeMemory.set(uuid(1), [100, 200]);
  unfurlHeightMemory.set(uuid(2), [300]);
};
const wiped = () => ({
  compartments: compartmentNamesSync(),
  shelf: nonSecretStore().getString(NON_SECRET_KEYS.expressionShelf),
  sizes: attachmentSizeMemory.get(uuid(1)),
  heights: unfurlHeightMemory.get(uuid(2)),
});

beforeEach(() => {
  fs.reset();
  mmkvStore.clear();
  attachmentSizeMemory.clearForTest();
  unfurlHeightMemory.clearForTest();
});
afterEach(() => {
  cleanup();
});

describe('MA7 — 시작 청소: 세션을 복원하기 전에 시작한다', () => {
  const gate = () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {
      release = resolve;
    });
    return {ready, release};
  };
  const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  it('고아(oort-expressions-*·oort-expression-transfer-*)와 수명이 지난 항목은 세션 저장소가 자리를 잡기 전에 지우고, 현재 칸 밖은 자리를 잡은 뒤 지운다', async () => {
    plant(diskName(), [{file: entry(1), modified: fs.clock.now}, {file: entry(2), modified: fs.clock.now - 8 * DAY}]);
    plant(otherName);
    fs.dirs.add(`${cache()}oort-expressions-1700000000-abc/`);
    fs.files.set(`${cache()}oort-expression-transfer-1700000000-xyz`, {bytes: new Uint8Array(4), modified: 0});
    const {ready, release} = gate();
    const backend = createFileDiskBackend({now: () => fs.clock.now});
    const boot = startExpressionDiskBoot({ready, current: () => ({workspaceId: WS, memberId: ME}), backend});
    await macrotask();
    // 세션 저장소는 아직 자리를 잡지 못했다(`ready` 가 안 풀렸다): 그래도 이미 고아와 수명 청소가 끝났다.
    expect(fs.dirs.has(`${cache()}oort-expressions-1700000000-abc/`)).toBe(false);
    expect(fs.files.has(`${cache()}oort-expression-transfer-1700000000-xyz`)).toBe(false);
    expect(fs.files.has(`${folder(diskName())}${entry(2)}`)).toBe(false); // 8일 지난 항목
    expect(fs.files.has(`${folder(diskName())}${entry(1)}`)).toBe(true);
    expect(present(otherName)).toBe(true); // 누구의 세션인지 아직 모른다
    release();
    await boot;
    expect(present(otherName)).toBe(false);
    expect(present(diskName())).toBe(true);
    expect(fs.files.has(`${folder(diskName())}${entry(1)}`)).toBe(true);
  });

  it('저장된 자격이 없으면 모든 칸을 지운다', async () => {
    plant(diskName());
    plant(otherName);
    const {ready, release} = gate();
    const boot = startExpressionDiskBoot({ready, current: () => null, backend: createFileDiskBackend({now: () => fs.clock.now})});
    release();
    await boot;
    expect(compartmentNamesSync()).toEqual([]);
  });

  it('어느 걸음이 실패해도 던지지 않고 나머지를 한다', async () => {
    plant(otherName);
    fs.dirs.add(`${cache()}oort-expressions-1-a/`);
    const backend = createFileDiskBackend({now: () => fs.clock.now});
    const failing = {...backend, list: jest.fn().mockRejectedValueOnce(new Error('listing failed')).mockResolvedValue([otherName])};
    await expect(
      startExpressionDiskBoot({ready: Promise.reject(new Error('keychain')), current: () => null, backend: failing as never}),
    ).resolves.toBeUndefined();
    expect(fs.dirs.has(`${cache()}oort-expressions-1-a/`)).toBe(false); // 고아는 목록 오류와 상관없이 지워졌다
    expect(present(otherName)).toBe(false); // 자리를 못 잡았어도 현재 자격(없음)을 보고 지웠다
  });
});

describe('MA8 — 로그아웃·교체가 지나는 함수', () => {
  it('forgetExpressionDisk 는 세대를 올리고 모든 칸과 고아를 지운다 — destroyExpressionDisks 는 세대를 올리지 않는다', () => {
    plantEverything();
    const before = readSessionGeneration();
    destroyExpressionDisks();
    expect(readSessionGeneration()).toBe(before);
    expect(compartmentNamesSync()).toEqual([]);
    expect(fs.dirs.has(`${cache()}oort-expressions-1700000000-abc/`)).toBe(false);
    plant(diskName());
    forgetExpressionDisk();
    expect(readSessionGeneration()).toBe(before + 1);
    expect(compartmentNamesSync()).toEqual([]);
  });

  it('어떤 실패도 던지지 않는다(지우는 일이 로그아웃을 막지 않는다)', () => {
    plant(diskName());
    const original = fs.dirs.delete.bind(fs.dirs);
    jest.spyOn(fs.dirs, 'delete').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => forgetExpressionDisk()).not.toThrow();
    jest.restoreAllMocks();
    fs.dirs.delete = original;
  });
});

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {
    id: ME,
    workspaceId: WS,
    kind: 'human' as const,
    displayName: 'Seongjae Kwak',
    handle: 'seongjae',
  },
};
function Probe(): React.JSX.Element {
  const {gate} = useAuthGate();
  return <Text testID="kind">{gate.kind}</Text>;
}
async function relaunchWithStoredSession(): Promise<void> {
  mmkvStore.clear();
  keychainItems.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();
  __resetSessionStore();
  await initSessionStore();
}
const fetchAnswers = (status: number, body: unknown) => {
  globalThis.fetch = jest.fn(async () => ({
    ok: status === 200,
    status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
};

describe('MA8 — `leftSession` 효과: 토큰 만료·복원 거절·자격 없음 (provider 가 뜨지 않는 길)', () => {
  beforeEach(() => {
    onlineManager.setOnline(true);
  });

  it('복원이 거절된 시작(401)이 로그인 화면에 닿으면 모든 보관 칸·shelf·잰 크기가 지워진다', async () => {
    await relaunchWithStoredSession();
    plantEverything();
    fetchAnswers(401, {error: {message: 'invalid refresh token'}});
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('kind').props.children).toBe('signedOut'));
    expect(wiped()).toEqual({compartments: [], shelf: undefined, sizes: null, heights: null});
  });

  it('저장된 자격이 없는 시작도 지운다', async () => {
    mmkvStore.clear();
    keychainItems.clear();
    __resetSessionStore();
    await initSessionStore();
    plantEverything();
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('kind').props.children).toBe('signedOut'));
    expect(wiped()).toEqual({compartments: [], shelf: undefined, sizes: null, heights: null});
  });

  it('로그인한 채 토큰이 만료되면(401 이 회전 뒤에도 남는다) 지운다', async () => {
    await relaunchWithStoredSession();
    fetchAnswers(200, {accessToken: 'access-token-2', refreshToken: 'refresh-token-2'});
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('kind').props.children).toBe('signedIn'));
    plantEverything(); // 로그인 중에 쌓인 것
    act(() => markAuthExpired());
    await waitFor(() => expect(screen.getByTestId('kind').props.children).toBe('signedOut'));
    expect(wiped()).toEqual({compartments: [], shelf: undefined, sizes: null, heights: null});
  });

  it('서버에 닿지 못한 시작(세션을 지우지 않는다)과 로그인 상태에서는 아무것도 지우지 않는다', async () => {
    await relaunchWithStoredSession();
    plantEverything();
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('kind').props.children).toBe('restoring'));
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    });
    expect(compartmentNamesSync().sort()).toEqual([diskName(), otherName].sort());
    expect(nonSecretStore().getString(NON_SECRET_KEYS.expressionShelf)).toBeDefined();
    expect(attachmentSizeMemory.get(uuid(1))).not.toBeNull();
  });
});

describe('MA8 — `SessionProvider`: 정리 효과(토큰 만료·계정 교체)와 signOut', () => {
  const queryClient = () => new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  function mountSession() {
    let signOut: (() => void) | null = null;
    function Capture(): null {
      signOut = useSession().signOut;
      return null;
    }
    const client = queryClient();
    const tree = (memberId: string) => (
      <QueryClientProvider client={client}>
        <SessionProvider member={{id: memberId, workspaceId: WS, kind: 'human', displayName: memberId, handle: memberId} as never}>
          <Capture />
        </SessionProvider>
      </QueryClientProvider>
    );
    const view = render(tree(ME));
    return {
      signOut: () => signOut!(),
      switchAccount: () => view.rerender(tree(OTHER_ME)),
      endSession: view.unmount,
    };
  }

  it('토큰 만료로 provider 가 내려가면(unmount) 모든 보관 칸·shelf·잰 크기를 지운다 — 세대는 올리지 않는다', () => {
    const session = mountSession();
    plantEverything();
    const generation = readSessionGeneration();
    session.endSession();
    expect(wiped()).toEqual({compartments: [], shelf: undefined, sizes: null, heights: null});
    expect(readSessionGeneration()).toBe(generation);
  });

  it('같은 프로세스에서 다른 계정이 들어오면(멤버가 바뀐다) 앞 칸을 모두 지운다', () => {
    const session = mountSession();
    plantEverything();
    session.switchAccount();
    expect(wiped()).toEqual({compartments: [], shelf: undefined, sizes: null, heights: null});
  });

  it('signOut 은 세대를 올리고 모든 보관 칸을 그 자리에서 지우며 shelf·잰 크기도 지운다', () => {
    fetchAnswers(200, {});
    const session = mountSession();
    plantEverything();
    const generation = readSessionGeneration();
    act(() => session.signOut());
    expect(readSessionGeneration()).toBe(generation + 1);
    expect(wiped()).toEqual({compartments: [], shelf: undefined, sizes: null, heights: null});
  });
});

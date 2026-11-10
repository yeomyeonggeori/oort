// #5455 B-2 — 보관 칸을 앱에 이어 붙이는 **연결 줄**의 시험(웹 B-1 검수 Info I1: 부품 연결 줄에 시험이 없었다).
//   · `ExpressionProvider`: 칸을 연다(`openPhoneExpressionDisk` → 저장소의 일곱째 인자) · `status === 'connected'` 마다 `reconnected()` 를 **`refresh(true)` 보다 먼저** 부른다
//     (문을 올린 뒤에 시작한 읽기만 그 재연결을 확인한다) · 연결 중·끊김에서는 부르지 않는다.
//   · `App.tsx`: 시작 청소를 세션 저장소가 자리 잡기 **전에** 시작하고, 자리 잡은 뒤의 저장된 자격(현재 칸)을 읽는다.
// 저장소의 문 규칙(첫 연결 예외 포함)은 `expressionDisk.test.tsx` 가 잰다.
import 'react-native-url-polyfill/auto';
import {act, cleanup, render, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ExpressionProvider} from '../src/features/expressions/ExpressionProvider';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import {createPhoneExpressionStore} from '../src/features/expressions/store';
import {startExpressionDiskBoot} from '../src/features/expressions/disk/boot';
import {
  __resetSessionStore,
  initSessionStore,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import App from '../App';
import {diskName, ME, WS} from './fixtures/expressionDiskWorld';

jest.mock('../src/features/expressions/disk/boot', () => ({
  startExpressionDiskBoot: jest.fn(async () => undefined),
}));
jest.mock('../src/features/expressions/store', () => ({
  ...jest.requireActual('../src/features/expressions/store'),
  createPhoneExpressionStore: jest.fn(),
}));
jest.mock('../src/features/emoji/catalogMemory', () => ({
  warmEmojiCatalog: jest.fn(async () => undefined),
}));
jest.mock('../src/shell/AppShell', () => ({__esModule: true, default: () => null}));
jest.mock('../src/screens/ConnectScreen', () => ({__esModule: true, default: () => null}));
let mockMemberId = '00000000-0000-4000-8000-000000000002';
jest.mock('../src/session/useSession', () => ({
  ...jest.requireActual('../src/session/useSession'),
  useSession: () => ({
    workspaceId: '00000000-0000-4000-8000-000000000001',
    member: {id: mockMemberId},
    signOut: jest.fn(),
  }),
}));

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
const keychainItems = (jest.requireMock('react-native-keychain') as {__items: Map<string, {password: string}>}).__items;
const created = createPhoneExpressionStore as unknown as jest.Mock;

function fakeStore() {
  return {
    start: jest.fn(),
    subscribe: jest.fn(() => () => undefined),
    snapshot: jest.fn(() => ({items: [], shelf: [], state: 'ready', revision: 0})),
    refresh: jest.fn(async () => undefined),
    setOnline: jest.fn(),
    socketLost: jest.fn(),
    reconnected: jest.fn(),
    dispose: jest.fn(),
    changed: jest.fn(),
    detailed: jest.fn(),
    resetNotices: jest.fn(),
  };
}

afterEach(() => {
  cleanup();
  created.mockReset();
  mockMemberId = '00000000-0000-4000-8000-000000000002';
});

describe('ExpressionProvider 의 연결 줄', () => {
  const tree = (status: 'connecting' | 'connected' | 'disconnected') => (
    <RealtimeContext.Provider value={{rail: null, status, subscriptionsWanted: false}}>
      <ExpressionProvider>{null}</ExpressionProvider>
    </RealtimeContext.Provider>
  );

  it('보관 칸을 열어 저장소의 일곱째 인자로 넘긴다(칸 이름에 워크스페이스와 멤버가 든다)', () => {
    const store = fakeStore();
    created.mockReturnValue(store);
    render(tree('connecting'));
    expect(created).toHaveBeenCalledTimes(1);
    const disk = created.mock.calls[0][6] as {name: string};
    expect(disk.name).toBe(diskName(WS, ME));
  });

  it('uuid 모양이 아닌 id(칸 이름을 만들 수 없다)이면 칸 없이 — 예전처럼 — 만든다', () => {
    mockMemberId = 'not-a-uuid';
    created.mockReturnValue(fakeStore());
    render(tree('connecting'));
    expect(created.mock.calls[0][6]).toBeNull();
  });

  it('connected 마다 reconnected() 를 부르고 그것이 전체 읽기(refresh(true))보다 먼저다. 연결 중·끊김에서는 부르지 않는다', async () => {
    const store = fakeStore();
    created.mockReturnValue(store);
    const view = render(tree('connecting'));
    expect(store.reconnected).not.toHaveBeenCalled();
    view.rerender(tree('connected'));
    await waitFor(() => expect(store.reconnected).toHaveBeenCalledTimes(1));
    view.rerender(tree('connecting'));
    view.rerender(tree('disconnected'));
    expect(store.reconnected).toHaveBeenCalledTimes(1);
    view.rerender(tree('connected'));
    await waitFor(() => expect(store.reconnected).toHaveBeenCalledTimes(2));
    // 순서: 문을 올린 **뒤에** 읽기가 시작한다.
    const raised = store.reconnected.mock.invocationCallOrder;
    const reads = store.refresh.mock.invocationCallOrder;
    const lastRaise = raised[raised.length - 1];
    expect(reads.some(order => order > lastRaise)).toBe(true);
    expect(reads.filter(order => order < lastRaise).length).toBeGreaterThan(0);
    const readAfterFirstRaise = reads.find(order => order > raised[0])!;
    expect(raised[0]).toBeLessThan(readAfterFirstRaise);
  });
});

describe('App 의 시작 청소 연결', () => {
  it('세션 저장소가 자리 잡기 전에(첫 효과에서) 시작하고, 현재 칸은 자리 잡은 뒤 읽은 저장된 자격에서 온다', async () => {
    mmkvStore.clear();
    keychainItems.clear();
    __resetSessionStore();
    __resetServerBaseCache();
    setServerBase('https://api.example.com');
    const boot = startExpressionDiskBoot as jest.Mock;
    boot.mockReset();
    // 시작하는 순간 세션 저장소의 약속이 아직 풀리지 않았음을 적어 둔다(효과 안에서 불린다 — 풀림 알림은 그 뒤 마이크로태스크다).
    const seen: {settledAtStart: boolean | null; ready: Promise<unknown> | null; current: (() => unknown) | null} = {
      settledAtStart: null,
      ready: null,
      current: null,
    };
    boot.mockImplementation(async (options: {ready: Promise<unknown>; current: () => unknown}) => {
      let settled = false;
      void options.ready.then(() => {
        settled = true;
      });
      seen.settledAtStart = settled;
      seen.ready = options.ready;
      seen.current = options.current;
    });
    render(<App />);
    await waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    expect(seen.settledAtStart).toBe(false);
    expect(seen.ready).toBe(initSessionStore()); // 세션을 복원하는 바로 그 약속을 기다린다
    await act(async () => {
      await seen.ready;
    });
    expect(seen.current!()).toBeNull(); // 저장된 자격이 없다
    // 저장된 자격이 있는 다음 시작: 현재 칸이 그 멤버의 것이다.
    sessionPort.applyLogin({
      accessToken: 'a',
      refreshToken: 'r',
      realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
      member: {id: ME, workspaceId: WS, kind: 'human', displayName: 'x', handle: 'x'},
    } as never);
    await keychainSettled();
    __resetSessionStore();
    await initSessionStore();
    expect(seen.current!()).toEqual({workspaceId: WS, memberId: ME});
  });
});

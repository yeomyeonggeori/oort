import {AVAILABILITY_REFRESH_MS} from '@momo/core/features/presence/model';
import type {Member} from '@momo/core/lib/api';
import {focusManager, QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, renderHook} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {useDirectory} from '../src/features/workspace/queries';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 명부는 보이는 동안 주기적으로 다시 읽힌다 (#4692, ADR-0160 ②).
//
// 접속 여부(`online`)는 서버가 명부를 읽을 때 전송에서 읽어 싣는 값이라, 점은 마지막 명부 읽기만큼만
// 신선하다. 그래서 점이 그려지는 동안 명부는 `AVAILABILITY_REFRESH_MS` 마다 다시 읽혀야 하고, 앱이 앞에
// 없을 때는(`focusManager` 가 `AppState` 에 이어져 있다) 읽지 않아야 한다. `queries.ts` 에는 시험 파일이
// 없었다(대상이 같은 새 파일이다).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

let rosterReads = 0;
let queryClient: QueryClient | null = null;

beforeEach(() => {
  installAppClock();
  rosterReads = 0;
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
  focusManager.setFocused(true);
  globalThis.fetch = jest.fn(async (url: string) => {
    if (url.includes('/roster')) rosterReads += 1;
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({members: []}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  focusManager.setFocused(undefined);
  jest.useRealTimers();
});

function mount() {
  queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
  const client = queryClient;
  return renderHook(() => useDirectory(WS), {
    wrapper: ({children}: {children: React.ReactNode}) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

describe('useDirectory: 명부를 점의 주기로 다시 읽는다 (#4692)', () => {
  it('마운트에 한 번, 그 뒤 주기마다 한 번씩 읽고, 언마운트하면 멈춘다', async () => {
    const view = mount();
    await advance(0);
    expect(rosterReads).toBe(1);

    await advance(AVAILABILITY_REFRESH_MS - 1);
    expect(rosterReads).toBe(1); // 때가 되기 전에는 읽지 않는다
    await advance(1);
    expect(rosterReads).toBe(2);
    await advance(AVAILABILITY_REFRESH_MS);
    expect(rosterReads).toBe(3);

    view.unmount();
    await advance(AVAILABILITY_REFRESH_MS * 3);
    expect(rosterReads).toBe(3); // 보는 사람이 없으면 묻는 사람도 없다
  });

  it('앱이 앞에 없는 동안은 읽지 않고, 돌아오면 다시 주기를 센다', async () => {
    mount();
    await advance(0);
    expect(rosterReads).toBe(1);

    focusManager.setFocused(false); // 백그라운드
    await advance(AVAILABILITY_REFRESH_MS * 3);
    expect(rosterReads).toBe(1);

    focusManager.setFocused(true);
    await advance(AVAILABILITY_REFRESH_MS);
    expect(rosterReads).toBeGreaterThan(1);
  });
});

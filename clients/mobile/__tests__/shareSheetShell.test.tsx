import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Share, type ShareAction} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import {presentShareSheet, resetShareSheetForTest} from '../src/lib/shareSheet';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 공유 시트 막이는 앱의 셸에 달려 있다 (#5207). 막이 자체의 시간·모양은 `shareSheet.test.tsx`, 목록과의 관계는 `timelineShareSheet.test.tsx` 가 잰다. 이 파일은 **실제 셸**에
// 그 막이가 한 번 달려 있어서 `presentShareSheet` 가 열리면 화면 전체를 덮는다는 것만 잰다 — 시뮬레이터의 하네스(`measure/shareAttachment.tsx`)는 셸이 없어 막이를 스스로 세우므로,
// 셸의 배선은 하네스가 보증하지 못한다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string) => {
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: [{id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false}]});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: []});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

let queryClient: QueryClient | null = null;

beforeEach(() => {
  resetShareSheetForTest();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

describe('셸에 공유 시트 막이가 달려 있다', () => {
  it('시트가 떠 있는 동안 셸 위에 서고, 시트가 끝나고 유예가 지나면 걷힌다', async () => {
    queryClient = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
    });
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AppShell member={SELF} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(screen.queryByTestId('share-sheet-touch-shield')).toBeNull();

    let finish!: (result: ShareAction) => void;
    jest.spyOn(Share, 'share').mockImplementation(
      () => new Promise<ShareAction>(resolve => (finish = resolve)),
    );
    let done!: Promise<ShareAction>;
    act(() => {
      done = presentShareSheet({url: 'file:///cache/v1.mp4'});
    });
    expect(screen.getByTestId('share-sheet-touch-shield')).toBeTruthy();

    await act(async () => {
      finish({action: Share.dismissedAction});
      await done;
    });
    await waitFor(() => expect(screen.queryByTestId('share-sheet-touch-shield')).toBeNull(), {timeout: 2_000});
    // 깨뜨리면: `AppShell` 에서 `<ShareSheetTouchShield />` 를 빼면 첫 `getByTestId` 가 던진다.
  });
});

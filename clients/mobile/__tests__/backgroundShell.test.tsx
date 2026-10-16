import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  __resetBackgroundStoreForTests,
  __setDiskPort,
  setBackground,
} from '../src/design/background/store';
import {ThemeProvider} from '../src/design/theme';
import {paletteFrom} from '../src/design/tokens';
import AppShell from '../src/shell/AppShell';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// ADR-0189 증보 2 — 배경이 **홈과 대화 둘 다** 뒤에 깔리고, 접근성 설정이 이긴다 (#3907).
//
// 홈(셸의 바닥)과 대화(자기 바닥을 그리는 화면)는 서로 다른 코드가 바닥을 그린다.
// 둘 중 하나만 연결돼도 사진이 한 화면에서만 보이는 결함이 되므로, 둘을 한 셸에서
// 같이 잰다. 접근성 설정(투명도 줄이기·대비 높이기)이 켜지면 둘 다 기본 바닥이다.
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

const ROSTER = [
  {
    id: SELF_ID,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '곽성재',
    handle: 'seongjae',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    throw new Error(`unrouted request: ${url}`);
  }) as unknown as typeof fetch;
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

const a11y = AccessibilityInfo as unknown as {
  isReduceTransparencyEnabled: jest.Mock;
  isDarkerSystemColorsEnabled?: jest.Mock;
  addEventListener: jest.Mock;
};

let queryClient: QueryClient | null = null;
let handlers: Record<string, Array<(value: boolean) => void>> = {};

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AppShell member={SELF} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  mmkvStore.clear();
  __resetBackgroundStoreForTests();
  __setDiskPort({
    uri: name => `file:///document/oort-background/${name}`,
    exists: () => true,
    remove: () => {},
    clearAll: () => {},
  });
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  installFetch();
  handlers = {};
  a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(false));
  a11y.isDarkerSystemColorsEnabled = jest.fn(() => Promise.resolve(false));
  a11y.addEventListener.mockImplementation((event: string, handler: (value: boolean) => void) => {
    (handlers[event] ??= []).push(handler);
    return {remove: () => {}};
  });
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

async function openHome() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
}

const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) ?? {};

describe('홈 바닥', () => {
  it('배경을 고르지 않았으면 기본 그라데이션이고 배경 층은 없다', async () => {
    await openHome();
    expect(screen.queryByTestId('app-background')).toBeNull();
    expect(String(flat('shell-canvas').experimental_backgroundImage)).toMatch(/^linear-gradient/);
  });

  it('배경을 고르면 그 층이 바닥을 그리고 scrim 이 모드별 토큰 색으로 얹힌다', async () => {
    setBackground({kind: 'solid', id: 'sage'});
    await openHome();
    expect(screen.getByTestId('app-background-solid')).toBeTruthy();
    // 시스템 기본은 다크(jest.setup.js)다.
    const dark = paletteFrom('dawnsky', 'dark', null, true);
    expect(flat('app-background-scrim').backgroundColor).toBe(dark.backdropScrim);
    // 캔버스는 자기 그라데이션을 걷는다 — 이중으로 그리지 않는다.
    expect(flat('shell-canvas').experimental_backgroundImage).toBeUndefined();
  });

  it('탭바 밑 페이드는 사라지지 않고 scrim 색으로 녹는다 — 사진 위에 불투명 띠가 서지 않는다', async () => {
    const dark = paletteFrom('dawnsky', 'dark', null, true);
    setBackground({kind: 'solid', id: 'sage'});
    await openHome();
    const image = String(flat('shell-fade').experimental_backgroundImage);
    expect(image).toContain(dark.backdropScrim);
    expect(image).not.toContain(`${dark.canvasBottom} 62%`);
  });

  it('사진이 사라졌으면 저장소가 없음으로 되돌려 이미지 없는 바닥을 그리지 않는다', async () => {
    __setDiskPort({
      uri: name => name,
      exists: () => false,
      remove: () => {},
      clearAll: () => {},
    });
    mmkvStore.set(
      'momo.mobile.background.v1',
      JSON.stringify({v: 1, kind: 'photo', file: 'bg-9.jpg', width: 100, height: 100}),
    );
    __resetBackgroundStoreForTests();
    __setDiskPort({uri: n => n, exists: () => false, remove: () => {}, clearAll: () => {}});
    await openHome();
    expect(screen.queryByTestId('app-background')).toBeNull();
  });
});

describe('대화 바닥', () => {
  it('홈과 대화가 각자 배경 층을 그린다', async () => {
    setBackground({kind: 'preset', id: 'bam'});
    await openHome();
    expect(screen.getAllByTestId('app-background')).toHaveLength(1);
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    await waitFor(() => expect(screen.getAllByTestId('app-background').length).toBeGreaterThanOrEqual(2));
  });
});

describe('시스템 접근성 설정이 이긴다', () => {
  it('투명도 줄이기가 켜져 있으면 고른 배경이 있어도 홈·대화 모두 기본 바닥이다', async () => {
    a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(true));
    setBackground({kind: 'solid', id: 'rose'});
    await openHome();
    await waitFor(() => expect(screen.queryByTestId('app-background')).toBeNull());
    expect(String(flat('shell-canvas').experimental_backgroundImage)).toMatch(/^linear-gradient/);
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    await waitFor(() => expect(screen.getByTestId('conversation-header')).toBeTruthy());
    expect(screen.queryByTestId('app-background')).toBeNull();
  });

  it('대비 높이기도 같다', async () => {
    a11y.isDarkerSystemColorsEnabled = jest.fn(() => Promise.resolve(true));
    setBackground({kind: 'solid', id: 'rose'});
    await openHome();
    await waitFor(() => expect(screen.queryByTestId('app-background')).toBeNull());
  });

  it('앱이 떠 있는 동안 설정이 바뀌면 따라간다 — 켜면 꺼지고, 끄면 돌아온다', async () => {
    setBackground({kind: 'solid', id: 'rose'});
    await openHome();
    expect(screen.getByTestId('app-background')).toBeTruthy();
    act(() => (handlers.reduceTransparencyChanged ?? []).forEach(emit => emit(true)));
    expect(screen.queryByTestId('app-background')).toBeNull();
    act(() => (handlers.reduceTransparencyChanged ?? []).forEach(emit => emit(false)));
    expect(screen.getByTestId('app-background')).toBeTruthy();
    act(() => (handlers.darkerSystemColorsChanged ?? []).forEach(emit => emit(true)));
    expect(screen.queryByTestId('app-background')).toBeNull();
  });
});

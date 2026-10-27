import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';
import {Linking, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {useAppUpdateOffer} from '../src/features/appUpdate/useAppUpdateOffer';

// 새 버전 배너가 서는 두 자리(성재 결재 2026-10-16): 홈 맨 위, 프로필 시트의 「내 상태」 위.
// 훅은 전역 설정(jest.setup.js)이 기본 null 로 막아 두므로 여기서는 제안을 쥐어 준다.
jest.mock('../src/features/appUpdate/useAppUpdateOffer', () => ({
  useAppUpdateOffer: jest.fn(),
}));
const offerHook = useAppUpdateOffer as jest.Mock;

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const SELF: Member = {id: SELF_ID, workspaceId: WS, kind: 'human', displayName: '곽성재', handle: 'seongjae'};
const OFFER = {version: '0.1.29', latestBuild: 3036, currentBuild: 3035, testflight: true};

function jsonResponse(status: number, body: unknown): Response {
  return {status, ok: status < 300, text: async () => JSON.stringify(body)} as unknown as Response;
}

/** 렌더 트리를 문서 순서의 testID·글자 목록으로 편다. */
function flatten(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    node.forEach(child => flatten(child, out));
    return out;
  }
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  const el = node as {props?: {testID?: string}; children?: unknown};
  if (el.props?.testID) out.push(el.props.testID);
  flatten(el.children, out);
  return out;
}

let queryClient: QueryClient | null = null;
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
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin({
    accessToken: 'a',
    refreshToken: 'r',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
  globalThis.fetch = jest.fn(async (url: string) => {
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: [{id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false}],
      });
    }
    if (url.includes('/roster')) {
      return jsonResponse(200, {
        members: [
          {id: SELF_ID, workspaceId: WS, kind: 'human', status: 'active', displayName: '곽성재', handle: 'seongjae', channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0},
        ],
      });
    }
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

describe('홈 배너', () => {
  it('새 판이 있으면 목록 맨 위에 서고, 누르면 TestFlight 시트가 열린다', async () => {
    offerHook.mockReturnValue(OFFER);
    renderShell();
    await waitFor(() => expect(screen.getByTestId('home-update-banner')).toBeTruthy());
    expect(screen.getByText('새 버전 0.1.29')).toBeTruthy();
    fireEvent.press(screen.getByTestId('home-update-banner-action'));
    expect(screen.getByTestId('app-update-sheet')).toBeTruthy();
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    fireEvent.press(screen.getByText('TestFlight 열기'));
    expect(open).toHaveBeenCalledWith('itms-beta://');
  });

  it('제안이 없으면(최신이거나 피드를 못 읽음) 아무것도 서지 않는다', async () => {
    offerHook.mockReturnValue(null);
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(screen.queryByTestId('home-update-banner')).toBeNull();
  });
});

describe('설정 페이지 배너', () => {
  it('「내 상태」 위에 상시 서고, 상태 구역보다 앞이다', async () => {
    offerHook.mockReturnValue(OFFER);
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('profile-avatar'));
    const banner = await screen.findByTestId('profile-update-banner');
    expect(banner).toBeTruthy();
    // 설정 페이지의 스크롤이 이미 가로 여백을 준다 — 배너가 한 번 더 들이면 카드보다 안쪽으로 서 보인다.
    expect(StyleSheet.flatten(banner.props.style).marginHorizontal).toBe(0);
    const order = flatten(screen.toJSON());
    const bannerAt = order.indexOf('profile-update-banner');
    const statusAt = order.indexOf('내 상태');
    expect(bannerAt).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(statusAt);
    fireEvent.press(screen.getByTestId('profile-update-banner-action'));
    expect(screen.getByTestId('app-update-sheet')).toBeTruthy();
  });

  it('제안이 없으면 설정 페이지에도 없다', async () => {
    offerHook.mockReturnValue(null);
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('profile-avatar'));
    await screen.findByTestId('settings-page');
    expect(screen.queryByTestId('profile-update-banner')).toBeNull();
  });
});

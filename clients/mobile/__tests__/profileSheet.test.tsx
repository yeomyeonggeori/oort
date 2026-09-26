import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import {getPermissionsAsync} from 'expo-notifications';
import React from 'react';
import {Linking, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import {darkPalette, lightPalette} from '../src/design/tokens';
import {appVersionLabel} from '../src/features/profile/appVersion';
import AppShell from '../src/shell/AppShell';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {
  __resetSessionStore,
  getPersistedSession,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #2702 — 내 계정은 머리의 아바타에서 열린다 (Buzz 식 프로필 시트).
//
// 성재 피드백(2026-09-25): 「버즈처럼 프로필 위치를 바꿔주고, 누르면 안에서 테마나
// 로그아웃이나 그런걸 할 수 있는 구조… 지금 화면 하단 UI랑 UX가 너무 구려」.
//
// 이 파일이 지는 것은 **구조**다:
//   1. 대화 목록 발치에 계정 줄·테마 칸·로그아웃이 더는 없다
//   2. 머리 오른쪽 아바타가 시트를 연다 — 이름·@핸들·상태가 그 안에 있다
//   3. 테마는 시트 안 한 줄에서 열리는 선택지이고, 고른 것이 저장된다
//   4. 로그아웃은 시트 안의 파괴 행이고, 한 번 확인한 뒤에만 세션을 지운다
//   5. 알림 권한이 꺼져 있으면 그렇게 말하고, 설정으로 가는 문을 준다
//   6. 서버 주소와 앱 버전·빌드가 보인다
//
// 서버 뒤는 `shell.test.tsx` 와 같은 방식으로 fetch 하나만 가짜다.
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
    presenceStatus: 'dnd',
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

let queryClient: QueryClient | null = null;

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AppShell member={SELF} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

const permissions = getPermissionsAsync as jest.Mock;

beforeEach(() => {
  mmkvStore.clear();
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
  permissions.mockImplementation(async () => ({
    granted: true,
    canAskAgain: true,
    status: 'granted',
  }));
  jest.restoreAllMocks();
});

async function openSheet() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('profile-avatar'));
  return screen.getByTestId('profile-sheet');
}

describe('대화 목록 발치가 비었다 (#2702)', () => {
  it('계정 줄·로그아웃·테마 칸이 목록 화면에 없다', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    expect(screen.queryByTestId('sign-out')).toBeNull();
    expect(screen.queryByTestId('theme-control')).toBeNull();
    expect(screen.queryByText('@seongjae')).toBeNull();
    expect(screen.queryByTestId('profile-sheet')).toBeNull();
  });

  it('머리 오른쪽의 아바타가 이름을 가진 버튼이다', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    const avatar = screen.getByTestId('profile-avatar');
    expect(avatar.props.accessibilityRole).toBe('button');
    expect(avatar.props.accessibilityLabel).toContain('곽성재');
    // DS2-3(#2715): 머리는 시안 A 그대로 로고·큰 제목·아바타 셋이다. 메시지 검색의
    // 문은 떠 있는 탭바의 검색 탭이다.
    expect(screen.getByTestId('home-title')).toBeTruthy();
    expect(screen.getByTestId('tab-search')).toBeTruthy();
  });
});

describe('프로필 시트', () => {
  it('아바타를 누르면 열리고, 이름·@핸들·상태가 있다', async () => {
    const sheet = await openSheet();
    expect(within(sheet).getByTestId('self-profile-name')).toHaveTextContent('곽성재');
    expect(within(sheet).getByTestId('self-profile-handle')).toHaveTextContent(
      '@seongjae',
    );
    // 선언된 상태(dnd)는 연결과 무관하게 참이다 — 코어의 낱말로 말한다.
    await waitFor(() =>
      expect(within(sheet).getByTestId('self-profile-presence')).toHaveTextContent(
        '방해 금지',
      ),
    );
  });

  it('닫기로 닫힌다', async () => {
    await openSheet();
    fireEvent.press(screen.getByTestId('profile-close'));
    // 셸의 페이지 시트(#2714)는 닫기에서도 미끄러져 나간 뒤 사라진다.
    await waitFor(() => expect(screen.queryByTestId('profile-sheet')).toBeNull(), {
      timeout: 8000,
    });
  }, 15000);

  it('시트를 끌어내려 닫으면(onRequestClose/onDismiss) 아바타가 다시 연다', async () => {
    // pageSheet 의 끌어내림은 네이티브가 닫고 RN 이 알린다. 알림이 부모의 「열림」을
    // 내리지 못하면 아바타가 죽는다 — 두 경로를 각각 흘려 본다.
    await openSheet();
    for (const signal of ['onRequestClose', 'onDismiss'] as const) {
      const sheet = screen.getByTestId('profile-sheet');
      act(() => {
        sheet.props[signal]();
      });
      expect(screen.queryByTestId('profile-sheet')).toBeNull();
      fireEvent.press(screen.getByTestId('profile-avatar'));
      expect(screen.getByTestId('profile-sheet')).toBeTruthy();
    }
  });

  it('테마 줄이 선택지를 열고, 고른 것이 저장되며 줄의 값이 바뀐다', async () => {
    await openSheet();
    expect(screen.getByTestId('profile-theme-row')).toHaveTextContent(/시스템/);
    // 선택지는 줄을 누르기 전에는 없다.
    expect(screen.queryByTestId('theme-control')).toBeNull();

    fireEvent.press(screen.getByTestId('profile-theme-row'));
    expect(screen.getByTestId('theme-control')).toBeTruthy();
    fireEvent.press(screen.getByTestId('theme-dark'));

    expect(mmkvStore.get(NON_SECRET_KEYS.themeChoice)).toBe('dark');
    expect(screen.getByTestId('theme-dark').props.accessibilityState?.selected).toBe(
      true,
    );

    fireEvent.press(screen.getByTestId('profile-back'));
    expect(screen.getByTestId('profile-theme-row')).toHaveTextContent(/다크/);
  });

  it('로그아웃은 시트 안에서, 확인한 뒤에만 세션을 지운다', async () => {
    await openSheet();
    expect(getPersistedSession()).not.toBeNull();

    fireEvent.press(screen.getByTestId('sign-out'));
    expect(screen.getByTestId('sign-out-confirm')).toBeTruthy();
    fireEvent.press(screen.getByTestId('sign-out-cancel'));
    expect(getPersistedSession()).not.toBeNull();

    fireEvent.press(screen.getByTestId('sign-out'));
    fireEvent.press(screen.getByTestId('sign-out-confirm'));
    expect(getPersistedSession()).toBeNull();
  });

  it('확인의 「취소」는 3:1 위 컨트롤 테두리를, 「로그아웃」은 파괴 채움을 입는다', async () => {
    // U2·#1155 에서 발치의 로그아웃 버튼이 지던 규칙을 시트로 옮긴다: 채움도 강조도
    // 없는 버튼은 테두리 하나가 「여기가 버튼이다」의 전부이므로 hairline `border`
    // (바탕 위 3:1 아래) 가 아니라 `textFaint`(웹 `--line-strong`)를 쓴다.
    await openSheet();
    fireEvent.press(screen.getByTestId('sign-out'));
    const style = (id: string) =>
      StyleSheet.flatten(screen.getByTestId(id).props.style) ?? {};
    expect([darkPalette.textFaint, lightPalette.textFaint]).toContain(
      style('sign-out-cancel').borderColor,
    );
    expect([darkPalette.border, lightPalette.border]).not.toContain(
      style('sign-out-cancel').borderColor,
    );
    expect([darkPalette.dangerFill, lightPalette.dangerFill]).toContain(
      style('sign-out-confirm').backgroundColor,
    );
  });

  it('알림이 허용돼 있으면 그렇게 말하고 설정 문은 없다', async () => {
    await openSheet();
    await waitFor(() =>
      expect(screen.getByTestId('profile-push-row')).toHaveTextContent(/켜져 있습니다/),
    );
    expect(screen.queryByTestId('profile-push-settings')).toBeNull();
  });

  it('알림이 거부돼 있으면 그렇게 말하고, 설정을 여는 문을 준다', async () => {
    permissions.mockImplementation(async () => ({
      granted: false,
      canAskAgain: false,
      status: 'denied',
    }));
    const openSettings = jest
      .spyOn(Linking, 'openSettings')
      .mockResolvedValue(undefined);

    await openSheet();
    await waitFor(() =>
      expect(screen.getByTestId('profile-push-row')).toHaveTextContent(/꺼져 있습니다/),
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('profile-push-settings'));
    });
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('연결한 서버 주소와 앱 버전·빌드가 보인다', async () => {
    await openSheet();
    expect(screen.getByTestId('profile-server-row')).toHaveTextContent(
      /api\.example\.com/,
    );
    // `jest.setup.js` 의 expo-application 목이 답하는 값.
    expect(screen.getByTestId('profile-version')).toHaveTextContent('oort 9.8.7 (65)');
  });

  it('버전 줄을 길게 누르면 실시간 연결 기록이 복사된다 — 식별 정보 없이 (#2751)', async () => {
    const clipboard = jest.requireMock('expo-clipboard') as {
      __box: {value: string | null};
    };
    clipboard.__box.value = null;
    await openSheet();
    await act(async () => {
      fireEvent(screen.getByTestId('profile-version'), 'longPress');
    });
    const copied = clipboard.__box.value ?? '';
    expect(copied.split('\n')[0]).toBe('oort 9.8.7 (65)');
    // 셸이 이미 소켓을 열었다: 그 기록이 실려 있다.
    expect(copied).toMatch(/ connected/);
    expect(copied).not.toMatch(/api\.example\.com|wss?:\/\//);
    expect(screen.getByTestId('profile-version')).toHaveTextContent(
      '연결 기록을 복사했습니다',
    );
  });
});

describe('버전 줄', () => {
  it('둘 다 있으면 「oort 버전 (빌드)」', () => {
    expect(appVersionLabel('0.16.0', '41')).toBe('oort 0.16.0 (41)');
  });

  it('빌드를 모르면 버전만, 버전도 모르면 모른다고 말한다', () => {
    expect(appVersionLabel('0.16.0', null)).toBe('oort 0.16.0');
    expect(appVersionLabel(null, null)).toBe('oort · 버전 정보를 읽지 못했습니다');
  });
});

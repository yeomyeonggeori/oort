import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Member, RosterMember} from '@momo/core/lib/api';
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
import {requireOptionalNativeModule} from 'expo-modules-core';
import {getPermissionsAsync} from 'expo-notifications';
import fs from 'fs';
import path from 'path';
import React from 'react';
import {Animated, Dimensions, Image, Linking, StyleSheet, View} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  __resetBackgroundStoreForTests,
  __setDiskPort,
  getBackground,
  setBackground,
} from '../src/design/background/store';
import {CONV_ICONS, SHEET_ICONS} from '../src/design/icons';
import {LAYER_POP_MS, LAYER_PUSH_MS, LAYER_RISE_MS, LAYER_SINK_MS} from '../src/design/motion';
import {dividerIndent} from '../src/design/sheetModel';
import {ChoiceRow, ConfirmStep} from '../src/design/sheetParts';
import {ThemeProvider} from '../src/design/theme';
import {installAppClock} from './fixtures/fakeClock';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {GroupSection, STACK_PILL_SCALE} from '../src/design/atoms';
import {darkPalette, lightPalette, radius} from '../src/design/tokens';
import {appVersionLabel} from '../src/features/profile/appVersion';
import {devToolsCountLabel} from '../src/features/profile/DevToolsPage';
import {PROFILE_FACE} from '../src/features/profile/ProfileFace';
import {
  SettingsPage,
  type SettingsPageName,
  type SettingsSubPage,
} from '../src/features/profile/SettingsPage';
import {
  PUSH_PREVIEW_DETAIL,
  PUSH_PREVIEW_LABEL,
  PUSH_SHOW_SENDER_DETAIL,
  PUSH_SHOW_SENDER_LABEL,
} from '../src/push/presentation';
import AppShell from '../src/shell/AppShell';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {
  __resetSessionStore,
  getPersistedSession,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #2702 · #4457 — 내 계정은 머리의 아바타에서 열린다 (Buzz 식 설정 페이지).
//
// 성재 피드백(2026-09-25): 「버즈처럼 프로필 위치를 바꿔주고, 누르면 안에서 테마나
// 로그아웃이나 그런걸 할 수 있는 구조… 지금 화면 하단 UI랑 UX가 너무 구려」.
// 2026-10-25: 「버즈 기준으로 홈의 우측 위 프로필을 누르면 저런식으로 보여… 닫기 텍스트 대신에
// x버튼」 — 시트였던 프로필이 **전체 화면 설정 페이지**(셸의 층)가 되었다.
//
// 이 파일이 지는 것은 **구조**다:
//   1. 대화 목록 발치에 계정 줄·테마 칸·로그아웃이 더는 없다
//   2. 머리 오른쪽 아바타가 설정 페이지를 연다 — 머리는 가운데 「설정」 + 오른쪽 원형 X(#4691), 이름·@핸들·상태가 그 안에 있다
//   3. 원형 X 가 페이지를 닫고, 안쪽 장(테마 등)의 머리는 왼쪽 ‹ 뒤로이며 한 겹만 벗긴다(X 가 아니다)
//   4. 테마는 「테마 ›」 행이 여는 안쪽 장이고, 고른 것이 저장된다
//   5. 로그아웃은 마지막 카드의 위험 행이고, 한 번 확인한 뒤에만 세션을 지운다
//   6. 알림 권한이 꺼져 있으면 그렇게 말하고, 스위치를 누르면 설정이 열린다 (#3924)
//   7. 서버 주소와 앱 버전·빌드가 보인다
//   8. **기능 손실 0** — 옛 프로필 시트가 하던 일(전수 표)이 모두 이 페이지에 있다
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
  displayName: '이도현',
  handle: 'dohyun',
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
    displayName: '이도현',
    handle: 'dohyun',
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

/**
 * 「명령줄·AI 도구」(#4663): 정책과 내 연결 목록. 기본은 **만들 수 없고 연결도 없는 멤버**라 행이 서지 않는다(기존 시험의 단정이
 * 그대로다). 행이 서는 조건은 아래 「연결 카드의 명령줄·AI 도구 행」이 표본을 바꿔 세운다.
 */
type DevAccessReply = {status: number; body: unknown} | 'hang';
const DEV_CARD = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  memberId: SELF_ID,
  kind: 'card',
  name: 'Claude Code 노트북',
  tool: 'claude_code',
  scopes: ['dev:identity', 'dev:channels:read', 'dev:messages:read', 'dev:inbox:read'],
  channelRestricted: false,
  createdAtMs: Date.now() - 86_400_000,
  expiresAtMs: Date.now() + 20 * 86_400_000,
};
const DEV_CARD_2 = {...DEV_CARD, id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Codex 작업용'};
let devAccess: {policy: DevAccessReply; list: DevAccessReply; revoked: string[]};
/** 끝나지 않는 답. 코어의 15초 기한 타이머가 시험 뒤에 남지 않도록 시험이 끝날 때 실패로 풀어 준다. */
const devAccessHeld: ((error: Error) => void)[] = [];
const DEV_ROOT = `/v1/workspaces/${WS}/dev-access`;

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes(DEV_ROOT)) {
      const pathname = new URL(url).pathname;
      const pick = (reply: DevAccessReply) =>
        reply === 'hang'
          ? new Promise<Response>((_resolve, reject) => {
              devAccessHeld.push(reject);
            })
          : jsonResponse(reply.status, reply.body);
      if (init?.method === 'DELETE') {
        const id = pathname.split('/').pop() as string;
        devAccess.revoked.push(id);
        return jsonResponse(200, {id, kind: 'card', revokedNow: true});
      }
      return pick(pathname.endsWith('/credentials') ? devAccess.list : devAccess.policy);
    }
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

/** 이 시험들은 움직임이 주제가 아니다 — 층이 누르는 즉시 걷히도록 동작 줄이기를 켠 채 돈다(`layerMotion4457.test.tsx` 가 움직임을 잰다). */
let releaseMotion: (() => void) | null = null;

beforeEach(async () => {
  releaseMotion = await pinReduceMotion(true);
  mmkvStore.clear();
  __resetBackgroundStoreForTests();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  devAccess = {
    policy: {status: 200, body: {policy: 'admins', canCreate: false, canManageAll: false}},
    list: {status: 200, body: {credentials: []}},
    revoked: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  releaseMotion?.();
  releaseMotion = null;
  queryClient?.clear();
  queryClient = null;
  devAccessHeld.splice(0).forEach(release => release(new TypeError('Network request failed')));
  permissions.mockImplementation(async () => ({
    granted: true,
    canAskAgain: true,
    status: 'granted',
  }));
  jest.restoreAllMocks();
});

async function openPage() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('profile-avatar'));
  return screen.getByTestId('settings-page');
}

describe('대화 목록 발치가 비었다 (#2702)', () => {
  it('계정 줄·로그아웃·테마 칸이 목록 화면에 없다', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    expect(screen.queryByTestId('sign-out')).toBeNull();
    expect(screen.queryByTestId('theme-control')).toBeNull();
    expect(screen.queryByText('@dohyun')).toBeNull();
    expect(screen.queryByTestId('settings-page')).toBeNull();
  });

  it('머리 오른쪽의 아바타가 이름을 가진 버튼이다', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    const avatar = screen.getByTestId('profile-avatar');
    expect(avatar.props.accessibilityRole).toBe('button');
    expect(avatar.props.accessibilityLabel).toContain('이도현');
    // DS2-3(#2715): 머리는 시안 A 그대로 로고·큰 제목·아바타 셋이다. 메시지 검색의
    // 문은 떠 있는 탭바의 검색 탭이다.
    expect(screen.getByTestId('home-title')).toBeTruthy();
    expect(screen.getByTestId('tab-search')).toBeTruthy();
  });
});

describe('설정 페이지', () => {
  it('아바타를 누르면 열리고, 이름·@핸들·상태가 있다', async () => {
    const page = await openPage();
    expect(within(page).getByTestId('self-profile-name')).toHaveTextContent('이도현');
    expect(within(page).getByTestId('self-profile-handle')).toHaveTextContent(
      '@dohyun',
    );
    // 선언된 상태(dnd)는 연결과 무관하게 참이다 — 코어의 낱말로 말한다.
    await waitFor(() =>
      expect(within(page).getByTestId('self-profile-presence')).toHaveTextContent(
        '방해 금지',
      ),
    );
  });

  it('머리의 원형 X 가 페이지를 닫고 홈이 그대로 드러나며, 아바타가 다시 연다', async () => {
    await openPage();
    expect(screen.getByTestId('settings-pane')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-close'));
    // 설정은 셸의 층이라 슬라이드 없이 걷힌다(시트가 아니다).
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(screen.queryByTestId('settings-pane')).toBeNull();
    expect(screen.getByTestId('sidebar-list')).toBeTruthy();
    // 두 번 더 — 닫힘 뒤 부모의 「열림」이 남아 아바타가 죽는 일이 없다.
    for (let i = 0; i < 2; i += 1) {
      fireEvent.press(screen.getByTestId('profile-avatar'));
      expect(screen.getByTestId('settings-page')).toBeTruthy();
      fireEvent.press(screen.getByTestId('settings-close'));
      expect(screen.queryByTestId('settings-page')).toBeNull();
    }
  });

  it('닫기는 글자가 아니라 머리 오른쪽의 원형 X 다 — 가운데는 「설정」이다', async () => {
    const page = await openPage();
    const close = within(page).getByTestId('settings-close');
    expect(close.props.accessibilityRole).toBe('button');
    expect(close.props.accessibilityLabel).toBe('설정 닫기');
    expect(within(page).queryByText('닫기')).toBeNull();
    expect(within(page).getByTestId('settings-title')).toHaveTextContent('설정');
    // 트리 순서가 곧 가운데·오른쪽이다: X 가 제목보다 뒤다(#4691 — 시트의 X 와 같은 자리).
    const order = flatten(screen.toJSON());
    const closeAt = order.indexOf('settings-close');
    const titleAt = order.indexOf('settings-title');
    expect(titleAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(titleAt);
  });

  it('설정이 VoiceOver 의 모달 경계다 — 밑의 홈 목록은 읽히지 않는다', async () => {
    await openPage();
    expect(screen.getByTestId('settings-pane').props.accessibilityViewIsModal).toBe(true);
  });

  it('설정이 열리면 탭바도 보조기술에서 가려진다 — 닫으면 다시 읽힌다', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    // 탭 줄(`accessibilityRole="tablist"`)은 접근성 요소가 아니라 역할 질의에 안 잡힌다 — 캡슐에서 올라가 찾는다.
    const tabs = () => {
      let node = screen.getByTestId('tab-capsule', {includeHiddenElements: true}).parent;
      while (node && node.props?.accessibilityRole !== 'tablist') node = node.parent;
      if (!node) throw new Error('tablist not found');
      return node;
    };
    expect(tabs().props.accessibilityElementsHidden).not.toBe(true);
    fireEvent.press(screen.getByTestId('profile-avatar'));
    expect(tabs().props.accessibilityElementsHidden).toBe(true);
    fireEvent.press(screen.getByTestId('settings-close'));
    expect(tabs().props.accessibilityElementsHidden).not.toBe(true);
  });

  it('얼굴 영역의 순서: 큰 아바타 → 이름 → 상태 알약', async () => {
    const page = await openPage();
    await waitFor(() => expect(within(page).getByTestId('self-profile-presence')).toBeTruthy());
    const order = flatten(screen.toJSON());
    const at = (id: string) => order.indexOf(id);
    expect(at('self-profile-avatar')).toBeGreaterThan(at('settings-title'));
    expect(at('self-profile-name')).toBeGreaterThan(at('self-profile-avatar'));
    expect(at('self-profile-presence')).toBeGreaterThan(at('self-profile-name'));
    // 묶음 카드는 얼굴 영역 다음이다.
    expect(at('settings-status-card')).toBeGreaterThan(at('self-profile-presence'));
  });

  it('묶음 순서: 상태 설정 → 내 상태 → 프로필 → 알림 → 기억 → 보기 → 연결 → 계정 (Buzz 문법, 우리 항목)', async () => {
    const page = await openPage();
    await waitFor(() => expect(within(page).getByTestId('settings-presence-card')).toBeTruthy());
    const order = flatten(screen.toJSON());
    const cards = [
      'settings-status-card',
      'settings-presence-card',
      'settings-profile-card',
      'settings-notify-card',
      'memory-section',
      'settings-view-card',
      'settings-connect-card',
      'settings-account-card',
    ];
    const positions = cards.map(id => order.indexOf(id));
    expect(positions.every(position => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('로그아웃은 마지막 카드의 빨강 위험 행이다 — 그 뒤에는 버전 줄뿐이다', async () => {
    const page = await openPage();
    const order = flatten(screen.toJSON());
    const signOutAt = order.indexOf('sign-out');
    expect(signOutAt).toBeGreaterThan(-1);
    for (const id of [
      'profile-status-row',
      'presence-option-auto',
      'profile-push-row',
      'profile-pause-row',
      'memory-pause-row',
      'profile-theme-row',
      'profile-server-row',
      'profile-device-key-row',
    ]) {
      expect(order.indexOf(id)).toBeGreaterThan(-1);
      expect(order.indexOf(id)).toBeLessThan(signOutAt);
    }
    expect(order.indexOf('profile-version')).toBeGreaterThan(signOutAt);
    const color = StyleSheet.flatten(within(page).getByText('로그아웃').props.style).color;
    expect([darkPalette.danger, lightPalette.danger]).toContain(color);
  });

  it('VoiceOver 두 손가락 문지르기(escape)로도 닫힌다 — 안쪽 장에서는 한 겹만', async () => {
    await openPage();
    fireEvent.press(screen.getByTestId('profile-theme-row'));
    act(() => {
      screen.getByTestId('settings-sub-page').props.onAccessibilityEscape();
    });
    expect(screen.queryByTestId('settings-sub-pane')).toBeNull();
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    act(() => {
      screen.getByTestId('settings-page').props.onAccessibilityEscape();
    });
    expect(screen.queryByTestId('settings-page')).toBeNull();
  });

  it('안쪽 장의 머리는 ‹ 뒤로다 — X 가 아니고, 첫 장의 X 는 그대로 X 다', async () => {
    const page = await openPage();
    // 첫 장: 글리프가 X 다.
    const glyphsOf = (testID: string) =>
      within(screen.getByTestId(testID)).UNSAFE_getAllByType(Image).map(image => image.props.source);
    expect(glyphsOf('settings-close')).toEqual([SHEET_ICONS.close]);

    fireEvent.press(within(page).getByTestId('profile-theme-row'));
    const back = screen.getByTestId('settings-back');
    expect(back.props.accessibilityRole).toBe('button');
    // 이름은 「닫기」가 아니라 돌아갈 곳이다 — 닫는 것이 아니라 한 걸음 돌아간다.
    expect(back.props.accessibilityLabel).toBe('설정으로 돌아가기');
    expect(glyphsOf('settings-back')).toEqual([CONV_ICONS.left]);
    // 안쪽 머리에는 X 가 없다.
    const header = within(screen.getByTestId('settings-sub-header'));
    expect(header.queryByTestId('settings-close')).toBeNull();
    expect(header.queryByText('닫기')).toBeNull();
    expect(header.queryByLabelText(/닫기/)).toBeNull();
    // 트리 순서가 곧 왼쪽·가운데다: ‹ 가 제목보다 앞이다.
    const order = flatten(screen.toJSON());
    expect(order.indexOf('settings-sub-title')).toBeGreaterThan(order.indexOf('settings-back'));
    expect(order.indexOf('settings-back')).toBeGreaterThan(-1);
  });

  it('안쪽 장의 ‹ 뒤로는 한 겹만 벗긴다 — 설정 페이지는 남는다', async () => {
    await openPage();
    expect(screen.queryByTestId('settings-sub-pane')).toBeNull();
    fireEvent.press(screen.getByTestId('profile-theme-row'));
    expect(screen.getByTestId('settings-sub-pane')).toBeTruthy();
    expect(screen.getByTestId('settings-sub-title')).toHaveTextContent('테마');
    // 설정 페이지는 밑에 마운트된 채다(읽던 값·스크롤이 그대로) — 한 겹 위에 쌓였을 뿐 갈아 끼우지 않았다.
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    expect(screen.getByTestId('self-profile-name', {includeHiddenElements: true})).toBeTruthy();
    expect(screen.getByTestId('settings-scroll', {includeHiddenElements: true})).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-back'));
    expect(screen.queryByTestId('settings-sub-pane')).toBeNull();
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    expect(screen.getByTestId('settings-close')).toBeTruthy();
  });

  it('테마 행이 안쪽 장을 열고, 고른 것이 저장되며 행의 값이 바뀐다', async () => {
    await openPage();
    expect(screen.getByTestId('profile-theme-row')).toHaveTextContent(/새벽하늘 · 라이트/);
    // 선택지는 행을 누르기 전에는 없다.
    expect(screen.queryByTestId('theme-control')).toBeNull();

    fireEvent.press(screen.getByTestId('profile-theme-row'));
    expect(screen.getByTestId('theme-control')).toBeTruthy();
    fireEvent.press(screen.getByTestId('theme-dark'));

    expect(JSON.parse(mmkvStore.get(NON_SECRET_KEYS.appearance) ?? '{}').scheme).toBe('dark');
    expect(screen.getByTestId('theme-dark').props.accessibilityState?.selected).toBe(
      true,
    );

    fireEvent.press(screen.getByTestId('settings-back'));
    expect(screen.getByTestId('profile-theme-row')).toHaveTextContent(/다크/);
  });

  it('열려 있던 로그아웃 확인은 안쪽 장·상태 시트를 다녀오면 접혀 있다 — 눌러 달라는 듯 서 있지 않는다', async () => {
    const page = await openPage();
    // 안쪽 장: 확인을 열고 → 테마 장 → ‹ 로 돌아오면 접혀 있다(옛 시트는 장을 갈아 끼워 저절로 닫혔다).
    fireEvent.press(within(page).getByTestId('sign-out'));
    expect(screen.getByTestId('sign-out-confirm-block')).toBeTruthy();
    fireEvent.press(within(page).getByTestId('profile-theme-row'));
    fireEvent.press(screen.getByTestId('settings-back'));
    expect(screen.queryByTestId('sign-out-confirm-block')).toBeNull();
    expect(screen.getByTestId('sign-out')).toBeTruthy();
    // 상태 시트도 같다.
    fireEvent.press(within(page).getByTestId('sign-out'));
    expect(screen.getByTestId('sign-out-confirm-block')).toBeTruthy();
    fireEvent.press(within(page).getByTestId('profile-status-row'));
    expect(screen.queryByTestId('sign-out-confirm-block')).toBeNull();
    // 세션은 한 번도 지워지지 않았다 — 접힘은 확인이 아니다.
    expect(getPersistedSession()).not.toBeNull();
  });

  it('로그아웃은 페이지의 마지막 위험 행이고, 확인한 뒤에만 세션을 지운다', async () => {
    await openPage();
    expect(getPersistedSession()).not.toBeNull();

    fireEvent.press(screen.getByTestId('sign-out'));
    expect(screen.getByTestId('sign-out-confirm')).toBeTruthy();
    fireEvent.press(screen.getByTestId('sign-out-cancel'));
    expect(getPersistedSession()).not.toBeNull();

    fireEvent.press(screen.getByTestId('sign-out'));
    fireEvent.press(screen.getByTestId('sign-out-confirm'));
    expect(getPersistedSession()).toBeNull();
  });

  it('로그아웃은 내 사진 배경 파일을 지우고 선택을 없음으로 되돌린다 (ADR-0189 증보 2)', async () => {
    let cleared = 0;
    __setDiskPort({
      uri: name => `file:///document/oort-background/${name}`,
      exists: () => true,
      remove: () => {},
      clearAll: () => {
        cleared += 1;
      },
    });
    setBackground({kind: 'photo', file: 'bg-1760600000000.jpg', width: 1600, height: 1200});
    expect(mmkvStore.get(NON_SECRET_KEYS.background)).toContain('bg-1760600000000.jpg');

    await openPage();
    fireEvent.press(screen.getByTestId('sign-out'));
    fireEvent.press(screen.getByTestId('sign-out-confirm'));

    expect(cleared).toBeGreaterThan(0);
    expect(getBackground()).toEqual({kind: 'none'});
    expect(mmkvStore.has(NON_SECRET_KEYS.background)).toBe(false);
  });

  it('로그아웃해도 단색·기본 제공 선택은 남는다 — 취향이지 사람 데이터가 아니다', async () => {
    __setDiskPort({
      uri: name => name,
      exists: () => true,
      remove: () => {},
      clearAll: () => {},
    });
    setBackground({kind: 'solid', id: 'sage'});
    await openPage();
    fireEvent.press(screen.getByTestId('sign-out'));
    fireEvent.press(screen.getByTestId('sign-out-confirm'));
    expect(getBackground()).toEqual({kind: 'solid', id: 'sage'});
  });

  it('확인의 「취소」는 3:1 위 컨트롤 테두리를, 「로그아웃」은 파괴 채움을 입는다', async () => {
    // U2·#1155 에서 발치의 로그아웃 버튼이 지던 규칙을 시트로 옮긴다: 채움도 강조도
    // 없는 버튼은 테두리 하나가 「여기가 버튼이다」의 전부이므로 hairline `border`
    // (바탕 위 3:1 아래) 가 아니라 `textFaint`(웹 `--line-strong`)를 쓴다.
    await openPage();
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

  it('알림이 허용돼 있으면 스위치가 켜져 있고 이 폰으로 받는다고 말한다 (#3924)', async () => {
    await openPage();
    await waitFor(() =>
      expect(screen.getByTestId('profile-push-row')).toHaveTextContent(
        /이 폰으로 알림을 받아요/,
      ),
    );
    const row = screen.getByTestId('profile-push-row');
    expect(row.props.accessibilityRole).toBe('switch');
    expect(row.props.accessibilityState).toMatchObject({checked: true});
    // 예전의 두 줄(알림 켜기 · 설정에서 알림 켜기)은 스위치가 대신한다.
    expect(screen.queryByTestId('profile-push-ask')).toBeNull();
    expect(screen.queryByTestId('profile-push-settings')).toBeNull();
  });

  it('알림이 거부돼 있으면 스위치는 꺼져 있고, 누르면 설정을 연다 (#3924)', async () => {
    permissions.mockImplementation(async () => ({
      granted: false,
      canAskAgain: false,
      status: 'denied',
    }));
    const openSettings = jest
      .spyOn(Linking, 'openSettings')
      .mockResolvedValue(undefined);

    await openPage();
    await waitFor(() =>
      expect(screen.getByTestId('profile-push-row')).toHaveTextContent(
        /iOS 설정에서 알림이 꺼져 있어요/,
      ),
    );
    expect(screen.getByTestId('profile-push-row').props.accessibilityState).toMatchObject({
      checked: false,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('profile-push-row'));
    });
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('연결한 서버 주소와 앱 버전·빌드가 보인다', async () => {
    await openPage();
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
    await openPage();
    await act(async () => {
      fireEvent(screen.getByTestId('profile-version'), 'longPress');
    });
    const copied = clipboard.__box.value ?? '';
    expect(copied.split('\n')[0]).toBe('oort 9.8.7 (65)');
    // 셸이 이미 소켓을 열었다: 그 기록이 실려 있다.
    expect(copied).toMatch(/ connected/);
    expect(copied).not.toMatch(/api\.example\.com|wss?:\/\//);
    expect(screen.getByTestId('profile-version')).toHaveTextContent(
      '연결 기록 복사됨',
    );
  });
});

describe('머리의 자리 — 닫기 X 는 오른쪽 위, 안쪽 장의 ‹ 는 왼쪽 위: 설정 페이지 전수 (#4691)', () => {
  // 안쪽 장이 하나 늘면 이 표가 타입 오류를 낸다 — 새 장의 머리도 같은 약속을 지켜야 한다.
  const SUB_PAGES: Record<SettingsSubPage, true> = {
    theme: true,
    deviceKey: true,
    devTools: true,
    avatar: true,
    pauseUntil: true,
    dndUntil: true,
  };

  function mountPage(initialPage: SettingsPageName) {
    queryClient = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
    });
    return render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <SettingsPage
            workspaceId={WS}
            member={SELF}
            directory={makeDirectory(ROSTER as unknown as RosterMember[])}
            connected
            onSignOut={() => {}}
            onClose={() => {}}
            initialPage={initialPage}
          />
        </QueryClientProvider>
      </ThemeProvider>,
    );
  }

  /** 머리의 세 칸([왼쪽, 제목, 오른쪽])에 서 있는 단추의 이름. 칸이 셋이 아니면 제목이 가운데에 서지 않는다. */
  function buttonsBySlot(headerTestID: string): string[][] {
    const slots = (screen.getByTestId(headerTestID).children as unknown[]).filter(
      child => typeof child !== 'string',
    );
    expect(slots).toHaveLength(3);
    return slots.map(slot =>
      within(slot as never)
        .queryAllByRole('button')
        .map(button => button.props.accessibilityLabel as string),
    );
  }

  it('첫 장(모달 페이지): 왼쪽은 비고, 「설정」 제목, 오른쪽에 「설정 닫기」 X 하나다', () => {
    mountPage('main');
    expect(buttonsBySlot('settings-header')).toEqual([[], [], ['설정 닫기']]);
  });

  it.each(Object.keys(SUB_PAGES) as SettingsSubPage[])(
    '안쪽 장 %s: 왼쪽에 ‹ 뒤로 하나, 오른쪽은 비고 X 는 없다',
    page => {
      mountPage(page);
      expect(buttonsBySlot('settings-sub-header')).toEqual([['설정으로 돌아가기'], [], []]);
      expect(within(screen.getByTestId('settings-sub-header')).queryByLabelText(/닫기/)).toBeNull();
    },
  );
});

describe('안쪽 장은 모두 새 카드 가족이다 — 옛 반경 8 카드가 어디에도 없다 (#4457)', () => {
  // 옛 `GroupSection` 카드의 지문: 반경 `radius.md`(8) + 가는 테두리 + `surface` 채움. 새 `GroupCard` 는 반경 20 이다.
  // 한 장이라도 옛 부품으로 남으면 설정 본 페이지(반경 20)와 카드 모양이 섞인다.
  const surface = lightPalette.surface;
  const oldCards = () =>
    screen.UNSAFE_getAllByType(View).filter(view => {
      const style = StyleSheet.flatten(view.props.style);
      return (
        style?.borderRadius === radius.md &&
        style?.borderWidth === StyleSheet.hairlineWidth &&
        style?.backgroundColor === surface
      );
    }).length;

  it('탐지기는 실제로 옛 카드를 잡는다 — 대조군(옛 GroupSection 하나 = 1)', () => {
    render(
      <ThemeProvider>
        <GroupSection>
          <Image source={0} />
        </GroupSection>
      </ThemeProvider>,
    );
    expect(oldCards()).toBe(1);
  });

  // 알림 일시 중지 기한 장은 규칙 응답이 있어야 행이 풀리는데 이 파일의 서버는 그것을 싣지 않는다 — 그 장의 같은 약속은
  // 규칙을 시드하는 `profilePauseUntil.test.tsx` 가 진다.
  it.each([
    ['테마', 'profile-theme-row', 'theme-scheme-card'],
    ['지시 기기', 'profile-device-key-row', 'device-key-card-card'],
    ['방해 금지 기한', 'presence-option-dnd', 'pause-until-card-card'],
  ] as const)('%s 장 — 옛 카드가 없고 새 카드가 선다', async (_name, rowTestID, expectedTestID) => {
    const page = await openPage();
    await waitFor(() =>
      expect(within(page).getByTestId('presence-option-dnd')).toBeTruthy(),
    );
    fireEvent.press(within(page).getByTestId(rowTestID));
    await waitFor(() => expect(screen.getByTestId(expectedTestID)).toBeTruthy());
    expect(oldCards()).toBe(0);
  });

  it('프로필 사진 장 — 옛 카드가 없다', async () => {
    const page = await openPage();
    fireEvent.press(within(page).getByTestId('self-profile-avatar', {includeHiddenElements: true}));
    await waitFor(() => expect(screen.getByTestId('avatar-page')).toBeTruthy());
    expect(oldCards()).toBe(0);
  });
});

describe('design-review r1 반영 — 얼굴·내 상태·확인 블록 (#4457)', () => {
  const lead = /-lead$/;
  /** 질의 결과를 testID 목록으로 — 실패 메시지가 React 트리가 아니라 이름을 찍는다. */
  const ids = (nodes: {props: {testID?: string}}[]) => nodes.map(node => node.props.testID);

  it('탐지기는 실제로 앞 칸을 잡는다 — 대조군(앞 표지가 있는 라디오 행 하나 = 1)', () => {
    render(
      <ThemeProvider>
        <ChoiceRow title="x" selected leading={<View />} onPress={() => {}} testID="probe" />
      </ThemeProvider>,
    );
    // 인스턴스가 아니라 testID 로 비교한다 — 실패했을 때 React 트리 전체를 찍다가 메모리가 터진다(사보타주 Q48 이 그렇게 죽었다).
    expect(ids(screen.queryAllByTestId(lead, {includeHiddenElements: true}))).toEqual(['probe-lead']);
  });

  it('H1: 설정 페이지는 앞 칸 없는 문법이다 — 내 상태에 상태 점이 없고, 모든 카드의 구분선이 한 열에서 시작한다', async () => {
    const page = await openPage();
    // 명부의 내 상태는 방해 금지라 「기한 바꾸기」 줄까지 선다 — 내 상태 카드의 모든 줄이 이 시험에 든다.
    await waitFor(() => expect(within(page).getByTestId('profile-dnd-until-row')).toBeTruthy());
    expect(ids(within(page).queryAllByTestId(lead, {includeHiddenElements: true}))).toEqual([]);
    const indents = within(page)
      .getAllByTestId('group-divider')
      .map(divider => StyleSheet.flatten(divider.props.style).marginLeft);
    expect(indents.length).toBeGreaterThan(5);
    expect(new Set(indents)).toEqual(new Set([dividerIndent('plain')]));
  });

  it('M3·N1: 설정 머리의 얼굴과 프로필 사진 장의 얼굴은 같은 크기·같은 3:1 링이다', async () => {
    const page = await openPage();
    const ringOf = (testID: string) => {
      const {borderRadius, borderWidth, borderColor} = StyleSheet.flatten(
        screen.getByTestId(testID, {includeHiddenElements: true}).props.style,
      );
      return {borderRadius, borderWidth, borderColor};
    };
    // 링 안에 한 변이 PROFILE_FACE 인 얼굴이 서 있는가.
    const faces = (testID: string) =>
      within(screen.getByTestId(testID, {includeHiddenElements: true}))
        .UNSAFE_getAllByType(View)
        .filter(view => {
          const style = StyleSheet.flatten(view.props.style);
          return style?.width === PROFILE_FACE && style?.height === PROFILE_FACE;
        }).length;

    const hero = ringOf('self-profile-avatar');
    expect(hero).toMatchObject({borderRadius: radius.pill, borderWidth: 1});
    expect([darkPalette.textFaint, lightPalette.textFaint]).toContain(hero.borderColor);
    expect(faces('self-profile-avatar')).toBeGreaterThan(0);

    fireEvent.press(within(page).getByTestId('self-profile-avatar', {includeHiddenElements: true}));
    await waitFor(() => expect(screen.getByTestId('avatar-page-face')).toBeTruthy());
    expect(ringOf('avatar-page-face')).toEqual(hero); // 맨몸이면 다크에서 바탕과 1.04:1 로 사라진다
    expect(faces('avatar-page-face')).toBeGreaterThan(0);
  });

  it('M2: 로그아웃 확인은 공용 ConfirmStep 과 같은 문법이다 — 다른 것은 위험 단추의 채움과 취소의 3:1 윤곽 둘뿐이다', async () => {
    const pick = (style: Record<string, unknown>, keys: string[]) =>
      Object.fromEntries(keys.map(key => [key, style[key]]));
    const boxOf = (testID: string) =>
      pick(StyleSheet.flatten(screen.getByTestId(testID).props.style) ?? {}, [
        'borderRadius',
        'borderWidth',
        'minHeight',
      ]);
    const textOf = (text: string, keys: string[]) =>
      pick(StyleSheet.flatten(screen.getByText(text).props.style) ?? {}, keys);
    const grammar = (testIDs: {cancel: string; confirm: string}, text: {confirm: string; headline: string; detail: string}) => ({
      cancel: boxOf(testIDs.cancel),
      confirm: boxOf(testIDs.confirm),
      cancelLabel: textOf('취소', ['fontSize', 'fontWeight']),
      confirmLabel: textOf(text.confirm, ['fontSize', 'fontWeight']),
      headline: textOf(text.headline, ['fontSize', 'fontWeight']),
      detail: textOf(text.detail, ['fontSize', 'lineHeight']),
    });

    // 기준: 공용 부품을 같은 모양(앱 기본)에서 그려 읽는다.
    const referenceView = render(
      <ThemeProvider>
        <ConfirmStep
          headline="기준 머리말"
          detail="기준 설명이에요."
          confirmLabel="기준 확인"
          pendingLabel="하는 중…"
          onCancel={() => {}}
          onConfirm={() => {}}
          cancelTestID="ref-cancel"
          confirmTestID="ref-confirm"
        />
      </ThemeProvider>,
    );
    const reference = grammar(
      {cancel: 'ref-cancel', confirm: 'ref-confirm'},
      {confirm: '기준 확인', headline: '기준 머리말', detail: '기준 설명이에요.'},
    );
    referenceView.unmount();

    await openPage();
    fireEvent.press(screen.getByTestId('sign-out'));
    const mine = grammar(
      {cancel: 'sign-out-cancel', confirm: 'sign-out-confirm'},
      {
        confirm: '로그아웃',
        headline: '로그아웃할까요?',
        detail: '로그아웃하면 이 기기에 쓰다 만 초안이 지워집니다.',
      },
    );
    expect(mine).toEqual(reference);
    // 대조군: 기준이 실제로 값을 갖는다 — 둘 다 비어 있어 같아 보이는 일이 없다.
    expect(reference.cancel.borderRadius).toBe(radius.md);
    expect(reference.headline.fontWeight).toBe('700');
    expect(reference.detail.lineHeight).toBeGreaterThan(0);
  });

  it.each([
    [1, 'row', 1],
    [STACK_PILL_SCALE - 0.01, 'row', 1],
    [STACK_PILL_SCALE, 'column', 0],
    [3.1, 'column', 0],
  ] as const)(
    'r2 증거 공백: 로그아웃 확인의 두 단추는 글자 배율 %s 에서 %s 로 선다 — 큰 글씨에서는 쌓여 「로그아웃」 이 어절 가운데서 끊기지 않는다',
    async (fontScale, direction, flex) => {
      // AX5 캡처가 「로그아/웃」 을 잡았다 — 반폭 단추 둘이 큰 글씨 한 낱말을 담지 못한다.
      const real = Dimensions.get('window');
      jest.spyOn(Dimensions, 'get').mockImplementation(() => ({...real, fontScale}) as never);
      await openPage();
      fireEvent.press(screen.getByTestId('sign-out'));
      const style = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) ?? {};
      expect(style('sign-out-confirm-actions').flexDirection).toBe(direction);
      // 쌓인 단추는 `flex: 1` 을 버린다(세로 방향 flex 1 은 높이를 0 으로 눌러 버린다) — 나란한 단추는 반반이다.
      expect(style('sign-out-cancel').flex).toBe(flex);
      expect(style('sign-out-confirm').flex).toBe(flex);
      // 쌓인 단추는 위아래 숨이 있다(큰 글씨 한 줄이 가장자리에 닿지 않게) — 나란한 단추는 minHeight 가 숨을 준다.
      const breathing = direction === 'column' ? 8 : undefined;
      expect(style('sign-out-cancel').paddingVertical).toBe(breathing);
      expect(style('sign-out-confirm').paddingVertical).toBe(breathing);
    },
  );

  it('r3 L1: 두 줄까지 허용한 이름도 어절 단위로 줄을 바꾼다(hangul-word)', async () => {
    const page = await openPage();
    const name = within(page).getByTestId('self-profile-name');
    expect(name.props.numberOfLines).toBe(2);
    expect(name.props.lineBreakStrategyIOS).toBe('hangul-word');
  });

  it('r2: 확인의 머리말과 설명은 어절 단위로 줄을 바꾼다(hangul-word)', async () => {
    await openPage();
    fireEvent.press(screen.getByTestId('sign-out'));
    expect(screen.getByText('로그아웃할까요?').props.lineBreakStrategyIOS).toBe('hangul-word');
    expect(
      screen.getByText('로그아웃하면 이 기기에 쓰다 만 초안이 지워집니다.').props.lineBreakStrategyIOS,
    ).toBe('hangul-word');
  });

  it('L2: 안쪽 장의 첫 요소 위 여백은 설정 첫 장과 같다 — 옛 시트의 24 가 남아 안쪽 장만 떨어져 보이지 않는다', async () => {
    const page = await openPage();
    const topOf = (testID: string) =>
      StyleSheet.flatten(screen.getByTestId(testID, {includeHiddenElements: true}).props.contentContainerStyle)
        .paddingTop;
    const main = topOf('settings-scroll');
    expect(main).toBeGreaterThan(0);
    fireEvent.press(within(page).getByTestId('profile-theme-row'));
    expect(topOf('settings-sub-scroll')).toBe(main);
  });

  it('N1: 한 줄 문장의 줄 높이는 토큰이다 — 프로필 화면 네 파일에 lineHeight 18 리터럴이 없다', () => {
    const literal = /lineHeight:\s*18\b/;
    const dir = path.join(__dirname, '../src/features/profile');
    const offenders = ['SettingsPage.tsx', 'AvatarPage.tsx', 'PauseUntilPage.tsx', 'PauseUntilCustom.tsx'].filter(
      file => literal.test(fs.readFileSync(path.join(dir, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
    // 대조군: 탐지기는 실제로 리터럴을 잡는다.
    expect(literal.test('caption: {fontSize: font.label, lineHeight: 18}')).toBe(true);
    expect(literal.test('caption: {fontSize: font.label, lineHeight: line.label}')).toBe(false);
  });
});

describe('층의 움직임 배선 — 셸 안에서 (#4457)', () => {
  // 위의 시험은 모두 동작 줄이기를 켠 채 돈다. 여기서는 끄고, 셸이 층에 건 움직임이 실제로 배선돼 있는지 잰다
  // (`layerMotion4457.test.tsx` 는 층 부품 홀로의 약속이다): 첫 장은 올라오고 X 는 내려가며 걷고, 안쪽 장은 밀려
  // 들어오고 ‹ 는 물러나며 걷는다.
  const WINDOW = Dimensions.get('window');

  // 층을 걷는 것은 애니메이션 완료가 아니라 앱의 타이머다(`useLayerClose`: 내려감 150ms·물러남 180ms 뒤 `onBack`). 예전에는 실시간으로
  // `waitFor(…, {timeout: 8000})` 를 걸어 그 타이머와 셸의 다시 그리기를 기다렸다(#4633). 실측(유휴 머신, 시험 하나): 퇴장 하나가 ~0.75초이고 그중
  // 타이머는 0.15~0.18초뿐이다 — 나머지는 층이 걷힌 뒤 셸이 다시 그려지는 CPU 다. 그래서 느린 CI 에서 5초 제한을 넘긴 것은 기다림이 아니라
  // 「퇴장 두 번 + 셸 다시 그리기 + 두 번째 열기」를 한 시험에 담은 합이다(`VoiceOver escape` 가 가장 길다). 가짜 시계 위에서 `waitFor` 로
  // 폴링하면 한 번에 50ms 가짜 시간 + 한 번의 act 라서 오히려 느려진다(같은 조건 실측 퇴장당 ~1.25초). 폴링 없이 **타이머의 길이만큼 시계를
  // 밀어** 한 번의 act 안에서 걷힘을 끝낸다: 벽시계에도 머신 속도에도 기대지 않고, 「한 틱 모자라면 아직 서 있고 정확히 그 길이에 걷힌다」까지
  // 단정한다.
  beforeEach(() => {
    installAppClock();
  });

  // 순서는 `layerMotion4457.test.tsx` 와 같다: 먼저 내리고(층의 퇴장 타이머는 언마운트가 거둔다), 남은 가짜 타이머를 비운 뒤에 진짜 시계로
  // 돌아간다. 가짜 시계 아래서 만든 타이머를 진짜 시계로 바꾼 뒤에 거두면 아무도 거두지 않는다.
  afterEach(() => {
    cleanup();
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  /** 앱 시계를 `ms` 만큼 밀어 그 사이의 타이머를 한 번의 act 안에서 끝낸다 — 폴링도 벽시계도 없다. */
  const advance = (ms: number) =>
    act(async () => {
      jest.advanceTimersByTime(ms);
    });

  /** 층이 `ms` 에 정확히 걷힌다: 한 틱 모자라면 아직 서 있고, 마지막 한 틱이 걷는다. */
  const standsUntil = async (ms: number, testID: string) => {
    await advance(ms - 1);
    expect(screen.getByTestId(testID)).toBeTruthy();
    await advance(1);
    expect(screen.queryByTestId(testID)).toBeNull();
  };

  it('설정 첫 장은 올라오고, X 는 내려간 뒤에야 페이지를 걷는다', async () => {
    releaseMotion?.();
    releaseMotion = await pinReduceMotion(false);
    const timing = jest.spyOn(Animated, 'timing');
    await openPage();
    expect(timing.mock.calls.map(call => call[1])).toContainEqual(
      expect.objectContaining({toValue: 0, duration: LAYER_RISE_MS}),
    );

    timing.mockClear();
    fireEvent.press(screen.getByTestId('settings-close'));
    expect(timing.mock.calls.map(call => call[1])).toContainEqual(
      expect.objectContaining({toValue: WINDOW.height, duration: LAYER_SINK_MS}),
    );
    // 내려가는 동안에는 아직 서 있다 — 누른 즉시 사라지지 않는다.
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    await standsUntil(LAYER_SINK_MS, 'settings-page');
    expect(screen.getByTestId('sidebar-list')).toBeTruthy();
  });

  it('안쪽 장은 밀려 들어오고, ‹ 는 오른쪽으로 물러난 뒤에야 한 겹만 걷는다', async () => {
    releaseMotion?.();
    releaseMotion = await pinReduceMotion(false);
    const timing = jest.spyOn(Animated, 'timing');
    await openPage();
    timing.mockClear();
    fireEvent.press(screen.getByTestId('profile-theme-row'));
    expect(screen.getByTestId('settings-sub-pane')).toBeTruthy();
    expect(timing.mock.calls.map(call => call[1])).toContainEqual(
      expect.objectContaining({toValue: 0, duration: LAYER_PUSH_MS}),
    );

    timing.mockClear();
    fireEvent.press(screen.getByTestId('settings-back'));
    expect(timing.mock.calls.map(call => call[1])).toContainEqual(
      expect.objectContaining({toValue: WINDOW.width, duration: LAYER_POP_MS}),
    );
    expect(screen.getByTestId('settings-sub-pane')).toBeTruthy();
    await standsUntil(LAYER_POP_MS, 'settings-sub-pane');
    // 설정 페이지는 남는다 — 한 겹만 벗겼다.
    expect(screen.getByTestId('settings-page')).toBeTruthy();
  });

  it('VoiceOver escape 도 같은 길로 나간다 — 첫 장은 내려가고 안쪽 장은 물러난다', async () => {
    releaseMotion?.();
    releaseMotion = await pinReduceMotion(false);
    const timing = jest.spyOn(Animated, 'timing');
    await openPage();
    fireEvent.press(screen.getByTestId('profile-theme-row'));
    timing.mockClear();
    act(() => {
      screen.getByTestId('settings-sub-page').props.onAccessibilityEscape();
    });
    expect(timing.mock.calls.map(call => call[1])).toContainEqual(
      expect.objectContaining({toValue: WINDOW.width, duration: LAYER_POP_MS}),
    );
    await standsUntil(LAYER_POP_MS, 'settings-sub-pane');

    timing.mockClear();
    act(() => {
      screen.getByTestId('settings-page').props.onAccessibilityEscape();
    });
    expect(timing.mock.calls.map(call => call[1])).toContainEqual(
      expect.objectContaining({toValue: WINDOW.height, duration: LAYER_SINK_MS}),
    );
    await standsUntil(LAYER_SINK_MS, 'settings-page');
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

// =============================================================================
// #4316 (ADR-0204 증보 5) — 설정 › 알림의 두 줄: 「메시지 미리보기」「보낸 사람 표시」.
//
// owner(2026-10-24): 「프로필이미지랑 메세지 미리보기도 포함해서 푸시알림 UI쪽 설계도 해줘. 슬랙과 버즈, 카카오톡과
// 같은 메신저들의 UI 레퍼런스를 확인하고 참고해서」. 카카오톡은 「미리보기」와 「프로필 표시」를 따로 켜고 끈다.
// 이 두 줄은 이 폰의 선택이고(서버를 부르지 않는다), 알림 확장은 MMKV 를 읽지 못해서 바꿀 때 네이티브가 App
// Group 으로도 쓴다. 이 블록이 재는 것: 줄의 자리·처음 상태·눌렀을 때 저장과 확장 쪽 쓰기·접근성.
// =============================================================================
describe('알림이 보이는 모양 — 두 줄 (#4316)', () => {
  const requireNative = requireOptionalNativeModule as unknown as jest.Mock;
  let native: {
    setPresentationSettings: jest.Mock;
    clearPresentation: jest.Mock;
    exportChannels: jest.Mock;
    order: string[];
  };

  beforeEach(() => {
    const order: string[] = [];
    native = {
      setPresentationSettings: jest.fn(async (preview: boolean, sender: boolean) => {
        order.push(`settings:${preview}:${sender}`);
        return true;
      }),
      clearPresentation: jest.fn(async () => {
        order.push('clear');
        return true;
      }),
      exportChannels: jest.fn(async () => true),
      order,
    };
    requireNative.mockImplementation((name: string) => (name === 'MomoPushNative' ? native : null));
  });

  afterEach(() => {
    requireNative.mockImplementation(() => null);
  });

  const switchValue = (testID: string) =>
    screen.getByTestId(testID, {includeHiddenElements: true}).props.value as boolean;

  it('알림 카드의 「푸시 알림」 바로 뒤에, 기본으로 켜진 채 선다', async () => {
    const page = await openPage();
    const card = within(page).getByTestId('settings-notify-card');
    const previewRow = within(card).getByTestId('profile-preview-row');
    const senderRow = within(card).getByTestId('profile-show-sender-row');
    expect(within(previewRow).getByText(PUSH_PREVIEW_LABEL)).toBeTruthy();
    expect(within(previewRow).getByText(PUSH_PREVIEW_DETAIL)).toBeTruthy();
    expect(within(senderRow).getByText(PUSH_SHOW_SENDER_LABEL)).toBeTruthy();
    expect(within(senderRow).getByText(PUSH_SHOW_SENDER_DETAIL)).toBeTruthy();
    expect(switchValue('profile-preview-switch')).toBe(true);
    expect(switchValue('profile-show-sender-switch')).toBe(true);
    const order = flatten(screen.toJSON());
    const at = (id: string) => order.indexOf(id);
    expect(at('profile-push-row')).toBeGreaterThan(-1);
    expect(at('profile-preview-row')).toBeGreaterThan(at('profile-push-row'));
    expect(at('profile-show-sender-row')).toBeGreaterThan(at('profile-preview-row'));
    expect(at('profile-pause-row')).toBeGreaterThan(at('profile-show-sender-row'));
  });

  it('두 줄은 스위치 역할이고 이름·켜짐 상태·설명을 보조기술에 말한다', async () => {
    await openPage();
    for (const [id, label, detail] of [
      ['profile-preview-row', PUSH_PREVIEW_LABEL, PUSH_PREVIEW_DETAIL],
      ['profile-show-sender-row', PUSH_SHOW_SENDER_LABEL, PUSH_SHOW_SENDER_DETAIL],
    ] as const) {
      const row = screen.getByTestId(id);
      expect(row.props.accessibilityRole).toBe('switch');
      expect(row.props.accessibilityLabel).toBe(label);
      expect(row.props.accessibilityHint).toBe(detail);
      expect(row.props.accessibilityState).toMatchObject({checked: true});
    }
  });

  it('미리보기 줄을 누르면 꺼지고, 확장이 읽는 자리에 두 값이 함께 쓰이며, 아무것도 지우지 않는다', async () => {
    await openPage();
    fireEvent.press(screen.getByTestId('profile-preview-row'));
    expect(switchValue('profile-preview-switch')).toBe(false);
    expect(screen.getByTestId('profile-preview-row').props.accessibilityState).toMatchObject({checked: false});
    expect(mmkvStore.get(NON_SECRET_KEYS.pushPreview)).toBe('0');
    expect(native.setPresentationSettings).toHaveBeenLastCalledWith(false, true);
    expect(native.clearPresentation).not.toHaveBeenCalled();
    // 다른 줄은 그대로다.
    expect(switchValue('profile-show-sender-switch')).toBe(true);
    fireEvent.press(screen.getByTestId('profile-preview-row'));
    expect(switchValue('profile-preview-switch')).toBe(true);
    expect(mmkvStore.has(NON_SECRET_KEYS.pushPreview)).toBe(false);
    expect(native.setPresentationSettings).toHaveBeenLastCalledWith(true, true);
  });

  it('스위치 자체를 밀어도 같다', async () => {
    await openPage();
    fireEvent(screen.getByTestId('profile-preview-switch', {includeHiddenElements: true}), 'valueChange', false);
    expect(mmkvStore.get(NON_SECRET_KEYS.pushPreview)).toBe('0');
    expect(native.setPresentationSettings).toHaveBeenLastCalledWith(false, true);
  });

  it('보낸 사람 표시를 끄면 설정을 쓴 뒤 건넨 것을 거두고, 미리보기는 건드리지 않는다', async () => {
    await openPage();
    native.order.length = 0;
    fireEvent.press(screen.getByTestId('profile-show-sender-row'));
    expect(switchValue('profile-show-sender-switch')).toBe(false);
    expect(mmkvStore.get(NON_SECRET_KEYS.pushShowSender)).toBe('0');
    expect(native.order).toEqual(['settings:true:false', 'clear']);
    expect(switchValue('profile-preview-switch')).toBe(true);
    // 다시 켜면 켜지고, 이번에는 거두지 않는다.
    fireEvent.press(screen.getByTestId('profile-show-sender-row'));
    expect(switchValue('profile-show-sender-switch')).toBe(true);
    expect(mmkvStore.has(NON_SECRET_KEYS.pushShowSender)).toBe(false);
    expect(native.clearPresentation).toHaveBeenCalledTimes(1);
  });

  it('고른 상태는 설정을 닫았다 다시 열어도, 앱을 다시 띄워도 남는다', async () => {
    await openPage();
    fireEvent.press(screen.getByTestId('profile-preview-row'));
    fireEvent.press(screen.getByTestId('profile-show-sender-row'));
    fireEvent.press(screen.getByTestId('settings-close'));
    fireEvent.press(screen.getByTestId('profile-avatar'));
    expect(switchValue('profile-preview-switch')).toBe(false);
    expect(switchValue('profile-show-sender-switch')).toBe(false);
    // 앱을 다시 띄움: 렌더 트리를 내리고 같은 저장소로 새로 그린다.
    screen.unmount();
    native.setPresentationSettings.mockClear();
    await openPage();
    expect(switchValue('profile-preview-switch')).toBe(false);
    expect(switchValue('profile-show-sender-switch')).toBe(false);
    // 셸이 뜰 때 저장된 두 값이 확장 쪽으로 다시 쓰인다(앱을 지웠다 깐 폰·비워진 그룹이 되찾는다).
    expect(native.setPresentationSettings).toHaveBeenCalledWith(false, false);
  });

  it('서버를 부르지 않는다 — 이 두 줄은 이 폰의 선택이다', async () => {
    await openPage();
    const before = (globalThis.fetch as jest.Mock).mock.calls.length;
    fireEvent.press(screen.getByTestId('profile-preview-row'));
    fireEvent.press(screen.getByTestId('profile-show-sender-row'));
    await act(async () => {});
    const after = (globalThis.fetch as jest.Mock).mock.calls.slice(before).map(call => String(call[0]));
    expect(after.filter(url => /notification|push|device|prefs|presence/i.test(url))).toEqual([]);
  });
});

// =============================================================================
// #4663: 「연결」 카드의 「명령줄·AI 도구 ›」 행은 쓸 수 있는 사람에게만 선다.
//
// 접근하지 못하는 기능을 광고하지 않는다: 내가 만들 수 있거나(소유자·관리자) 이미 만든 연결이 있을 때만이다. 정책 조회가 끝나기
// 전에는 서지 않는다(모르는 것을 약속하지 않는다). 행이 **없다**는 단정은 두 질의가 끝난 뒤에만 뜻이 있다(읽는 중에도 행은
// 없으니), 그래서 끝났는지를 먼저 본다.
// =============================================================================
describe('「연결」 카드의 「명령줄·AI 도구」 행 (#4663)', () => {
  const ROW = 'profile-dev-tools-row';

  /** 두 질의(정책·목록)가 모두 답을 받아 쉬는 때. 이 뒤의 「행이 없다」가 뜻이 있다. */
  const devAccessSettled = () =>
    waitFor(() => {
      const queries = queryClient!
        .getQueryCache()
        .findAll({queryKey: ['settings', 'dev-access']});
      expect(queries).toHaveLength(2);
      expect(queries.every(query => query.state.fetchStatus === 'idle')).toBe(true);
    });

  it('만들 수 없고 연결도 없는 멤버에게는 행이 없다', async () => {
    const page = await openPage();
    await devAccessSettled();
    expect(within(page).queryByTestId(ROW)).toBeNull();
    // 이웃 행은 그대로 서 있다(카드 전체가 사라진 것이 아니다).
    expect(within(page).getByTestId('profile-device-key-row')).toBeTruthy();
  });

  it('만들 수 있는 사람에게는 연결이 없어도 행이 서고, 값(개수)은 없다', async () => {
    devAccess.policy = {
      status: 200,
      body: {policy: 'admins', canCreate: true, canManageAll: true},
    };
    const page = await openPage();
    expect(await within(page).findByTestId(ROW)).toBeTruthy();
    await devAccessSettled();
    expect(within(page).queryByTestId(`${ROW}-value`)).toBeNull();
  });

  it('만들 수 없어도 이미 만든 연결이 있으면 행이 서고, 값이 그 개수다', async () => {
    devAccess.list = {status: 200, body: {credentials: [DEV_CARD, DEV_CARD_2]}};
    const page = await openPage();
    expect(await within(page).findByTestId(ROW)).toBeTruthy();
    await waitFor(() =>
      expect(within(page).getByTestId(`${ROW}-value`)).toHaveTextContent(devToolsCountLabel(2)),
    );
  });

  it('정책을 읽는 동안에는 목록이 이미 와 있어도 서지 않는다', async () => {
    devAccess.policy = 'hang';
    devAccess.list = {status: 200, body: {credentials: [DEV_CARD]}};
    const page = await openPage();
    await waitFor(() =>
      expect(
        queryClient!.getQueryState(['settings', 'dev-access', 'credentials', WS])?.status,
      ).toBe('success'),
    );
    expect(within(page).queryByTestId(ROW)).toBeNull();
  });

  it('서버에 이 길이 없으면(404) 행이 없다: 모르는 것을 만들 수 있다고 읽지 않는다', async () => {
    devAccess.policy = {status: 404, body: {error: {message: 'no route'}}};
    devAccess.list = {status: 404, body: {error: {message: 'no route'}}};
    const page = await openPage();
    await devAccessSettled();
    expect(within(page).queryByTestId(ROW)).toBeNull();
  });

  it('정책을 못 읽어도 내 연결이 있으면 행이 서서 지우러 올 길을 막지 않는다', async () => {
    devAccess.policy = {status: 500, body: {error: {message: 'boom'}}};
    devAccess.list = {status: 200, body: {credentials: [DEV_CARD]}};
    const page = await openPage();
    expect(await within(page).findByTestId(ROW)).toBeTruthy();
  });

  it('행은 연결 카드 안에서 지시 기기 다음에 서고, 누르면 안쪽 장이 열리며 ‹ 가 한 겹만 벗긴다', async () => {
    devAccess.list = {status: 200, body: {credentials: [DEV_CARD]}};
    const page = await openPage();
    await within(page).findByTestId(ROW);
    const order = flatten(screen.toJSON());
    expect(order.indexOf(ROW)).toBeGreaterThan(order.indexOf('profile-device-key-row'));
    expect(order.indexOf(ROW)).toBeLessThan(order.indexOf('sign-out'));

    fireEvent.press(within(page).getByTestId(ROW));
    expect(await screen.findByTestId('dev-tools-page')).toBeTruthy();
    expect(screen.getByTestId('settings-sub-pane')).toBeTruthy();
    // 안쪽 장이 선 동안에도 설정 페이지는 밑에 남는다.
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-back'));
    expect(screen.queryByTestId('settings-sub-pane')).toBeNull();
    expect(screen.getByTestId('settings-page')).toBeTruthy();
  });

  it('장에서 연결을 지우면 돌아온 설정 행의 개수도 줄어든다', async () => {
    devAccess.list = {status: 200, body: {credentials: [DEV_CARD, DEV_CARD_2]}};
    const page = await openPage();
    fireEvent.press(await within(page).findByTestId(ROW));
    const base = `dev-credential-${DEV_CARD.id}`;
    fireEvent.press(await screen.findByTestId(`${base}-revoke`));
    fireEvent.press(await screen.findByTestId('dev-revoke-confirm-button'));
    await waitFor(() => expect(screen.queryByTestId(base)).toBeNull());
    expect(devAccess.revoked).toEqual([DEV_CARD.id]);
    fireEvent.press(screen.getByTestId('settings-back'));
    await waitFor(() =>
      expect(within(page).getByTestId(`${ROW}-value`)).toHaveTextContent(devToolsCountLabel(1)),
    );
  });

  it('마지막 연결을 지우면 만들 수 없는 사람의 행이 사라진다(광고하지 않는다)', async () => {
    devAccess.list = {status: 200, body: {credentials: [DEV_CARD]}};
    const page = await openPage();
    fireEvent.press(await within(page).findByTestId(ROW));
    fireEvent.press(await screen.findByTestId(`dev-credential-${DEV_CARD.id}-revoke`));
    fireEvent.press(await screen.findByTestId('dev-revoke-confirm-button'));
    await waitFor(() => expect(screen.getByTestId('dev-tools-empty')).toBeTruthy());
    fireEvent.press(screen.getByTestId('settings-back'));
    await waitFor(() => expect(within(page).queryByTestId(ROW)).toBeNull());
  });
});

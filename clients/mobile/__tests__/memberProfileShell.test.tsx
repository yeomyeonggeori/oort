import type { Member } from '@momo/core/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import { __resetBackgroundStoreForTests } from '../src/design/background/store';
import { ThemeProvider } from '../src/design/theme';
import AppShell from '../src/shell/AppShell';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {
  __resetServerBaseCache,
  setServerBase,
} from '../src/storage/serverBase';
import { pinReduceMotion } from './fixtures/reduceMotion';

// =============================================================================
// 다른 사람 프로필 시트를 **셸 안에서** 끝까지 (#4319). 시트 하나의 시험(`memberProfile.test.tsx`)이 못 재는 것 — 대화 화면과 셸이 시트에
// 이어 준 길 — 을 서버 경계(`fetch` 하나만 가짜) 위에서 잰다.
//
//   1. 내 얼굴 → 프로필 시트 → 「설정 열기」 → **설정 페이지가 서고 대화는 걷힌다**. 설정 층은 대화 층 밑에 그려지므로 대화를 걷지 않으면
//      설정이 열려도 보이지 않는다(`settingsOnTop` 은 대화가 없어야 한다).
//   2. 사진이 있는 얼굴 → 시트가 내려간 뒤 크게 보기가 서고, 닫으면 대화로 돌아온다.
//   3. 상태 칩은 DM 머리와 같은 판정이다 — 사람의 방해 금지, 에이전트의 서버 생존 읽기.
//
// 인물은 모두 가상이다(이도현·박서연, 에이전트 달무리 도우미).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const SEOYEON = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const HELPER = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'ch-general';
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;
/** 1×1 PNG — 서버가 주는 `data:` 아바타(업로드 사진이 아니라 받기 없이 선다). */
const PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

function rosterMember(over: Record<string, unknown>) {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    role: 'member',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [GENERAL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

let seoyeon: Record<string, unknown> = {};

function roster() {
  return [
    rosterMember({ id: SELF_ID, displayName: '이도현', handle: 'dohyun', role: 'owner' }),
    rosterMember({
      id: SEOYEON,
      displayName: '박서연',
      handle: 'seoyeon',
      avatarUrl: PHOTO,
      ...seoyeon,
    }),
    rosterMember({
      id: HELPER,
      kind: 'agent',
      displayName: '달무리 도우미',
      handle: 'dalmuri-helper',
      ownerHumanId: SELF_ID,
    }),
  ];
}

const CHANNELS = [
  { id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false },
];

/** 세 사람이 차례로 한 줄씩 — 줄마다 묶음의 머리라 줄마다 얼굴이 선다(`profile-avatar-target`). */
const HISTORY = [
  [1, SEOYEON, '배포는 금요일 오전 10시예요.'],
  [2, HELPER, '확인했어요.'],
  [3, SELF_ID, '좋아요, 그렇게 해요.'],
].map(([seq, author, body]) => ({
  id: `msg-${seq}`,
  channelId: GENERAL,
  seq,
  hlcTs: seq,
  hlcCount: 0,
  authorMemberId: author,
  type: 'text',
  body,
  state: 'sent',
  createdAtMs: BASE_MS + Number(seq) * 1000,
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 에이전트의 서버 생존 읽기 — `null` 이면 404(라벨 없음)다. */
let liveness: { state: string; lastSignalAtMs?: number } | null = null;

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (/\/inbox(\/|$)/.test(new URL(url).pathname)) {
      return jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
    }
    if (url.includes('/liveness')) {
      return liveness === null
        ? jsonResponse(404, { error: { code: 'not_found', message: 'not found' } })
        : jsonResponse(200, { agentMemberId: HELPER, ...liveness });
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, { channels: CHANNELS });
    }
    if (url.includes('/roster')) return jsonResponse(200, { members: roster() });
    if (url.includes('/read-state')) return jsonResponse(200, { read_states: [] });
    if (url.includes('/messages')) return jsonResponse(200, { messages: HISTORY });
    if (url.includes('/approvals')) return jsonResponse(200, { approvals: [] });
    return jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
  }) as unknown as typeof fetch;
}

let queryClient: QueryClient | null = null;

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
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
  jest.requireMock('react-native-mmkv') as { __store: Map<string, string> }
).__store;

let releaseMotion: (() => void) | null = null;

beforeEach(async () => {
  // 시트가 내려가는 슬라이드·설정 층이 올라오는 움직임을 끈다 — 이 시험들은 움직임이 주제가 아니다.
  releaseMotion = await pinReduceMotion(true);
  mmkvStore.clear();
  __resetBackgroundStoreForTests();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  seoyeon = {};
  liveness = null;
  installFetch();
});

afterEach(() => {
  cleanup();
  releaseMotion?.();
  releaseMotion = null;
  queryClient?.clear();
  queryClient = null;
});

/** 대화(`#general`)를 열고 세 줄이 서기를 기다린다. */
async function openGeneral() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  await waitFor(() =>
    expect(screen.getByLabelText('이도현 프로필 보기')).toBeTruthy(),
  );
}

describe('내 프로필 → 「설정 열기」 (#4319)', () => {
  it('대화 안에서 내 얼굴을 눌러 연 프로필의 「설정 열기」는 대화를 걷고 설정 페이지를 세운다', async () => {
    await openGeneral();
    expect(screen.getByTestId('composer-input')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('이도현 프로필 보기'));
    expect(screen.getByTestId('member-profile-sheet')).toBeTruthy();
    // 나의 프로필에는 DM 타일이 없고 설정 타일이 그 자리다.
    expect(screen.queryByTestId('profile-open-dm')).toBeNull();
    fireEvent.press(screen.getByTestId('profile-open-settings'));

    await waitFor(() => expect(screen.getByTestId('settings-pane')).toBeTruthy());
    // 설정이 **보이는** 층이다 — 대화 층이 남아 있으면 설정은 그 밑에 그려져 안 보인다.
    expect(screen.queryByTestId('conversation-pane')).toBeNull();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(screen.queryByTestId('member-profile-sheet')).toBeNull();
    expect(screen.getByTestId('self-profile-name')).toHaveTextContent('이도현');
  });

  it('설정 페이지를 닫으면 대화가 아니라 대화를 열던 홈으로 돌아온다', async () => {
    await openGeneral();
    fireEvent.press(screen.getByLabelText('이도현 프로필 보기'));
    fireEvent.press(screen.getByTestId('profile-open-settings'));
    await waitFor(() => expect(screen.getByTestId('settings-pane')).toBeTruthy());

    fireEvent.press(screen.getByTestId('settings-close'));
    await waitFor(() => expect(screen.queryByTestId('settings-pane')).toBeNull());
    expect(screen.getByTestId('sidebar-list')).toBeTruthy();
    expect(screen.queryByTestId('conversation-pane')).toBeNull();
  });
});

describe('사진이 있는 얼굴 → 크게 보기 (#4319)', () => {
  it('프로필의 큰 얼굴을 누르면 시트가 내려가고 사진 뷰어가 서며, 닫으면 대화로 돌아온다', async () => {
    await openGeneral();
    fireEvent.press(screen.getByLabelText('박서연 프로필 보기'));
    expect(screen.getByTestId('member-profile-sheet')).toBeTruthy();

    fireEvent.press(screen.getByTestId('profile-face'));
    // 시트는 걷히고(Modal 위에 Modal 을 쌓지 않는다) 그 자리에 뷰어가 선다.
    expect(screen.queryByTestId('member-profile-sheet')).toBeNull();
    const image = screen.getByTestId('avatar-viewer-image');
    expect(image.props.source).toEqual({ uri: PHOTO });
    expect(image.props.accessibilityLabel).toBe('박서연 프로필 사진');

    fireEvent.press(screen.getByTestId('avatar-viewer-close'));
    expect(screen.queryByTestId('avatar-viewer')).toBeNull();
    // 온 화면으로 돌아온다 — 프로필 시트가 다시 서지 않는다.
    expect(screen.queryByTestId('member-profile-sheet')).toBeNull();
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });

  it('사진이 없는 사람의 큰 얼굴은 눌러도 뷰어가 열리지 않는다', async () => {
    seoyeon = { avatarUrl: undefined };
    await openGeneral();
    fireEvent.press(screen.getByLabelText('박서연 프로필 보기'));
    fireEvent.press(screen.getByTestId('profile-face'));
    expect(screen.getByTestId('member-profile-sheet')).toBeTruthy();
    expect(screen.queryByTestId('avatar-viewer')).toBeNull();
  });
});

describe('상태 칩은 DM 머리와 같은 판정이다 (#4319)', () => {
  it('사람은 스스로 정한 방해 금지가 칩에 선다 — 점과 낱말', async () => {
    seoyeon = { presenceStatus: 'dnd' };
    await openGeneral();
    fireEvent.press(screen.getByLabelText('박서연 프로필 보기'));
    const chip = screen.getByTestId('profile-status');
    expect(chip).toHaveTextContent('방해 금지');
    expect(
      screen.getByTestId('profile-status-dot', { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it('말할 상태가 없는 사람에게는 칩이 없다', async () => {
    await openGeneral();
    fireEvent.press(screen.getByLabelText('박서연 프로필 보기'));
    expect(screen.queryByTestId('profile-status')).toBeNull();
  });

  it('에이전트는 서버의 생존 읽기가 칩이 된다 — 읽기가 오기 전에는 칩이 없다', async () => {
    liveness = { state: 'alive_idle', lastSignalAtMs: BASE_MS };
    await openGeneral();
    fireEvent.press(screen.getByLabelText('달무리 도우미 프로필 보기'));
    expect(screen.getByTestId('member-profile-sheet')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('profile-status')).toHaveTextContent(
        '살아 있음 · 대기 중',
      ),
    );
  });
});

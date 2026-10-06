import type {Member} from '@momo/core/lib/api';
import {contrast} from '@momo/core/design/color';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Animated, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {DS2_COMBOS} from '../src/design/ds2Tokens';
import {EASE_OUT, TAB_FADE_MS} from '../src/design/motion';
import {GlassSurface, LiquidGlassAllowed, resetBlurSupportForTests, resetLiquidGlassSupportForTests} from '../src/design/glass';
import {SHEET_RADIUS, SHEET_TOP} from '../src/design/PageSheet';
import {
  darkPalette,
  lightPalette,
  paletteFrom,
  TOUCH_TARGET,
  type Palette,
} from '../src/design/tokens';
import {TABS, tabLabel} from '../src/nav/state';
import AppShell from '../src/shell/AppShell';
import {PLUS_MENU} from '../src/shell/PlusMenu';
import {
  barWidthFor,
  CAPSULE_SPRING,
  PLUS_ICON,
  PLUS_LABEL,
  SHELL,
  shellGeometry,
  tabWidthFor,
} from '../src/shell/ShellChrome';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// DS2-2 (#2714) — 폰 셸: 알약 탭바 셋 + 페이지 시트 (ADR-0189 D1)
// DS2-2b (#2750) — 가운데 정렬된 작은 알약 + 옆의 작은 + 원 + 가벼운 + 메뉴
//
// 이 파일이 재는 것은 수용기준 다섯이다:
//
//   1. 탭 셋 + 「+」, 그리고 옛 FAB 시트의 기능(에이전트 부르기, 작업 콘솔, 사람 골라
//      DM)이 + 메뉴에서 손실 없이 닿는다. 새 채널은 소유자·관리자에게만 선다.
//   2. + 메뉴는 팝오버다: 바깥·escape·탭 전환으로 닫히고, 무거운 일만 시트로 넘긴다.
//   3. 유리가 투명도 줄이기에 반응한다(불투명), 블러가 없으면 94% 로 대체한다.
//   4. 탭바·+·메뉴의 대비가 바닥 **정지점 전부**에서 선다. 터치 44pt, VoiceOver 라벨.
//   5. (캡처는 PR 본문의 몫이다.)
//
// 기하는 `ShellChrome`·`PlusMenu` 머리의 사양 표(Buzz 실측, 시안 A 재질)와 **같은
// 숫자**인지 렌더 트리에서 읽는다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const PERSON_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

function rosterMember(fields: Record<string, unknown>) {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...fields,
  };
}

const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'}),
  rosterMember({id: AGENT_ID, kind: 'agent', displayName: '김인턴', handle: 'kim-intern'}),
  rosterMember({id: PERSON_ID, displayName: '박세은', handle: 'seeun'}),
];

const DM_CHANNEL = {
  id: 'ch-dm-seeun',
  workspaceId: WS,
  kind: 'dm',
  name: null,
  muted: false,
  memberIds: [SELF_ID, PERSON_ID],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(
  mentions = 0,
  selfRole?: 'owner' | 'admin' | 'member',
  createStatus = 201,
): jest.Mock {
  const roster = ROSTER.map(row =>
    (row as {id?: string}).id === SELF_ID && selfRole ? {...row, role: selfRole} : row,
  );
  // 만든 뒤의 재조회는 끝나지 않는다 — 새 채널이 캐시에 있다면 그것은 재조회가 아니라
  // 시트의 업서트(`upsertChannel`)가 넣은 것이다.
  let createdOnce = false;
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/dms') && init?.method === 'POST') {
      return jsonResponse(200, {channel: DM_CHANNEL, created: true});
    }
    if (url.endsWith('/channels') && init?.method === 'POST') {
      if (createStatus !== 201) {
        return jsonResponse(createStatus, {error: 'conflict', message: 'exists'});
      }
      const body = JSON.parse(String(init.body)) as {kind: string; name: string};
      const channel = {id: 'ch-new', workspaceId: WS, kind: body.kind, name: body.name, muted: false};
      createdOnce = true;
      return jsonResponse(201, {
        channel,
        creatorMembership: {
          id: 'm-1',
          workspaceId: WS,
          channelId: 'ch-new',
          memberId: SELF_ID,
          role: 'owner',
          joinedAtMs: 0,
        },
      });
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {hosts: []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      if (createdOnce) return new Promise<Response>(() => {});
      return jsonResponse(200, {
        channels: [
          {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
        ],
      });
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: roster});
    if (url.includes('/read-state')) {
      return jsonResponse(200, {
        read_states: [
          {
            channel_id: 'ch-general',
            last_read_seq: 10,
            latest_seq: 13,
            unread_count: 3,
            mention_count: mentions,
          },
        ],
      });
    }
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/agent-runs') || url.includes('/runs')) {
      return jsonResponse(200, {runs: []});
    }
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
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
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
}

async function renderReady() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
}

/** `jest.setup.js` 의 expo-haptics 대역이 기록한 요청들(#3580). */
const hapticCalls = (jest.requireMock('expo-haptics') as {__calls: string[]}).__calls;

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
  resetBlurSupportForTests();
  resetLiquidGlassSupportForTests();
  hapticCalls.length = 0;
});

/**
 * 프리셋의 `AccessibilityInfo` 는 이미 `jest.fn` 이라 `spyOn` 이 같은 함수를 돌려주고,
 * `restoreAllMocks` 는 그 구현을 **지운다**. 그래서 되돌리지 않고 매번 기본값을
 * 다시 세운다 — 한 시험의 「투명도 줄이기 켜짐」이 다음 시험으로 새지 않게.
 */
const a11y = AccessibilityInfo as unknown as {
  isReduceTransparencyEnabled: jest.Mock;
  addEventListener: jest.Mock;
};

beforeEach(() => {
  a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(false));
  a11y.addEventListener.mockImplementation(() => ({remove: () => {}}));
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  resetBlurSupportForTests();
  resetLiquidGlassSupportForTests();
});

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style);

// ---- 1. 탭 셋 + FAB, 기능 손실 0 ---------------------------------------------

/** + 를 눌러 메뉴를 연다. */
function openMenu() {
  fireEvent.press(screen.getByTestId('shell-plus'));
  expect(screen.getByTestId('plus-menu')).toBeTruthy();
}

describe('탭 셋과 + (ADR-0189 D1, #2750)', () => {
  it('탭은 홈·인박스·검색 셋이고, 에이전트·작업 탭은 없다', async () => {
    installFetch();
    await renderReady();
    for (const tab of TABS) {
      const node = screen.getByTestId(`tab-${tab}`);
      expect(node).toHaveProp('accessibilityRole', 'tab');
      // 배지가 있으면 라벨이 그 뜻을 덧붙인다(#3342) — 이름이 앞에 서는 것이 이 시험의 몫이다.
      expect(String(node.props.accessibilityLabel)).toMatch(
        new RegExp(`^${tabLabel(tab)}`),
      );
    }
    expect(screen.queryByTestId('tab-agents')).toBeNull();
    expect(screen.queryByTestId('tab-work')).toBeNull();
    expect(screen.queryByTestId('tab-channels')).toBeNull();
    expect(screen.getByTestId('tab-home').props.accessibilityState).toEqual({
      selected: true,
    });
    // + 는 행위다 — 탭 목록의 네 번째 자리가 아니다.
    const plus = screen.getByTestId('shell-plus');
    expect(plus).toHaveProp('accessibilityRole', 'button');
    expect(plus).toHaveProp('accessibilityLabel', PLUS_LABEL);
    expect(plus.props.accessibilityState).toEqual({expanded: false});
    // 힌트는 행을 읊지 않는다 — 행은 역할·서버 표면에 따라 달라진다(review M2).
    expect(plus).toHaveProp('accessibilityHint', '만들기 메뉴를 엽니다.');
    // 조상 사슬을 거슬러 올라가며 tablist 를 찾는다: 탭은 그 안에, + 는 그 밖에.
    type Node = {props: {accessibilityRole?: string}; parent: Node | null};
    const insideTablist = (node: Node | null): boolean => {
      for (let at = node?.parent ?? null; at; at = at.parent) {
        if (at.props.accessibilityRole === 'tablist') return true;
      }
      return false;
    };
    expect(insideTablist(screen.getByTestId('tab-home') as unknown as Node)).toBe(true);
    expect(insideTablist(plus as unknown as Node)).toBe(false);
  });

  it('인박스 알약이 「나에게 필요한 일」 수를 들고, 라벨이 그 수를 말한다 (#3342)', async () => {
    installFetch(2);
    await renderReady();
    await waitFor(() => expect(screen.getByTestId('tab-dot-inbox')).toBeTruthy());
    expect(screen.getByTestId('tab-dot-inbox')).toHaveTextContent('2');
    expect(screen.getByTestId('tab-inbox')).toHaveProp(
      'accessibilityLabel',
      '인박스, 나에게 필요한 일 2개',
    );
  });

  it('검색 탭은 누르기 전에는 마운트되지 않고, 누르면 검색 화면이 탭으로 선다', async () => {
    installFetch();
    await renderReady();
    expect(screen.queryByTestId('search-title')).toBeNull();
    fireEvent.press(screen.getByTestId('tab-search'));
    expect(screen.getByTestId('search-title')).toBeTruthy();
    // 탭이라 돌아갈 곳이 없다 — 뒤로 글리프가 없다.
    expect(screen.queryByLabelText(/닫기$/)).toBeNull();
    expect(screen.getByTestId('tab-search').props.accessibilityState).toEqual({
      selected: true,
    });
  });

  it('+ → 「에이전트 부르기」가 에이전트 목록을 연다 (사라진 에이전트 탭의 문)', async () => {
    installFetch();
    await renderReady();
    openMenu();
    expect(
      screen.getByTestId('shell-plus', {includeHiddenElements: true}).props
        .accessibilityState,
    ).toEqual({expanded: true});
    fireEvent.press(screen.getByTestId('plus-menu-agents'));
    // 메뉴가 곧바로 목록을 연다 — 가운데 시트가 없다.
    expect(screen.queryByTestId('plus-menu')).toBeNull();
    expect(screen.queryByTestId('page-sheet')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('agent-list-pane')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('agents-title')).toBeTruthy());
    // 층의 나가는 길이 있다.
    fireEvent.press(screen.getByLabelText('에이전트 목록 닫기'));
    expect(screen.getByTestId('tab-home').props.accessibilityState).toEqual({
      selected: true,
    });
  });

  it('작업 콘솔의 행은 서버가 그 표면을 내줄 때만 선다', async () => {
    installFetch();
    await renderReady();
    openMenu();
    // jest 기본 서버 표면에는 작업 콘솔이 없다(`navState` 의 옛 단정과 같은 전제).
    expect(screen.queryByTestId('plus-menu-work')).toBeNull();
  });

  it('메뉴의 행은 새 DM · 새 채널 · 에이전트 부르기 순서이고, 모두 메뉴 항목이다', async () => {
    installFetch();
    await renderReady();
    openMenu();
    await waitFor(() => expect(screen.getByTestId('plus-menu-channel')).toBeTruthy());
    const rows = screen
      .UNSAFE_root.findAll(
        (node: {props: {testID?: string; accessibilityRole?: string}}) =>
          /^plus-menu-[a-z]+$/.test(node.props.testID ?? '') &&
          node.props.accessibilityRole === 'menuitem',
      )
      .map((node: {props: {testID?: string}}) => node.props.testID)
      .filter((id: string | undefined, i: number, all: Array<string | undefined>) =>
        all.indexOf(id) === i,
      );
    expect(rows).toEqual(['plus-menu-dm', 'plus-menu-channel', 'plus-menu-agents']);
    expect(screen.getByTestId('plus-menu-dm')).toHaveProp('accessibilityLabel', '새 DM');
    expect(screen.getByTestId('plus-menu-channel')).toHaveProp(
      'accessibilityLabel',
      '새 채널',
    );
  });

  it('새 채널 행은 소유자·관리자에게만 선다 (ADR-0128)', async () => {
    installFetch(0, 'member');
    await renderReady();
    openMenu();
    await waitFor(() => expect(screen.getByTestId('plus-menu-dm')).toBeTruthy());
    // 명단이 도착한 뒤에도 없다.
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    expect(screen.queryByTestId('plus-menu-channel')).toBeNull();
  });

  it('+ → 「새 DM」 → 사람을 고르면 DM 을 열고 그 대화로 간다', async () => {
    const fetchMock = installFetch();
    await renderReady();
    openMenu();
    fireEvent.press(screen.getByTestId('plus-menu-dm'));
    expect(screen.queryByTestId('plus-menu')).toBeNull();
    expect(screen.getByTestId('new-dm-sheet')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('new-dm-person-seeun')).toBeTruthy());
    // 옛 시트의 두 문은 메뉴로 옮겼다 — 시트에는 사람만 있다.
    expect(screen.queryByTestId('new-message-agents')).toBeNull();
    // 나 자신은 목록에 없다.
    expect(screen.queryByTestId('new-dm-person-seongjae')).toBeNull();
    fireEvent.changeText(screen.getByTestId('new-dm-search'), '세은');
    expect(screen.queryByTestId('new-dm-person-kim-intern')).toBeNull();
    fireEvent.press(screen.getByTestId('new-dm-person-seeun'));
    await waitFor(() => expect(screen.getByTestId('conversation-pane')).toBeTruthy());
    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/dms') && init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({memberId: PERSON_ID});
    expect(screen.queryByTestId('new-dm-sheet')).toBeNull();
  });

  it('+ → 「새 채널」 → 이름·공개 범위로 POST 하고 그 채널로 간다', async () => {
    const fetchMock = installFetch();
    await renderReady();
    openMenu();
    await waitFor(() => expect(screen.getByTestId('plus-menu-channel')).toBeTruthy());
    fireEvent.press(screen.getByTestId('plus-menu-channel'));
    expect(screen.getByTestId('new-channel-sheet')).toBeTruthy();
    // 규칙은 처음부터 칸 밑에 선다(웹과 같은 자리).
    expect(screen.getByTestId('new-channel-name-rule')).toHaveTextContent(
      '영문, 숫자, 하이픈, 밑줄로 80자 이내, 처음과 끝은 영문이나 숫자. 대문자는 소문자로 저장됩니다.',
    );
    // VoiceOver 는 같은 규칙을 힌트로 듣는다.
    expect(screen.getByTestId('new-channel-name')).toHaveProp(
      'accessibilityHint',
      '영문, 숫자, 하이픈, 밑줄로 80자 이내, 처음과 끝은 영문이나 숫자. 대문자는 소문자로 저장됩니다.',
    );
    // 빈 이름으로는 만들 수 없다.
    expect(screen.getByTestId('new-channel-create').props.accessibilityState).toMatchObject(
      {disabled: true},
    );
    fireEvent.changeText(screen.getByTestId('new-channel-name'), '-bad');
    expect(screen.getByTestId('new-channel-name-issue')).toHaveTextContent(
      /처음과 끝은 영문이나 숫자/,
    );
    fireEvent.changeText(screen.getByTestId('new-channel-name'), ' Design-Review ');
    expect(screen.queryByTestId('new-channel-name-issue')).toBeNull();
    fireEvent.press(screen.getByTestId('new-channel-kind-private'));
    expect(
      screen.getByTestId('new-channel-kind-private').props.accessibilityState,
    ).toEqual({selected: true});
    fireEvent.press(screen.getByTestId('new-channel-create'));
    await waitFor(() => expect(screen.getByTestId('conversation-pane')).toBeTruthy());
    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith(`/workspaces/${WS}/channels`) && init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      kind: 'private',
      name: 'design-review',
    });
    expect(screen.queryByTestId('new-channel-sheet')).toBeNull();
    // 새 채널이 목록 캐시에 바로 들어간다.
    const cached = queryClient?.getQueryData<Array<{id: string}>>(['channels', WS]);
    expect(cached?.some(channel => channel.id === 'ch-new')).toBe(true);
  });

  it('같은 이름이 있으면(409) 이름 칸 밑에 말하고 시트를 닫지 않는다', async () => {
    installFetch(0, undefined, 409);
    await renderReady();
    openMenu();
    await waitFor(() => expect(screen.getByTestId('plus-menu-channel')).toBeTruthy());
    fireEvent.press(screen.getByTestId('plus-menu-channel'));
    fireEvent.changeText(screen.getByTestId('new-channel-name'), 'general');
    fireEvent.press(screen.getByTestId('new-channel-create'));
    await waitFor(() =>
      expect(screen.getByTestId('new-channel-name-issue')).toHaveTextContent(
        /같은 이름의 채널이 이미 있습니다/,
      ),
    );
    expect(screen.getByTestId('new-channel-sheet')).toBeTruthy();
    expect(screen.queryByTestId('conversation-pane')).toBeNull();
  });
});

// ---- + 메뉴 — 팝오버의 닫힘 --------------------------------------------------

describe('+ 메뉴는 가벼운 팝오버다 (#2750)', () => {
  it('바깥(스크림)을 누르면 닫힌다', async () => {
    installFetch();
    await renderReady();
    openMenu();
    fireEvent.press(screen.getByTestId('plus-menu-scrim', {includeHiddenElements: true}));
    expect(screen.queryByTestId('plus-menu')).toBeNull();
    expect(screen.getByTestId('shell-plus').props.accessibilityState).toEqual({
      expanded: false,
    });
  });

  it('VoiceOver escape 로 닫히고, 메뉴는 모달이며 스크림은 보조기술에서 숨는다', async () => {
    installFetch();
    await renderReady();
    openMenu();
    // 모달은 레이어 뿌리에 있다: iOS 는 그 뷰의 **형제**(탭바·+·목록)를 무시한다.
    const layer = screen.getByTestId('plus-menu-layer');
    expect(layer).toHaveProp('accessibilityViewIsModal', true);
    // 메뉴가 열린 동안 탭바·+·목록은 보조기술에서 가려진다(VoiceOver 가 메뉴에 갇힌다).
    for (const id of ['shell-plus', 'tab-home', 'sidebar-list']) {
      expect([id, screen.queryByTestId(id)]).toEqual([id, null]);
    }
    expect(screen.getByTestId('plus-menu-dm')).toBeTruthy();
    expect(screen.queryByTestId('plus-menu-scrim')).toBeNull();
    act(() => layer.props.onAccessibilityEscape());
    expect(screen.queryByTestId('plus-menu')).toBeNull();
  });

  // 실기기에서 메뉴가 열린 동안의 손가락은 스크림에 먼저 닿는다(위 시험). 이 시험은
  // 탭 선택 핸들러 자체가 메뉴를 접는지를 잰다 — 코드로 탭이 바뀌는 길(알림 등)의 몫.
  it('탭 선택 핸들러는 메뉴를 접는다', async () => {
    installFetch();
    await renderReady();
    openMenu();
    fireEvent.press(screen.getByTestId('tab-inbox', {includeHiddenElements: true}));
    expect(screen.queryByTestId('plus-menu')).toBeNull();
  });

  it('메뉴가 열린 채 다른 길로 층이 서면 메뉴가 접힌다 — 층을 닫아도 다시 뜨지 않는다', async () => {
    installFetch();
    await renderReady();
    openMenu();
    // 알림 탭 같은 다른 길을 흉내 낸다: 스크림을 거치지 않고 대화 층을 연다.
    fireEvent.press(
      screen.getByTestId('sidebar-row-channel:ch-general', {includeHiddenElements: true}),
    );
    await waitFor(() => expect(screen.getByTestId('conversation-pane')).toBeTruthy());
    fireEvent.press(screen.getByTestId('header-back'));
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(screen.queryByTestId('plus-menu')).toBeNull();
  });

  it('메뉴를 여는 것은 시트가 아니다 — + 한 번에 전면 시트가 서지 않는다', async () => {
    installFetch();
    await renderReady();
    openMenu();
    expect(screen.queryByTestId('page-sheet')).toBeNull();
  });
});

// ---- 기하 — 시안 A 의 숫자 그대로 --------------------------------------------

describe('기하가 사양 표와 같다 — Buzz 크기, 시안 A 재질 (#2750)', () => {
  it('띠는 창 전폭이고 알약만 흐름 안에서 가운데에 선다: 하 30 · 띠는 누름을 받지 않는다 (#3580)', async () => {
    installFetch();
    await renderReady();
    const band = screen.getByTestId('shell-bottom');
    expect(band).toHaveProp('pointerEvents', 'box-none');
    expect(StyleSheet.flatten(band.props.style)).toMatchObject({
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 30,
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
    });
    // 틈(`gap`)이 있으면 + 가 흐름 안에 있다는 뜻이고, 그러면 알약이 31pt 왼쪽으로 간다.
    expect(StyleSheet.flatten(band.props.style).gap).toBeUndefined();
  });

  it('탭바: 높이 54 · 반경 27 · 1px 유리 선 · 폭 212 (Buzz ≈211×53)', async () => {
    installFetch();
    await renderReady();
    const bar = flat('shell-tabbar');
    expect(bar).toMatchObject({height: 54, borderRadius: 27, borderWidth: 1});
    // 가운데 정렬은 띠가 한다 — 탭바 자신은 한쪽에 붙지 않는다.
    expect([bar.position, bar.left, bar.right]).toEqual([undefined, undefined, undefined]);
    expect(typeof bar.boxShadow).toBe('string');
    expect(barWidthFor(SHELL.tabWidth)).toBe(212);
    expect(Math.abs(barWidthFor(SHELL.tabWidth) - 211)).toBeLessThanOrEqual(2);
  });

  it('탭 단추 66×46 · 반경 23 — Buzz ≈67×46, 터치 44 를 두 변 모두 넘는다', async () => {
    installFetch();
    await renderReady();
    for (const tab of TABS) {
      const style = flat(`tab-${tab}`);
      expect([tab, style.width, style.height, style.borderRadius]).toEqual([
        tab,
        66,
        46,
        23,
      ]);
      expect(style.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(style.height).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
  });

  it('+: 54 원(탭바 높이와 같다) · 잉크 채움 · 24pt 더하기 · 별도 FAB 자리가 없다', async () => {
    installFetch();
    await renderReady();
    const plus = flat('shell-plus');
    expect(plus).toMatchObject({width: 54, height: 54, borderRadius: 27});
    expect(plus.width).toBe(SHELL.barHeight);
    expect(plus.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
    // 알약의 흐름 밖, 창 오른쪽 가장자리 20 에 앵커한다(Buzz `rightInset`). 아래 구석에
    // 떠 있던 옛 FAB(`bottom` 이 있다)이 아니라 알약과 같은 선에 선다.
    expect([plus.position, plus.right, plus.top, plus.bottom]).toEqual([
      'absolute',
      SHELL.plusInset,
      0,
      undefined,
    ]);
    expect([lightPalette.primary, darkPalette.primary]).toContain(plus.backgroundColor);
    const icon = flat('shell-plus-icon');
    expect([icon.width, icon.height]).toEqual([PLUS_ICON, PLUS_ICON]);
    expect(screen.queryByTestId('shell-fab')).toBeNull();
  });

  it('하단 크롬이 이전(전폭 · 64 높이)보다 가볍다 — 높이 54', () => {
    expect(SHELL.barHeight).toBeLessThan(64);
  });

  // ---- 가운데·오른쪽 산수 (#3580) — 렌더 트리가 쓰는 식과 같은 식을 잰다 --------

  it.each([320, 360, 375, 390, 393, 402, 430])(
    '%ipt 창: 알약 중심 = 창 중심, + 오른쪽 여백 = 20, 둘은 8 이상 떨어진다',
    width => {
      const g = shellGeometry(width);
      // 알약이 정중앙 — 왼쪽 여백과 오른쪽 여백이 같다(반올림 오차 없이 정확히).
      expect(g.barLeft).toBe(width - g.barRight);
      expect((g.barLeft + g.barRight) / 2).toBe(width / 2);
      // + 는 오른쪽 가장자리에서 plusInset.
      expect(width - g.plusRight).toBe(SHELL.plusInset);
      expect(g.plusRight - g.plusLeft).toBe(SHELL.plus);
      // 겹치지 않고 틈이 최소를 지킨다.
      expect(g.gap).toBeGreaterThanOrEqual(SHELL.plusGap);
      // 알약 왼쪽 여백이 오른쪽 + 의 자리만큼은 있다(대칭 비움).
      expect(g.barLeft).toBeGreaterThanOrEqual(SHELL.plusInset + SHELL.plus + SHELL.plusGap);
      expect(g.tabWidth).toBeGreaterThanOrEqual(TOUCH_TARGET);
    },
  );

  it('이전 판의 결함을 재현하면 이 시험이 잡는다: 알약+ 묶음을 가운데에 두면 알약이 31pt 왼쪽이다', () => {
    const width = 393;
    const oldBarLeft = (width - (barWidthFor(66) + 8 + 54)) / 2;
    expect(shellGeometry(width).barLeft - oldBarLeft).toBe(31);
  });

  it('393 은 사양 66·알약 212, 375 는 65 로 1pt 준다, 그 아래는 44 까지', () => {
    expect(shellGeometry(393)).toMatchObject({tabWidth: 66, barWidth: 212, barLeft: 90.5});
    expect(shellGeometry(402).tabWidth).toBe(66);
    expect(tabWidthFor(376)).toBe(66);
    expect(tabWidthFor(375)).toBe(65);
    expect(tabWidthFor(320)).toBeLessThan(65);
    expect(tabWidthFor(200)).toBe(TOUCH_TARGET);
  });

  it('320pt 창에서 렌더된 탭이 식과 같은 폭을 든다', async () => {
    const rn = jest.requireActual('react-native') as typeof import('react-native');
    const spy = jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({width: 320, height: 568, scale: 2, fontScale: 1});
    installFetch();
    await renderReady();
    expect(flat('tab-home').width).toBe(tabWidthFor(320));
    spy.mockRestore();
  });

  it('+ 메뉴: 좌우 20 · 탭바 위 8 · 잉크 그릇 반경 20 · 안 여백 8 · 행 최소 54 (≥44)', async () => {
    installFetch();
    await renderReady();
    openMenu();
    const menu = flat('plus-menu');
    expect(menu).toMatchObject({
      position: 'absolute',
      left: 20,
      right: 20,
      bottom: SHELL.bottom + SHELL.barHeight + 8,
      padding: 8,
      gap: 8,
      borderRadius: 20,
    });
    expect([lightPalette.primary, darkPalette.primary]).toContain(menu.backgroundColor);
    for (const key of ['dm', 'agents']) {
      const row = flat(`plus-menu-${key}`);
      expect([key, row.minHeight]).toEqual([key, PLUS_MENU.rowHeight]);
      expect(row.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(row.borderRadius).toBe(14);
      const icon = flat(`plus-menu-${key}-icon`);
      expect([icon.width, icon.height]).toEqual([22, 22]);
    }
  });

  it('층이 열리면 탭바와 + 가 층 **밑**에 있다 (review B1)', async () => {
    // RN 새 아키텍처에서 zIndex 는 트리 순서보다 앞선다. 크롬이 zIndex 를 들면 대화
    // 층 위에 서서 컴포저를 가리고 눌린다. 그래서 두 가지를 잰다: 크롬에 zIndex 가
    // 없고, 층이 트리에서 크롬보다 **뒤**에 있다(= 위에 그려진다).
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    await waitFor(() => expect(screen.getByTestId('conversation-pane')).toBeTruthy());
    for (const id of ['shell-tabbar', 'shell-plus']) {
      const style = StyleSheet.flatten(
        screen.getByTestId(id, {includeHiddenElements: true}).props.style,
      );
      expect([id, style.zIndex]).toEqual([id, undefined]);
    }
    const order = screen
      .UNSAFE_root.findAll(
        (node: {props: {testID?: string}}) =>
          ['shell-tabbar', 'shell-plus', 'conversation-pane'].includes(
            node.props.testID ?? '',
          ),
        {deep: true},
      )
      .map((node: {props: {testID?: string}}) => node.props.testID)
      .filter((id: string | undefined, i: number, all: Array<string | undefined>) =>
        all.indexOf(id) === i,
      );
    expect(order).toEqual(['shell-tabbar', 'shell-plus', 'conversation-pane']);
    // 층이 크롬을 덮으므로 보조기술 트리에서도 크롬은 가려진다.
    expect(screen.queryByTestId('shell-plus')).toBeNull();
  });

  it('페이지 시트: 위 58 · 반경 30 · 시트 바탕 · 38×5 손잡이', async () => {
    installFetch();
    await renderReady();
    openMenu();
    fireEvent.press(screen.getByTestId('plus-menu-dm'));
    const sheet = flat('page-sheet');
    expect(sheet.top).toBe(SHEET_TOP);
    expect(SHEET_TOP).toBe(58);
    expect(SHEET_RADIUS).toBe(30);
    expect(sheet.borderTopLeftRadius).toBe(30);
    expect(sheet.borderTopRightRadius).toBe(30);
    expect([lightPalette.sheet, darkPalette.sheet]).toContain(sheet.backgroundColor);
  });

  it('페이지 시트는 스크림으로 닫힌다', async () => {
    installFetch();
    await renderReady();
    openMenu();
    fireEvent.press(screen.getByTestId('plus-menu-dm'));
    // 스크림은 모달 시트의 형제라 보조기술 트리에서 숨는다(VoiceOver 는 escape 로 닫는다).
    fireEvent.press(
      screen.getByTestId('page-sheet-scrim', {includeHiddenElements: true}),
    );
    // 미끄러져 나가는 260ms 를 기다린다. 부하가 높은 러너에서 기본 1s 가 모자란
    // 적이 있어(부하 13, 1.8~4.1s) 넉넉히 준다 — 재는 것은 「닫힌다」이지 속도가 아니다.
    await waitFor(() => expect(screen.queryByTestId('new-dm-sheet')).toBeNull(), {
      timeout: 8000,
    });
  }, 15000);

  it('탭 목록의 끝이 탭바 밑에 숨지 않는다 — 시안 .a-scroll 의 140', async () => {
    installFetch();
    await renderReady();
    const content = StyleSheet.flatten(
      screen.getByTestId('sidebar-list').props.contentContainerStyle,
    );
    expect(content.paddingBottom).toBeGreaterThanOrEqual(SHELL.clearance);
    expect(SHELL.clearance).toBeGreaterThanOrEqual(SHELL.bottom + SHELL.barHeight);
  });
});

// ---- 2. 유리 — 투명도 줄이기·블러 없음 -----------------------------------------

describe('유리 재료 (ADR-0189 D7)', () => {
  it('블러 모듈이 없으면 surface 94% 로 그린다', async () => {
    installFetch();
    await renderReady();
    expect(screen.getByTestId('shell-tabbar-fallback')).toBeTruthy();
    const fill = flat('shell-tabbar-fallback');
    expect([lightPalette.glassFallback, darkPalette.glassFallback]).toContain(
      fill.backgroundColor,
    );
  });

  it('블러가 있으면 BlurView 위에 glass 틴트를 얹는다', async () => {
    resetBlurSupportForTests(true);
    installFetch();
    await renderReady();
    expect(screen.getByTestId('blur-view')).toBeTruthy();
    const tint = flat('shell-tabbar-blur');
    expect([lightPalette.glass, darkPalette.glass]).toContain(tint.backgroundColor);
  });

  it('투명도 줄이기가 켜지면 불투명 surface — 블러가 있어도', async () => {
    resetBlurSupportForTests(true);
    a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(true));
    installFetch();
    await renderReady();
    await waitFor(() => expect(screen.getByTestId('shell-tabbar-opaque')).toBeTruthy());
    expect(screen.queryByTestId('blur-view')).toBeNull();
    const fill = flat('shell-tabbar-opaque');
    expect([lightPalette.surface, darkPalette.surface]).toContain(fill.backgroundColor);
  });

  it('설정이 앱이 떠 있는 동안 바뀌어도 따라간다', async () => {
    // 탭바와 유리 면이 각자 구독한다(탭바는 재료에 따라 테두리를 가른다 — #3580). 실제
    // 시스템 이벤트는 구독자 전부에게 가므로 시험도 전부에게 보낸다.
    const handlers: Array<(value: boolean) => void> = [];
    a11y.addEventListener.mockImplementation(
      (event: string, handler: (value: boolean) => void) => {
        if (event === 'reduceTransparencyChanged') handlers.push(handler);
        return {remove: () => {}};
      },
    );
    installFetch();
    await renderReady();
    expect(screen.getByTestId('shell-tabbar-fallback')).toBeTruthy();
    expect(handlers.length).toBeGreaterThan(0);
    act(() => handlers.forEach(emit => emit(true)));
    expect(screen.getByTestId('shell-tabbar-opaque')).toBeTruthy();
  });
});

// ---- 3. 비텍스트 대비 3:1 — 바닥 정지점 전부 ------------------------------------

/** `#rrggbbaa` 를 불투명한 `#rrggbb` 위에 합성한다. */
function over(layer: string, base: string): string {
  const alpha = parseInt(layer.slice(7, 9), 16) / 255;
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return (
    '#' +
    [0, 1, 2]
      .map(i =>
        Math.round(alpha * channel(layer, i) + (1 - alpha) * channel(base, i))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** 탭바가 설 수 있는 모든 바탕: 세 재료 × 바닥 세 정지점(유리는 뒤가 비친다). */
function barBackgrounds(p: Palette): Array<[string, string]> {
  const stops: Array<[string, string]> = [
    ['canvasTop', p.canvasTop],
    ['bg', p.bg],
    ['canvasBottom', p.canvasBottom],
  ];
  return [
    ...stops.map(([name, hex]) => [`glass/${name}`, over(p.glass, hex)] as [string, string]),
    ...stops.map(
      ([name, hex]) => [`fallback/${name}`, over(p.glassFallback, hex)] as [string, string],
    ),
    ['opaque/surface', p.surface],
  ];
}

describe.each(DS2_COMBOS)('%s %s — 탭바·+·메뉴 대비', (theme, mode) => {
  const p = paletteFrom(theme, mode);

  it('안 고른 탭 아이콘(textMuted)이 모든 바탕에서 3:1 을 넘는다', () => {
    for (const [where, bg] of barBackgrounds(p)) {
      expect([where, contrast(p.textMuted, bg) >= 3]).toEqual([where, true]);
    }
  });

  it('고른 탭 아이콘(text)이 잉크 8% 채움 위에서 3:1 을 넘는다', () => {
    for (const [where, bg] of barBackgrounds(p)) {
      const selected = over(`${p.text}14`, bg);
      expect([where, contrast(p.text, selected) >= 3]).toEqual([where, true]);
    }
  });

  it('인박스 점(accent)이 모든 바탕에서 3:1, 점 안의 수는 4.5:1', () => {
    for (const [where, bg] of barBackgrounds(p)) {
      expect([where, contrast(p.accent, bg) >= 3]).toEqual([where, true]);
    }
    expect(contrast(p.onAccent, p.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('+ 잉크(primary)가 바닥 세 정지점 모두에서 3:1, 더하기는 4.5:1', () => {
    for (const stop of ['canvasTop', 'bg', 'canvasBottom'] as const) {
      expect([stop, contrast(p.primary, p[stop]) >= 3]).toEqual([stop, true]);
    }
    expect(contrast(p.onPrimary, p.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it('메뉴 글자·아이콘(onPrimary)이 **렌더된** 행 채움과 눌림 위에서 4.5:1', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('shell-plus'));
    // 렌더된 행의 채움을 읽는다(팔레트는 시험이 고른 모드와 다를 수 있어, 채움의
    // 알파만 가져와 이 조합의 onPrimary·primary 로 다시 합성한다).
    // 합성 `Pressable` 의 style 함수를 두 상태로 불러 읽는다.
    const pressable = screen
      .UNSAFE_getAllByProps({testID: 'plus-menu-dm'})
      .find(node => typeof node.props.style === 'function');
    const styleFor = (pressed: boolean) =>
      StyleSheet.flatten(pressable!.props.style({pressed})).backgroundColor;
    const rest = styleFor(false);
    const down = styleFor(true);
    expect(down).not.toBe(rest);
    for (const [state, fill] of [
      ['rest', rest],
      ['pressed', down],
    ] as const) {
      const alpha = String(fill).slice(7, 9);
      expect(alpha).toMatch(/^[0-9a-f]{2}$/i);
      const bg = over(`${p.onPrimary}${alpha}`, p.primary);
      expect([state, contrast(p.onPrimary, bg) >= 4.5]).toEqual([state, true]);
    }
  });
});

// ---- 4. 햅틱 · 탭 전환 · 리퀴드 글래스 (#3580) ----------------------------------

const motionInfo = AccessibilityInfo as unknown as {
  isReduceMotionEnabled: jest.Mock;
};

function setReduceMotion(value: boolean) {
  motionInfo.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(value));
}

afterEach(() => {
  setReduceMotion(false);
});

describe('햅틱 — 사용자가 만든 순간에 한 번 (#3580)', () => {
  it('탭이 **바뀔 때** selection 한 번이고, 같은 탭을 다시 누르면 0번이다', async () => {
    installFetch();
    await renderReady();
    expect(hapticCalls).toEqual([]);
    fireEvent.press(screen.getByTestId('tab-inbox'));
    expect(hapticCalls).toEqual(['selection']);
    fireEvent.press(screen.getByTestId('tab-inbox'));
    expect(hapticCalls).toEqual(['selection']);
    fireEvent.press(screen.getByTestId('tab-search'));
    expect(hapticCalls).toEqual(['selection', 'selection']);
  });

  it('탭 화면이 렌더되는 것만으로는 햅틱이 나지 않는다 — 입력 없이는 0번', async () => {
    installFetch();
    await renderReady();
    await act(async () => {
      await Promise.resolve();
    });
    expect(hapticCalls).toEqual([]);
  });

  it('+ 를 누르면 light 한 번 — 메뉴가 열리는 그 누름에', async () => {
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('shell-plus'));
    expect(hapticCalls).toEqual(['impact:light']);
    // 닫는 누름에는 없다(메뉴가 모달이라 + 는 보조기술 조회에서 숨는다).
    fireEvent.press(screen.getByTestId('shell-plus', {includeHiddenElements: true}));
    expect(hapticCalls).toEqual(['impact:light']);
  });

  it('프로필 아바타는 light 한 번, 시트는 같은 누름에 열린다', async () => {
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('profile-avatar'));
    expect(hapticCalls).toEqual(['impact:light']);
    await waitFor(() => expect(screen.getByTestId('profile-sheet')).toBeTruthy());
  });

  it('사이드바 섹션 접기·펴기는 누를 때마다 selection 한 번', async () => {
    installFetch();
    await renderReady();
    const toggle = screen.getAllByTestId(/^home-section-toggle-/)[0];
    fireEvent.press(toggle);
    fireEvent.press(toggle);
    expect(hapticCalls).toEqual(['selection', 'selection']);
  });

  it('네이티브 햅틱 모듈이 던져도 탭 전환은 그대로 된다 — 햅틱이 기능을 깨지 않는다', async () => {
    const mod = jest.requireMock('expo-haptics') as {selectionAsync: () => Promise<void>};
    const original = mod.selectionAsync;
    mod.selectionAsync = () => {
      throw new Error('햅틱 엔진 없음');
    };
    try {
      installFetch();
      await renderReady();
      fireEvent.press(screen.getByTestId('tab-inbox'));
      expect(screen.getByTestId('tab-inbox')).toHaveProp('accessibilityState', {selected: true});
    } finally {
      mod.selectionAsync = original;
    }
  });
});

describe('탭 전환 모션 — 캡슐과 페이드 (#3580)', () => {
  // 캡슐은 보조기술에서 숨겨져 있으므로(장식) 조회도 숨김을 포함한다.
  const capsule = () => screen.getByTestId('tab-capsule', {includeHiddenElements: true});
  const capsuleStyle = () => StyleSheet.flatten(capsule().props.style);
  const capsuleX = () =>
    (capsuleStyle().transform as Array<{translateX: number}>)[0].translateX;
  const paneOpacity = () => flat('tab-pane-active').opacity as number;

  it('처음 그림은 움직이지 않는다: 캡슐은 홈 자리(0), 활성 칸은 불투명 1', async () => {
    installFetch();
    await renderReady();
    expect(capsuleX()).toBe(0);
    expect(paneOpacity()).toBe(1);
    expect(capsuleStyle().width).toBe(66);
    // 장식이라 보조기술에 없고 누름도 받지 않는다.
    expect(capsule()).toHaveProp('pointerEvents', 'none');
    expect(capsule()).toHaveProp('accessibilityElementsHidden', true);
  });

  it('동작 줄이기: 캡슐은 즉시 자리를 옮기고 칸은 페이드 없이 1 이다', async () => {
    setReduceMotion(true);
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('tab-inbox'));
    // 한 틱도 기다리지 않는다 — 스프링·페이드가 돌았다면 아직 도중이다.
    expect(capsuleX()).toBe(66 + SHELL.barGap);
    expect(paneOpacity()).toBe(1);
  });

  // Jest 에서 `useNativeDriver: true` 애니메이션은 JS 값을 진행시키지 않는다(네이티브가 돈다).
  // 그래서 「끝에 1 이 된다」는 이 자리에서 잴 수 없고, **무엇을 요청했는가**(대상 값·길이·곡선·
  // 네이티브 구동)와 **출발점**을 잰다. 실제 매끄러움은 시뮬레이터 영상·실기기의 몫이다.
  it('동작 줄이기가 꺼져 있으면: 새 칸이 0 에서 출발하고, 요청은 150ms ease-out·스프링(임계감쇠)·네이티브 구동이다', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const spring = jest.spyOn(Animated, 'spring');
    installFetch();
    await renderReady();
    timing.mockClear();
    spring.mockClear();
    fireEvent.press(screen.getByTestId('tab-inbox'));
    // 막 눌린 그림: 칸은 0(깜빡임 없이 그리기 전에 세웠다), 캡슐은 아직 출발점 — 즉시 점프가 아니다.
    expect(paneOpacity()).toBe(0);
    expect(capsuleX()).toBe(0);
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: 1,
      duration: TAB_FADE_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    expect(spring).toHaveBeenCalledTimes(1);
    expect(spring.mock.calls[0][1]).toMatchObject({
      toValue: 66 + SHELL.barGap,
      ...CAPSULE_SPRING,
      useNativeDriver: true,
    });
    // 감쇠비 1 — 오버슈트가 없다: damping = 2·√(stiffness·mass).
    const {stiffness, damping, mass} = CAPSULE_SPRING;
    expect(damping / (2 * Math.sqrt(stiffness * mass))).toBeGreaterThanOrEqual(0.99);
    timing.mockRestore();
    spring.mockRestore();
  });

  it('150ms · 곡선은 ease-in 이 아니다 · 탭 화면에는 이동·확대가 없다(불투명도만)', async () => {
    expect(TAB_FADE_MS).toBeLessThanOrEqual(150);
    // `Easing.bezier(0.23, 1, 0.32, 1)` — 처음 3분의 1 안에 대부분 간다(ease-out).
    expect(EASE_OUT(0.2)).toBeGreaterThan(0.5);
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('tab-inbox'));
    expect(flat('tab-pane-active').transform).toBeUndefined();
  });

  it('연타해도 입력이 잠기지 않는다: 도중에 다른 탭을 눌러도 마지막 탭에 서고 목표는 마지막 자리다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    installFetch();
    await renderReady();
    spring.mockClear();
    fireEvent.press(screen.getByTestId('tab-inbox'));
    fireEvent.press(screen.getByTestId('tab-search'));
    expect(screen.getByTestId('tab-search')).toHaveProp('accessibilityState', {selected: true});
    expect(spring.mock.calls.map(call => call[1].toValue)).toEqual([
      66 + SHELL.barGap,
      (66 + SHELL.barGap) * 2,
    ]);
    expect(hapticCalls).toEqual(['selection', 'selection']);
    spring.mockRestore();
  });

  it('선택은 모션과 상관없이 VoiceOver 상태로 선다 — 캡슐이 유일한 표시가 아니다', async () => {
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('tab-inbox'));
    expect(screen.getByTestId('tab-inbox')).toHaveProp('accessibilityState', {selected: true});
    expect(screen.getByTestId('tab-home')).toHaveProp('accessibilityState', {selected: false});
  });
});

describe('리퀴드 글래스 (#3580)', () => {
  it('iOS 26 갈래: GlassView 가 서고 블러·94% 는 없다. 앱 테마를 명시하고 유리 선은 투명이다', async () => {
    resetLiquidGlassSupportForTests(true);
    resetBlurSupportForTests(true);
    installFetch();
    await renderReady();
    const glass = screen.getByTestId('shell-tabbar-liquid');
    expect(glass).toHaveProp('glassEffectStyle', 'regular');
    expect(['light', 'dark']).toContain(glass.props.colorScheme);
    expect(screen.queryByTestId('blur-view')).toBeNull();
    expect(screen.queryByTestId('shell-tabbar-fallback')).toBeNull();
    // 이중선 방지 — 두께는 남겨 안쪽 46 의 산수를 지킨다.
    expect(flat('shell-tabbar')).toMatchObject({borderWidth: 1, borderColor: 'transparent', height: 54});
  });

  it('페이드되는 조상 안의 유리는 리퀴드가 아니라 blur 다(조상 알파가 낮으면 UIKit 이 효과를 버린다)', () => {
    resetLiquidGlassSupportForTests(true);
    resetBlurSupportForTests(true);
    const {Text} = jest.requireActual('react-native') as typeof import('react-native');
    const {ThemeProvider} = jest.requireActual('../src/design/theme') as typeof import('../src/design/theme');
    const Probe = ({allowed}: {allowed: boolean}) => (
      <ThemeProvider>
        <LiquidGlassAllowed.Provider value={allowed}>
          <GlassSurface radius={10} testID="probe">
            <Text>x</Text>
          </GlassSurface>
        </LiquidGlassAllowed.Provider>
      </ThemeProvider>
    );
    const view = render(<Probe allowed />);
    expect(screen.getByTestId('probe-liquid')).toBeTruthy();
    view.rerender(<Probe allowed={false} />);
    expect(screen.queryByTestId('probe-liquid')).toBeNull();
    expect(screen.getByTestId('probe-blur')).toBeTruthy();
  });

  it('탭 칸(페이드)이 정말 그 문맥을 닫는다: 홈 칸 안에서는 리퀴드가 허용되지 않는다', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/shell/AppShell.tsx'),
      'utf8',
    ) as string;
    expect(src).toMatch(/<LiquidGlassAllowed\.Provider value=\{false\}>\{children\}/);
  });

  it('투명도 줄이기가 켜지면 리퀴드 글래스도 불투명이다 — 접근성이 먼저다', async () => {
    resetLiquidGlassSupportForTests(true);
    a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(true));
    installFetch();
    await renderReady();
    await waitFor(() => expect(screen.getByTestId('shell-tabbar-opaque')).toBeTruthy());
    expect(screen.queryByTestId('shell-tabbar-liquid')).toBeNull();
    expect(flat('shell-tabbar').borderColor).not.toBe('transparent');
  });

  it('iOS 26 아래(리퀴드 없음)는 지금까지의 갈래 그대로다: 블러 → BlurView, 없으면 94%', async () => {
    resetLiquidGlassSupportForTests(false);
    resetBlurSupportForTests(true);
    installFetch();
    await renderReady();
    expect(screen.getByTestId('blur-view')).toBeTruthy();
    expect(screen.queryByTestId('shell-tabbar-liquid')).toBeNull();
    expect(flat('shell-tabbar').borderColor).not.toBe('transparent');
  });

  it('Jest(네이티브 모듈 없음)의 기본 답은 false 다 — 모듈이 없는 빌드는 던지지 않고 폴백한다', async () => {
    installFetch();
    await renderReady();
    expect(screen.queryByTestId('shell-tabbar-liquid')).toBeNull();
    expect(screen.getByTestId('shell-tabbar-fallback')).toBeTruthy();
  });
});

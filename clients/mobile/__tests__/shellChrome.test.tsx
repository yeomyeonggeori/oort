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
import {AccessibilityInfo, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {DS2_COMBOS} from '../src/design/ds2Tokens';
import {resetBlurSupportForTests} from '../src/design/glass';
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
import {SHELL} from '../src/shell/ShellChrome';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// DS2-2 (#2714) — 폰 셸: 떠 있는 알약 탭바 셋 + 잉크 FAB + 페이지 시트 (ADR-0189 D1)
//
// 이 파일이 재는 것은 수용기준 넷이다:
//
//   1. 탭 셋 + FAB, 그리고 사라진 에이전트·작업 탭의 목적지가 FAB 에서 닿는다
//      (「기능 손실 0」).
//   2. 유리가 투명도 줄이기에 반응한다(불투명), 블러가 없으면 94% 로 대체한다.
//   3. 탭바·FAB 의 비텍스트 대비 3:1 이 바닥 **정지점 전부**에서 선다 — 유리 위의
//      아이콘은 유리를 각 정지점 위에 합성한 색에서 잰다. 터치 44pt, VoiceOver 라벨.
//   4. (캡처는 PR 본문의 몫이다.)
//
// 기하는 시안 A `#a-home`의 CSS 값과 **같은 숫자**인지 렌더 트리에서 읽는다.
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

function installFetch(mentions = 0): jest.Mock {
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/dms') && init?.method === 'POST') {
      return jsonResponse(200, {channel: DM_CHANNEL, created: true});
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {hosts: []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: [
          {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
        ],
      });
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
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
});

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style);

// ---- 1. 탭 셋 + FAB, 기능 손실 0 ---------------------------------------------

describe('탭 셋과 FAB (ADR-0189 D1)', () => {
  it('탭은 홈·인박스·검색 셋이고, 에이전트·작업 탭은 없다', async () => {
    installFetch();
    await renderReady();
    for (const tab of TABS) {
      const node = screen.getByTestId(`tab-${tab}`);
      expect(node).toHaveProp('accessibilityRole', 'tab');
      expect(node).toHaveProp('accessibilityLabel', tabLabel(tab));
    }
    expect(screen.queryByTestId('tab-agents')).toBeNull();
    expect(screen.queryByTestId('tab-work')).toBeNull();
    expect(screen.queryByTestId('tab-channels')).toBeNull();
    expect(screen.getByTestId('tab-home').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(screen.getByTestId('shell-fab')).toHaveProp('accessibilityLabel', '새 메시지');
  });

  it('인박스 점이 멘션 수를 들고, 라벨이 그 수를 말한다', async () => {
    installFetch(2);
    await renderReady();
    await waitFor(() => expect(screen.getByTestId('tab-dot-inbox')).toBeTruthy());
    expect(screen.getByTestId('tab-dot-inbox')).toHaveTextContent('2');
    expect(screen.getByTestId('tab-inbox')).toHaveProp(
      'accessibilityLabel',
      '인박스, 멘션 2개',
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

  it('FAB → 「에이전트 부르기」가 에이전트 목록을 연다 (사라진 에이전트 탭의 문)', async () => {
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('shell-fab'));
    expect(screen.getByTestId('new-message-sheet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('new-message-agents'));
    expect(screen.queryByTestId('new-message-sheet')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('agent-list-pane')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('agents-title')).toBeTruthy());
    // 층의 나가는 길이 있다.
    fireEvent.press(screen.getByLabelText('에이전트 목록 닫기'));
    expect(screen.getByTestId('tab-home').props.accessibilityState).toEqual({
      selected: true,
    });
  });

  it('작업 콘솔의 문은 서버가 그 표면을 내줄 때만 선다', async () => {
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('shell-fab'));
    // jest 기본 서버 표면에는 작업 콘솔이 없다(`navState` 의 옛 단정과 같은 전제).
    expect(screen.queryByTestId('new-message-work')).toBeNull();
  });

  it('「받는 사람」에서 사람을 고르면 DM 을 열고 그 대화로 간다', async () => {
    const fetchMock = installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('shell-fab'));
    await waitFor(() =>
      expect(screen.getByTestId('new-message-person-seeun')).toBeTruthy(),
    );
    // 나 자신은 목록에 없다.
    expect(screen.queryByTestId('new-message-person-seongjae')).toBeNull();
    fireEvent.changeText(screen.getByTestId('new-message-search'), '세은');
    expect(screen.queryByTestId('new-message-person-kim-intern')).toBeNull();
    fireEvent.press(screen.getByTestId('new-message-person-seeun'));
    await waitFor(() => expect(screen.getByTestId('conversation-pane')).toBeTruthy());
    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/dms') && init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({memberId: PERSON_ID});
    expect(screen.queryByTestId('new-message-sheet')).toBeNull();
  });
});

// ---- 기하 — 시안 A 의 숫자 그대로 --------------------------------------------

describe('기하가 시안 A #a-home 과 같다', () => {
  it('탭바: 좌 16 · 하 30 · 높이 64 · 반경 32 · 1px 유리 선', async () => {
    installFetch();
    await renderReady();
    const bar = flat('shell-tabbar');
    expect(bar).toMatchObject({
      position: 'absolute',
      left: 16,
      bottom: 30,
      height: 64,
      borderRadius: 32,
      borderWidth: 1,
    });
    expect(typeof bar.boxShadow).toBe('string');
  });

  it('탭 단추 78×52 · 반경 26 — 터치 44 를 두 변 모두 넘는다', async () => {
    installFetch();
    await renderReady();
    for (const tab of TABS) {
      const style = flat(`tab-${tab}`);
      expect([tab, style.width, style.height, style.borderRadius]).toEqual([
        tab,
        78,
        52,
        26,
      ]);
      expect(style.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(style.height).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
  });

  it('FAB: 우 16 · 하 30 · 64 원 · 잉크 채움 · 26pt 더하기', async () => {
    installFetch();
    await renderReady();
    const fab = flat('shell-fab');
    expect(fab).toMatchObject({
      position: 'absolute',
      right: 16,
      bottom: 30,
      width: 64,
      height: 64,
      borderRadius: 32,
    });
    expect([lightPalette.primary, darkPalette.primary]).toContain(fab.backgroundColor);
    const icon = flat('shell-fab-icon');
    expect([icon.width, icon.height]).toEqual([26, 26]);
  });

  it('탭바와 FAB 이 375pt 폭에서 겹치지 않는다', () => {
    // 폭 = 78×3 + 2×2 + 6×2 + 테두리 2 = 252. 좌 16 + 252 + 틈 + 64 + 우 16.
    const barWidth = SHELL.tabWidth * 3 + SHELL.barGap * 2 + SHELL.barPadding * 2 + 2;
    expect(barWidth).toBe(252);
    expect(SHELL.inset + barWidth + SHELL.fab + SHELL.inset).toBeLessThan(375);
  });

  it('페이지 시트: 위 58 · 반경 30 · 시트 바탕 · 38×5 손잡이', async () => {
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('shell-fab'));
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
    fireEvent.press(screen.getByTestId('shell-fab'));
    // 스크림은 모달 시트의 형제라 보조기술 트리에서 숨는다(VoiceOver 는 escape 로 닫는다).
    fireEvent.press(
      screen.getByTestId('page-sheet-scrim', {includeHiddenElements: true}),
    );
    // 미끄러져 나가는 260ms 를 기다린다. 부하가 높은 러너에서 기본 1s 가 모자란
    // 적이 있어(부하 13, 1.8~4.1s) 넉넉히 준다 — 재는 것은 「닫힌다」이지 속도가 아니다.
    await waitFor(() => expect(screen.queryByTestId('new-message-sheet')).toBeNull(), {
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
    let emit: ((value: boolean) => void) | null = null;
    a11y.addEventListener.mockImplementation(
      (event: string, handler: (value: boolean) => void) => {
        if (event === 'reduceTransparencyChanged') emit = handler;
        return {remove: () => {}};
      },
    );
    installFetch();
    await renderReady();
    expect(screen.getByTestId('shell-tabbar-fallback')).toBeTruthy();
    expect(emit).not.toBeNull();
    act(() => emit!(true));
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

describe.each(DS2_COMBOS)('%s %s — 탭바·FAB 비텍스트 3:1', (theme, mode) => {
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

  it('FAB 잉크(primary)가 바닥 세 정지점 모두에서 3:1, 더하기는 4.5:1', () => {
    for (const stop of ['canvasTop', 'bg', 'canvasBottom'] as const) {
      expect([stop, contrast(p.primary, p[stop]) >= 3]).toEqual([stop, true]);
    }
    expect(contrast(p.onPrimary, p.primary)).toBeGreaterThanOrEqual(4.5);
  });
});

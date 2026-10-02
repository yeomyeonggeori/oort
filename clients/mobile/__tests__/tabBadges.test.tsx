import type {Approval, Member, ReadState} from '@momo/core/lib/api';
import {approvalItem, type FeedItem} from '@momo/core/features/inbox/model';
import {needsMe} from '@momo/core/features/inbox/needsMe';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {hasUnread, needsMeFrom} from '../src/features/inbox/useNeedsMe';
import {serverBadgeCount} from '../src/push/appBadge';
import AppShell from '../src/shell/AppShell';
import {tabAccessibilityLabel} from '../src/shell/ShellChrome';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 탭 배지 (#3342, 사이드바·알림 시안 §1.2 · 7)
//
//   인박스 알약 = 「나에게 필요한 일」 = core `needsMe`(결정할 수 있는 승인 + 안 읽은 멘션)
//   홈 점       = 안 읽은 글이 있다
//   앱 아이콘   = 서버 안 읽음 합 (바뀌지 않는다, ADR-0109)
//
// 이 파일이 지키는 것은 **알약이 그 수에서 벗어나지 않는다**는 것이다. 알약·인박스
// 필터 칩·core 의 합이 서로 다른 수를 말하는 순간(예: 이미 결정된 승인을 센다, 멘션만
// 센다) 아래 시험이 빨개진다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE = 'https://api.example.com';
const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

const APPROVAL_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const APPROVAL_B = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const APPROVAL_DONE = 'dddddddd-1111-4111-8111-dddddddddddd';

function approval(id: string, status: Approval['status']): Approval {
  return {
    id,
    workspaceId: WS,
    runId: 'run-1',
    channelId: 'ch-general',
    requestedBy: AGENT_ID,
    actionType: 'tool_call',
    status,
    expiresAtMs: 1_700_000_600_000,
  } as Approval;
}

function item(id: string, status: Approval['status']): FeedItem {
  return approvalItem(
    approval(id, status),
    {name: '김인턴', isAgent: true},
    'general',
    1_700_000_000_000,
  );
}

function readState(over: Partial<ReadState> = {}): ReadState {
  return {
    channelId: 'ch-general',
    lastReadSeq: 10,
    latestSeq: 10,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    ...over,
  };
}

// ---- 순수: 수가 어디서 오는가 ---------------------------------------------------

describe('needsMeFrom — 폰의 원천을 core 입력으로 (순수)', () => {
  it('결정할 수 있는 대기 승인 + 안 읽은 멘션이고, 이미 결정된 승인은 세지 않는다', () => {
    const result = needsMeFrom({
      approvalItems: [
        item(APPROVAL_A, 'pending'),
        item(APPROVAL_B, 'pending'),
        item(APPROVAL_DONE, 'approved'),
      ],
      unreadMentions: 3,
    });
    expect(result).toEqual({approvals: 2, panes: 0, mentions: 3, total: 5});
  });

  it('core `needsMe` 와 같은 값이다 — 폰에는 로컬 칸이 없어 칸은 언제나 0이다', () => {
    const viaPhone = needsMeFrom({
      approvalItems: [item(APPROVAL_A, 'pending')],
      unreadMentions: 2,
    });
    const viaCore = needsMe({
      decidableApprovalIds: [APPROVAL_A],
      waitingPaneIds: [],
      unreadMentions: 2,
    });
    expect(viaPhone).toEqual(viaCore);
    expect(viaPhone.panes).toBe(0);
  });

  it('같은 승인이 두 번 와도 한 번만 센다', () => {
    expect(
      needsMeFrom({
        approvalItems: [item(APPROVAL_A, 'pending'), item(APPROVAL_A, 'pending')],
        unreadMentions: 0,
      }).total,
    ).toBe(1);
  });

  it('일반 안 읽음은 이 수에 들어오지 않는다(호박 알약의 몫이다)', () => {
    expect(needsMeFrom({approvalItems: [], unreadMentions: 0}).total).toBe(0);
  });
});

describe('hasUnread — 홈 점 (순수)', () => {
  it('안 읽은 글이 하나라도 있으면 참이다', () => {
    expect(hasUnread([readState(), readState({latestSeq: 12})])).toBe(true);
    expect(hasUnread([readState(), readState()])).toBe(false);
    expect(hasUnread([])).toBe(false);
  });

  it('「여기부터 안 읽음」 표시는 서버 수가 0이어도 점을 켠다 — 사이드바 줄과 같은 수다', () => {
    // 서버 `unreadCount` 는 0, 데스크탑이 건 표시가 seq 8 부터 안 읽음이다(ADR-0178 D3).
    const marked = readState({unreadCount: 0, markedUnreadBeforeSeq: 8});
    expect(hasUnread([marked])).toBe(true);
    // 앱 아이콘은 서버 수 그대로다 — 점과 아이콘은 일부러 다른 정의다(`appBadge.ts`).
    expect(serverBadgeCount([marked])).toBe(0);
  });
});

describe('tabAccessibilityLabel', () => {
  it('배지가 말하는 것을 라벨이 그대로 말한다', () => {
    expect(tabAccessibilityLabel('inbox', 4, false)).toBe('인박스, 나에게 필요한 일 4개');
    expect(tabAccessibilityLabel('home', 0, true)).toBe('홈, 안 읽은 글 있음');
    expect(tabAccessibilityLabel('inbox', 0, false)).toBe('인박스');
    expect(tabAccessibilityLabel('search', 0, false)).toBe('검색');
  });
});

// ---- 셸에 서서: 알약 = 인박스 칩 합 = core 합 ---------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function wireApproval(id: string, status = 'pending') {
  return {
    id,
    workspaceId: WS,
    runId: 'run-1',
    channelId: 'ch-general',
    requestedBy: AGENT_ID,
    actionType: 'tool_call',
    status,
    expiresAtMs: Date.now() + 600_000,
    createdAtMs: Date.now() - 1000,
  };
}

interface Fixture {
  mentions: number;
  unread: number;
  latest: number;
  approvals: ReturnType<typeof wireApproval>[];
}

function installFetch(fixture: Fixture): jest.Mock {
  const roster = [
    {
      id: SELF_ID, workspaceId: WS, kind: 'human', status: 'active', displayName: '곽성재',
      handle: 'seongjae', channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
    },
    {
      id: AGENT_ID, workspaceId: WS, kind: 'agent', status: 'active', displayName: '김인턴',
      handle: 'kim-intern', channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
    },
  ];
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: [{id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false}],
      });
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: roster});
    if (url.includes('/read-state')) {
      return jsonResponse(200, {
        read_states: [
          {
            channel_id: 'ch-general',
            last_read_seq: 10,
            latest_seq: fixture.latest,
            unread_count: fixture.unread,
            mention_count: fixture.mentions,
          },
        ],
      });
    }
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: fixture.approvals});
    if (url.includes('/agent-runs') || url.includes('/runs')) return jsonResponse(200, {runs: []});
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/reactions')) return jsonResponse(200, {});
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
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
});

// 점은 보조기술에 숨겨 두었다(탭 라벨이 말한다) — 숨은 요소도 찾아야 「없다」 단정이 헛돌지 않는다.
const HIDDEN = {includeHiddenElements: true} as const;
const SETTLE = {timeout: 10_000};
jest.setTimeout(30_000);

describe('셸의 탭 배지 (#3342)', () => {
  it('인박스 알약 = 결정 대기 승인 + 안 읽은 멘션 — 결정된 승인은 세지 않는다', async () => {
    installFetch({
      mentions: 3,
      unread: 5,
      latest: 15,
      approvals: [
        wireApproval(APPROVAL_A),
        wireApproval(APPROVAL_B),
        // 원장이 pending 페이지에 이미 끝난 행을 섞어 보내도 알약은 그것을 세지 않는다.
        wireApproval(APPROVAL_DONE, 'approved'),
      ],
    });
    renderShell();
    await waitFor(
      () => expect(screen.getByTestId('tab-dot-inbox')).toHaveTextContent('5'),
      SETTLE,
    );
    expect(screen.getByTestId('tab-inbox')).toHaveProp(
      'accessibilityLabel',
      '인박스, 나에게 필요한 일 5개',
    );
  });

  it('알약은 인박스 필터 칩 두 수의 합이다 — 같은 합의 두 몫', async () => {
    installFetch({
      mentions: 3,
      unread: 5,
      latest: 15,
      approvals: [wireApproval(APPROVAL_A), wireApproval(APPROVAL_B)],
    });
    renderShell();
    await waitFor(
      () => expect(screen.getByTestId('tab-dot-inbox')).toHaveTextContent('5'),
      SETTLE,
    );
    fireEvent.press(screen.getByTestId('tab-inbox'));
    await waitFor(() => expect(screen.getByTestId('inbox-tab-needs-action')).toBeTruthy(), SETTLE);
    const approvals = Number(
      within(screen.getByTestId('inbox-tab-needs-action')).getByTestId(
        'inbox-tab-count-needs-action',
      ).props.children.props.children,
    );
    const mentions = Number(
      within(screen.getByTestId('inbox-tab-mentions')).getByTestId(
        'inbox-tab-count-mentions',
      ).props.children.props.children,
    );
    expect([approvals, mentions]).toEqual([2, 3]);
    expect(approvals + mentions).toBe(5);
  });

  it('홈 점은 안 읽은 글이 있을 때만 서고, 수를 그리지 않는다', async () => {
    installFetch({mentions: 0, unread: 3, latest: 13, approvals: []});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('tab-unread-home', HIDDEN)).toBeTruthy(), SETTLE);
    expect(screen.getByTestId('tab-home')).toHaveProp(
      'accessibilityLabel',
      '홈, 안 읽은 글 있음',
    );
    // 해야 할 일은 없다: 인박스에는 알약이 없다.
    expect(screen.queryByTestId('tab-dot-inbox')).toBeNull();
  });

  it('다 읽었고 할 일이 없으면 둘 다 없다', async () => {
    installFetch({mentions: 0, unread: 0, latest: 10, approvals: []});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy(), SETTLE);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(screen.queryByTestId('tab-unread-home', HIDDEN)).toBeNull();
    expect(screen.queryByTestId('tab-dot-inbox')).toBeNull();
  });
});

import {DM_LEAVE_KEYS, resetDmLeaveFoldForTest} from '@momo/core/features/channels/dmLeave';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, ActionSheetIOS} from 'react-native';
import {DM_CLOSED_LIST_LABEL} from '@momo/core/features/sidebar/dmVisibility';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {channelDraftKey, readDrafts, saveDraft, threadDraftKey} from '../src/features/conversation/drafts';
import {readFailedSends, rememberFailedSend} from '../src/features/conversation/failedSends';
import {DM_LEAVE_CONFIRM_ARM_MS} from '../src/features/sidebar/useChannelRowActions';
import {parseDmClosedCache} from '../src/features/sidebar/dmClosedCache';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {openConversationMenu} from './fixtures/conversationMenu';
import {installAppClock, SHELL_WAIT_TEST_TIMEOUT_MS} from './fixtures/fakeClock';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// 1:1 「대화 나가기」 — 폰의 세 자리(ADR-0177 증보 2026-11-14 D21·D16·D18, #5826).
//
// 사이드바 행 길게 누르기 시트 · 대화 ⋮ 시트 · 대화 정보 페이지가 **같은 코어 판정·낱말**로 항목을 세우고, 같은 확인 단계와 같은 성공 뒤
// 정리를 지나는지 셸을 통째로 세워 잰다(서버는 가짜 응답). 판정 자체(행렬)는 코어 시험이 잠갔다 — 여기는 그 판정이 화면에 닿는 이음매다.
// 모든 이름은 가상 인물이다(이도현·박서연, 에이전트 달무리 도우미).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const HUMAN_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const HUMAN2_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE = 'https://api.example.com';

const SELF: Member = {id: SELF_ID, workspaceId: WS, kind: 'human', displayName: '이도현', handle: 'dohyun'};

const ko = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog}).formatMessage;

jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

const CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: 'ch-dm-human', workspaceId: WS, kind: 'dm', muted: false, memberIds: [SELF_ID, HUMAN_ID]},
  {id: 'ch-dm-human2', workspaceId: WS, kind: 'dm', muted: false, memberIds: [SELF_ID, HUMAN2_ID]},
  {id: 'ch-dm-agent', workspaceId: WS, kind: 'dm', muted: false, memberIds: [SELF_ID, AGENT_ID]},
  {
    id: 'ch-dm-group',
    workspaceId: WS,
    kind: 'dm',
    muted: false,
    dmKey: 'group:three',
    memberIds: [SELF_ID, HUMAN_ID, HUMAN2_ID],
  },
];

const ROW = {
  general: 'sidebar-row-channel:ch-general',
  human: 'sidebar-row-dm:ch-dm-human',
  human2: 'sidebar-row-dm:ch-dm-human2',
  agent: 'sidebar-row-dm:ch-dm-agent',
  group: 'sidebar-row-dm:ch-dm-group',
} as const;

function rosterMember(over: Record<string, unknown>) {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    role: 'member',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

interface Routes {
  /** 투영 행에 `history_from_seq` 키가 있는가(D21 옛 서버 판별). 기본 참. */
  leaveCarried?: boolean;
  /** 사람 DM 에 안 읽은 글이 있다(숨기기는 안 서고 나가기는 선다). */
  dmUnread?: boolean;
  /** 사람 DM 을 이미 나갔다(투영이 하한을 싣는다: 하한 3 · 숨김 2 · 최신 2). */
  alreadyLeft?: boolean;
  /** 내 예약 목록(그 방 pending+failed 둘, 다른 방 하나). */
  scheduled?: boolean;
  /** `PUT …/dm-leave` 의 응답 상태. 기본 204. */
  leaveStatus?: number;
  /** `PUT …/dm-leave` 가 `releaseHeld()` 전까지 끝나지 않는다. */
  holdLeave?: boolean;
  /** 대화 이력 - 사람 DM 의 글 seq 들(투영 최신 2 보다 높게 줄 수 있다). */
  humanMessages?: number[];
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let held: Array<() => void> = [];
/** 서버가 기억하는 하한: 채널 → history_from_seq. */
let floors = new Map<string, number>();

function releaseHeld(): void {
  const waiting = held;
  held = [];
  for (const resume of waiting) resume();
}

function jsonResponse(status: number, body: unknown): Response {
  return {status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body)} as unknown as Response;
}

const leaveCalls = () => calls.filter(call => call.method === 'PUT' && call.url.endsWith('/dm-leave'));

function readStates(routes: Routes) {
  const human = routes.alreadyLeft
    ? {channel_id: 'ch-dm-human', last_read_seq: 2, latest_seq: 2, unread_count: 0, mention_count: 0}
    : routes.dmUnread
      ? {channel_id: 'ch-dm-human', last_read_seq: 1, latest_seq: 2, unread_count: 1, mention_count: 0}
      : {channel_id: 'ch-dm-human', last_read_seq: 2, latest_seq: 2, unread_count: 0, mention_count: 0};
  const rows = [
    {channel_id: 'ch-general', last_read_seq: 15, latest_seq: 15, unread_count: 0, mention_count: 0},
    human,
    {channel_id: 'ch-dm-human2', last_read_seq: 4, latest_seq: 4, unread_count: 0, mention_count: 0},
    {channel_id: 'ch-dm-agent', last_read_seq: 2, latest_seq: 2, unread_count: 0, mention_count: 0},
    {channel_id: 'ch-dm-group', last_read_seq: 2, latest_seq: 2, unread_count: 0, mention_count: 0},
  ];
  return rows.map(row => {
    const floor = floors.get(row.channel_id);
    const closed = floor === undefined ? null : floor - 1;
    const withClosure = {
      ...row,
      ...(floor === undefined ? null : {last_read_seq: floor - 1, unread_count: 0}),
      latest_readable_seq: row.latest_seq,
      closed_at_seq: closed,
    };
    return routes.leaveCarried === false ? withClosure : {...withClosure, history_from_seq: floor ?? null};
  });
}

function installFetch(routes: Routes = {}) {
  calls = [];
  held = [];
  floors = new Map(routes.alreadyLeft ? [['ch-dm-human', 3]] : []);
  globalThis.fetch = jest.fn(async (url: string, init?: {method?: string; body?: string}) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (method !== 'GET') calls.push({method, url, body});
    const leave = /\/channels\/([^/]+)\/dm-leave$/.exec(url);
    if (leave && method === 'PUT') {
      if (routes.holdLeave) await new Promise<void>(resolve => held.push(resolve));
      const status = routes.leaveStatus ?? 204;
      if (status !== 204) return jsonResponse(status, {error: {message: 'nope'}});
      floors.set(leave[1], Math.max(floors.get(leave[1]) ?? 0, Number(body?.seenSeq) + 1));
      return jsonResponse(204, {});
    }
    if (url.includes('/scheduled-messages')) {
      const row = (id: string, channelId: string, status: string) => ({
        id,
        workspaceId: WS,
        memberId: SELF_ID,
        channelId,
        body: '내일 아침에 보낼 글',
        sendAtMs: 1_900_000_000_000,
        status,
        rev: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      const all = routes.scheduled
        ? [row('s1', 'ch-dm-human', 'pending'), row('s2', 'ch-dm-human', 'failed'), row('s3', 'ch-general', 'pending')]
        : [];
      const wanted = new URL(url).searchParams.get('channelId');
      return jsonResponse(200, {scheduledMessages: all.filter(item => wanted === null || item.channelId === wanted)});
    }
    if (method === 'PUT' && url.includes('/read-state')) {
      return jsonResponse(200, {channel_id: 'ch-general', last_read_seq: body?.last_read_seq, latest_seq: 15, unread_count: 0, mention_count: 0});
    }
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/channels/ch-dm-human/messages')) {
      const seqs = routes.humanMessages ?? [];
      return jsonResponse(200, {
        messages: seqs
          .slice()
          .reverse()
          .map(seq => ({
            id: `m-${seq}`,
            channelId: 'ch-dm-human',
            seq,
            hlcTs: seq,
            hlcCount: 0,
            authorMemberId: HUMAN_ID,
            type: 'text',
            body: `글 ${seq}`,
            state: 'sent',
            createdAtMs: 1_700_000_000_000 + seq,
          })),
      });
    }
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/channels')) return jsonResponse(200, {channels: CHANNELS});
    if (url.includes('/roster')) {
      return jsonResponse(200, {
        members: [
          rosterMember({id: SELF_ID, displayName: '이도현', handle: 'dohyun'}),
          rosterMember({id: HUMAN_ID, displayName: '박서연', handle: 'seoyeon'}),
          rosterMember({id: HUMAN2_ID, displayName: '김도현', handle: 'dohyeon'}),
          rosterMember({id: AGENT_ID, kind: 'agent', displayName: '달무리 도우미', handle: 'dalmuri-helper', ownerHumanId: SELF_ID}),
        ],
      });
    }
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: readStates(routes)});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (url.includes('/liveness')) return jsonResponse(404, {error: {message: 'not found'}});
    if (/\/v1\/workspaces\/[^/]+$/.test(url)) {
      return jsonResponse(200, {workspace: {id: WS, slug: 'dalmuri', name: '달무리 스튜디오', updatedAtMs: 0}});
    }
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

let queryClient: QueryClient | null = null;

async function mountShell(routes: Routes = {}) {
  installFetch(routes);
  queryClient = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}}});
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId(ROW.general)).toBeTruthy());
}

function longPress(testID: string) {
  const row = screen.getByTestId(testID);
  fireEvent(row, 'touchStart', {nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200}});
  fireEvent(row, 'longPress');
  fireEvent(row, 'touchEnd');
}

/** 행 시트를 열고 「대화 나가기」가 설 때까지 기다린다(투영이 와야 판정이 선다). */
async function openRowSheet(testID: string) {
  await waitFor(() => {
    longPress(testID);
    expect(screen.getByTestId('channel-action-sheet')).toBeTruthy();
  });
}

const sheetKeys = (prefix: string) =>
  screen
    .queryAllByTestId(new RegExp(`^${prefix}-(copy-name|copy-link|copy-id|mark-read|mark-unread|mute-toggle|close-dm|leave|leave-dm)$`))
    .map(node => String(node.props.testID).replace(`${prefix}-`, ''));

/** DM 섹션 ⋯ 메뉴(시스템 액션 시트)가 내민 항목들. 「숨긴 대화」 문은 숨긴 대화가 하나라도 있을 때만 선다. */
function dmSectionMenuOptions(): string[] {
  let offered: string[] = [];
  const spy = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(options => {
    offered = options.options;
  });
  fireEvent.press(screen.getByTestId('home-section-menu-dms'));
  spy.mockRestore();
  return offered;
}

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

let releaseMotion: (() => void) | null = null;
beforeEach(async () => {
  installAppClock();
  releaseMotion = await pinReduceMotion(true);
  mmkvStore.clear();
  resetDmLeaveFoldForTest();
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
  releaseHeld();
  cleanup();
  queryClient?.clear();
  queryClient = null;
  releaseMotion?.();
  releaseMotion = null;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const arm = () =>
  act(() => {
    jest.advanceTimersByTime(DM_LEAVE_CONFIRM_ARM_MS);
  });

describe('행 시트 — 누구에게 서는가 (D20·D21, 코어 `dmLeaveOffered`)', () => {
  it('사람과의 1:1: 맨 아래 「대화 나가기」가 따로 선 카드에 서고, 안 읽음이 있어도 선다(숨기기는 안 선다)', async () => {
    await mountShell({dmUnread: true});
    await waitFor(() => {
      longPress(ROW.human);
      expect(sheetKeys('channel-sheet')).toContain('leave-dm');
    });
    const keys = sheetKeys('channel-sheet');
    expect(keys[keys.length - 1]).toBe('leave-dm');
    expect(keys).not.toContain('close-dm');
    expect(screen.getByTestId('channel-sheet-leave-dm')).toHaveTextContent(ko(DM_LEAVE_KEYS.action));
  });

  it('에이전트 DM · 그룹 DM · 채널에는 서지 않는다', async () => {
    await mountShell();
    // 사람 DM 에 서는 것을 먼저 보아 투영이 준비됐음을 안다 — 그 뒤의 「없음」이 늦어서 없는 것이 아니다.
    await waitFor(() => {
      longPress(ROW.human);
      expect(sheetKeys('channel-sheet')).toContain('leave-dm');
    });
    for (const row of [ROW.agent, ROW.group, ROW.general]) {
      fireEvent.press(screen.getByTestId('channel-sheet-close'));
      await waitFor(() => expect(screen.queryByTestId('channel-action-sheet')).toBeNull());
      longPress(row);
      expect(screen.getByTestId('channel-action-sheet')).toBeTruthy();
      expect(sheetKeys('channel-sheet')).not.toContain('leave-dm');
    }
  });

  it('옛 서버(투영 행에 `history_from_seq` 칸이 없다)에서는 메뉴 항목이 아예 없다', async () => {
    await mountShell({leaveCarried: false});
    await waitFor(() => {
      longPress(ROW.human);
      // 같은 투영이 싣는 닫기가 서면 투영은 준비된 것이다.
      expect(sheetKeys('channel-sheet')).toContain('close-dm');
    });
    expect(sheetKeys('channel-sheet')).not.toContain('leave-dm');
  });
});

describe('행 시트 — 확인 단계 (D21)', () => {
  it('문장은 코어 사전의 D21 그대로이고 예약 줄은 그 방의 pending+failed 를 센다 · 「취소」가 앞에 선다', async () => {
    await mountShell({scheduled: true});
    await openRowSheet(ROW.human);
    await waitFor(() => expect(screen.getByTestId('channel-sheet-leave-dm')).toBeTruthy());
    fireEvent.press(screen.getByTestId('channel-sheet-leave-dm'));
    const step = await screen.findByTestId('channel-dm-leave-confirm');
    expect(within(step).getByTestId('channel-dm-leave-confirm-headline')).toHaveTextContent(
      ko(DM_LEAVE_KEYS.confirmTitle, {name: '박서연'}),
    );
    expect(screen.getByTestId('channel-dm-leave-confirm-detail')).toHaveTextContent(
      [
        ko(DM_LEAVE_KEYS.confirmBody, {name: '박서연'}),
        ko(DM_LEAVE_KEYS.confirmRevive),
        ko(DM_LEAVE_KEYS.confirmFinal),
        ko(DM_LEAVE_KEYS.confirmScheduled, {count: 2}),
      ].join('\n'),
    );
    // 항목 카드는 사라진다.
    expect(screen.queryByTestId('channel-sheet-leave-dm')).toBeNull();
    const buttons = screen.getAllByRole('button').map(node => node.props.accessibilityLabel);
    const cancelAt = buttons.indexOf(ko(DM_LEAVE_KEYS.cancel));
    const confirmAt = buttons.indexOf(ko(DM_LEAVE_KEYS.confirm));
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(confirmAt).toBeGreaterThan(cancelAt);
    // 「취소」는 요청 없이 메뉴로 돌아간다.
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-cancel'));
    expect(screen.getByTestId('channel-sheet-leave-dm')).toBeTruthy();
    expect(leaveCalls()).toHaveLength(0);
  });

  it('예약이 없으면 예약 줄이 없다', async () => {
    await mountShell();
    await openRowSheet(ROW.human);
    await waitFor(() => expect(screen.getByTestId('channel-sheet-leave-dm')).toBeTruthy());
    fireEvent.press(screen.getByTestId('channel-sheet-leave-dm'));
    await screen.findByTestId('channel-dm-leave-confirm');
    expect(screen.getByTestId('channel-dm-leave-confirm-detail')).not.toHaveTextContent(/예약/);
  });

  it('두 번 누름: 단계가 선 직후의 확정 눌림은 받지 않고, 잠깐 뒤의 눌림만 내가 본 seq 로 한 번 보낸다', async () => {
    await mountShell();
    await openRowSheet(ROW.human);
    await waitFor(() => expect(screen.getByTestId('channel-sheet-leave-dm')).toBeTruthy());
    fireEvent.press(screen.getByTestId('channel-sheet-leave-dm'));
    await screen.findByTestId('channel-dm-leave-confirm');
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-button'));
    expect(leaveCalls()).toHaveLength(0);
    await arm();
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-button'));
    await waitFor(() => expect(leaveCalls()).toHaveLength(1));
    expect(leaveCalls()[0].body).toEqual({seenSeq: 2});
  });
});

describe('행 시트 — 성공 뒤 (D21 · D17 기기 줄)', () => {
  it('줄이 목록과 「숨긴 대화」에서 사라지고 영수증이 서며, 그 방의 초안·스레드 초안·못 보낸 글만 지우고 첫 프레임 사본에 적는다', async () => {
    const say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    await mountShell();
    // 그 방과 다른 방의 기기 것들.
    saveDraft(channelDraftKey('ch-dm-human'), '보내지 못한 인사');
    saveDraft(channelDraftKey('ch-dm-human2'), '다른 대화의 초안');
    saveDraft(threadDraftKey('root-other'), '다른 스레드의 답글');
    const pendingRow = (channelId: string, id: string) => ({
      clientMsgId: id,
      channelId,
      authorMemberId: SELF_ID,
      body: '못 보낸 글',
      createdAtMs: 1,
      sinceSeq: null,
      status: 'failed' as const,
    });
    rememberFailedSend(WS, pendingRow('ch-dm-human', 'c-1'), null);
    rememberFailedSend(WS, pendingRow('ch-dm-human2', 'c-2'), null);
    expect(readFailedSends(WS, 'ch-dm-human', SELF_ID)).toHaveLength(1);

    await openRowSheet(ROW.human);
    await waitFor(() => expect(screen.getByTestId('channel-sheet-leave-dm')).toBeTruthy());
    fireEvent.press(screen.getByTestId('channel-sheet-leave-dm'));
    await screen.findByTestId('channel-dm-leave-confirm');
    await arm();
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-button'));

    await waitFor(() => expect(screen.queryByTestId('channel-action-sheet')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId(ROW.human)).toBeNull());
    expect(screen.getByTestId('dm-left-receipt')).toHaveTextContent(ko(DM_LEAVE_KEYS.done));
    expect(say).toHaveBeenCalledWith(ko(DM_LEAVE_KEYS.done));
    // 「숨긴 대화」에도 없다(3a) — 문이 서지 않는다.
    expect(dmSectionMenuOptions()).not.toContain(DM_CLOSED_LIST_LABEL);

    const drafts = readDrafts();
    expect(drafts[channelDraftKey('ch-dm-human')]).toBeUndefined();
    expect(drafts[channelDraftKey('ch-dm-human2')]?.body).toBe('다른 대화의 초안');
    expect(drafts[threadDraftKey('root-other')]?.body).toBe('다른 스레드의 답글');
    expect(readFailedSends(WS, 'ch-dm-human', SELF_ID)).toHaveLength(0);
    expect(readFailedSends(WS, 'ch-dm-human2', SELF_ID)).toHaveLength(1);
    await waitFor(() =>
      expect(parseDmClosedCache(mmkvStore.get(NON_SECRET_KEYS.dmClosedCache))[WS]).toContain('ch-dm-human'),
    );

    // 영수증은 사람이 닫을 때까지 남는다(되돌리기 단추 없음).
    await act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('dm-left-receipt')).toBeTruthy();
  });
});

describe('행 시트 — 실패 (D21)', () => {
  it('서버 오류: 단계 안에서 코어 실패 문장을 말하고 아무것도 바뀌지 않으며, 「나가기」를 다시 누르면 다시 보낸다', async () => {
    await mountShell({leaveStatus: 500});
    await openRowSheet(ROW.human);
    await waitFor(() => expect(screen.getByTestId('channel-sheet-leave-dm')).toBeTruthy());
    fireEvent.press(screen.getByTestId('channel-sheet-leave-dm'));
    await screen.findByTestId('channel-dm-leave-confirm');
    await arm();
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-button'));
    expect(await screen.findByTestId('channel-dm-leave-confirm-error')).toHaveTextContent(ko(DM_LEAVE_KEYS.failed));
    expect(screen.getByTestId(ROW.human)).toBeTruthy();
    expect(screen.queryByTestId('dm-left-receipt')).toBeNull();
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-button'));
    await waitFor(() => expect(leaveCalls()).toHaveLength(2));
  });

  it('진행 중에는 「취소」가 먹지 않고 확정 단추가 잠긴다', async () => {
    await mountShell({holdLeave: true});
    await openRowSheet(ROW.human);
    await waitFor(() => expect(screen.getByTestId('channel-sheet-leave-dm')).toBeTruthy());
    fireEvent.press(screen.getByTestId('channel-sheet-leave-dm'));
    await screen.findByTestId('channel-dm-leave-confirm');
    await arm();
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-button'));
    await waitFor(() => expect(leaveCalls()).toHaveLength(1));
    const confirm = screen.getByTestId('channel-dm-leave-confirm-button');
    expect(confirm.props.accessibilityState).toMatchObject({busy: true, disabled: true});
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-cancel'));
    expect(screen.getByTestId('channel-dm-leave-confirm')).toBeTruthy();
    releaseHeld();
    await waitFor(() => expect(screen.queryByTestId(ROW.human)).toBeNull());
  });

  it('경로 없음(404): 실패 문장 뒤 「취소」하면 그 워크스페이스의 「대화 나가기」가 사라진다(다른 사람 DM 에서도)', async () => {
    await mountShell({leaveStatus: 404});
    await openRowSheet(ROW.human);
    await waitFor(() => expect(screen.getByTestId('channel-sheet-leave-dm')).toBeTruthy());
    fireEvent.press(screen.getByTestId('channel-sheet-leave-dm'));
    await screen.findByTestId('channel-dm-leave-confirm');
    await arm();
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-button'));
    await screen.findByTestId('channel-dm-leave-confirm-error');
    fireEvent.press(screen.getByTestId('channel-dm-leave-confirm-cancel'));
    expect(sheetKeys('channel-sheet')).not.toContain('leave-dm');
    fireEvent.press(screen.getByTestId('channel-sheet-close'));
    await waitFor(() => expect(screen.queryByTestId('channel-action-sheet')).toBeNull());
    longPress(ROW.human2);
    expect(sheetKeys('channel-sheet')).not.toContain('leave-dm');
  });
});

describe('이음매 — 홈 화면이 투영의 하한을 보임 판정에 넘긴다 (D18, 코어 검수 M1)', () => {
  it('이미 나간 대화(하한 3 · 숨김 2 · 최신 2)는 목록에도 「숨긴 대화」에도 없다', async () => {
    await mountShell({alreadyLeft: true});
    await waitFor(() => expect(screen.getByTestId(ROW.human2)).toBeTruthy());
    expect(screen.queryByTestId(ROW.human)).toBeNull();
    // DM 섹션 ⋯ 메뉴에 「숨긴 대화」 문이 없다 — 숨김 행만 보면(7번) 이 대화가 그 목록에 섰다.
    const offered = dmSectionMenuOptions();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain(DM_CLOSED_LIST_LABEL);
  });
});

describe('대화 ⋮ 시트와 정보 페이지 — 같은 판정·낱말·단계', () => {
  it('⋮ 시트: 맨 아래 따로 선 카드에 「대화 나가기」, 확인 → 성공하면 대화가 걷히고 홈에 영수증 · seenSeq 는 이력이 든 가장 큰 seq', async () => {
    await mountShell({humanMessages: [1, 2, 5]});
    fireEvent.press(screen.getByTestId(ROW.human));
    await screen.findByTestId('conversation-menu');
    // 이력의 첫 쪽이 온 뒤(seq 5) — 투영 최신(2)보다 크다.
    await screen.findByText('글 5');
    await waitFor(async () => {
      await openConversationMenu();
      expect(screen.getByTestId('conversation-menu-leave-dm')).toBeTruthy();
    });
    expect(screen.getByTestId('conversation-menu-leave-dm')).toHaveTextContent(ko(DM_LEAVE_KEYS.action));
    fireEvent.press(screen.getByTestId('conversation-menu-leave-dm'));
    await screen.findByTestId('conversation-menu-dm-leave-confirm');
    await arm();
    fireEvent.press(screen.getByTestId('conversation-menu-dm-leave-confirm-button'));
    await waitFor(() => expect(leaveCalls()).toHaveLength(1));
    expect(leaveCalls()[0].body).toEqual({seenSeq: 5});
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(screen.getByTestId('dm-left-receipt')).toHaveTextContent(ko(DM_LEAVE_KEYS.done));
  });

  it('⋮ 시트: 에이전트 DM 에는 없다', async () => {
    await mountShell();
    fireEvent.press(screen.getByTestId(ROW.agent));
    await screen.findByTestId('conversation-menu');
    await waitFor(async () => {
      await openConversationMenu();
      // 같은 투영이 싣는 닫기가 서면 판정은 준비된 것이다.
      expect(screen.getByTestId('conversation-menu-close-dm')).toBeTruthy();
    });
    expect(screen.queryByTestId('conversation-menu-leave-dm')).toBeNull();
  });

  it('정보 페이지: 「대화 나가기」 → 같은 확인 단계 → 성공하면 대화와 페이지가 걷힌다', async () => {
    await mountShell();
    fireEvent.press(screen.getByTestId(ROW.human));
    await screen.findByTestId('conversation-menu');
    await waitFor(async () => {
      await openConversationMenu();
      expect(screen.getByTestId('conversation-menu-leave-dm')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('conversation-menu-info'));
    await screen.findByTestId('conversation-info-page');
    expect(screen.getByTestId('conversation-info-leave-dm')).toHaveTextContent(ko(DM_LEAVE_KEYS.action));
    fireEvent.press(screen.getByTestId('conversation-info-leave-dm'));
    await screen.findByTestId('conversation-info-dm-leave-confirm');
    expect(screen.getByTestId('conversation-info-dm-leave-confirm-headline')).toHaveTextContent(
      ko(DM_LEAVE_KEYS.confirmTitle, {name: '박서연'}),
    );
    await arm();
    fireEvent.press(screen.getByTestId('conversation-info-dm-leave-confirm-button'));
    await waitFor(() => expect(screen.queryByTestId('conversation-pane')).toBeNull());
    expect(leaveCalls()).toHaveLength(1);
    expect(screen.getByTestId('dm-left-receipt')).toBeTruthy();
  });
});

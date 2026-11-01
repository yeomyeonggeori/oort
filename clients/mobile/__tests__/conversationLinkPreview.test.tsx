import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {setLinkPreviewPreference} from '../src/features/conversation/linkPreviewPreference';
import {resetUnfurlImagesForTest} from '../src/features/conversation/unfurlImage';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {installAppClock, SHELL_WAIT_TEST_TIMEOUT_MS} from './fixtures/fakeClock';

// =============================================================================
// #5016: 폰 **채널 화면**이 입력창의 미리보기 ✕를 보내기 요청까지 나르는가. 입력창의 규칙은
// `composerLinkPreview.test.tsx`, 전송 호출은 `useTimelineSuppressUnfurl.test.tsx`·`threadPanelLinkPreview.test.tsx`
// 가 재고, 여기서는 **셸째로 마운트한 채널 화면**의 이음매(`ConversationScreen.onSend` → `useTimeline.send`)를
// `fetch` 에서 잰다: 링크를 쓰고 멈추면 이 채널로 미리보기를 묻고, ✕를 누른 메시지만 `POST …/messages` 본문에
// `suppressUnfurl: true` 가 실리고, 누르지 않은 메시지는 그 키가 없다(요청은 closed-world라 옛 서버는 모르는 키를
// 400으로 거절한다). 서버는 가짜 응답이다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const GENERAL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;
const LINK = 'https://a.example/one';

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
    channelCount: 1,
    channelIds: [GENERAL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];
const CHANNELS = [{id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false}];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let sentBodies: Array<Record<string, unknown>> = [];
let previewChannels: string[] = [];
let sentSeq = 100;

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    // 미리보기와 전송은 둘 다 `POST` 라서 아래의 넓은 경로(`/channels`·`/messages`)보다 먼저 가른다.
    if (url.includes('/unfurl-previews') && init?.method === 'POST') {
      previewChannels.push(/channels\/([^/]+)\/unfurl-previews/.exec(url)?.[1] ?? '');
      return jsonResponse(200, {
        id: 'p-1',
        url: LINK,
        status: 'ok',
        title: 'Title of a.example',
        domain: 'a.example',
      });
    }
    if (url.includes('/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sentBodies.push(body);
      sentSeq += 1;
      return jsonResponse(200, {
        id: `msg-${sentSeq}`,
        channelId: GENERAL,
        seq: sentSeq,
        hlcTs: sentSeq,
        hlcCount: 0,
        authorMemberId: SELF_ID,
        type: 'text',
        body: body.body,
        state: 'sent',
        createdAtMs: BASE_MS + sentSeq * 1000,
      });
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    if (url.includes('/profile')) {
      return jsonResponse(403, {error: {message: 'agent owner required'}});
    }
    if (url.includes('/allowed-models')) return jsonResponse(200, {allowedAgentModels: []});
    if (url.includes('/inbox') || url.includes('/approvals')) {
      return jsonResponse(200, {mentions: [], approvals: [], items: []});
    }
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const centrifugeMock = jest.requireMock('centrifuge') as {__reset: () => void};
const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

let queryClient: QueryClient | null = null;

async function settle(ms = 25) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** 셸을 올리고 #general 을 연다. */
async function openChannel() {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  // 기록이 빈 방은 목록 대신 빈 상태를 그리므로, 방이 열렸다는 신호는 입력창이다.
  await waitFor(() => expect(screen.getByTestId('composer-input')).toBeTruthy());
  await settle();
}

async function writeLinkAndWait() {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('composer-input'), LINK);
  });
  // 입력이 멈춘 뒤 350ms 에 한 번 묻고, 가짜 서버의 답이 카드로 선다.
  await settle(350);
  await settle();
}

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
  await settle();
}

jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

beforeEach(() => {
  installAppClock();
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  sessionPort.applyLogin(LOGIN_BODY);
  sentBodies = [];
  previewChannels = [];
  sentSeq = 100;
  resetUnfurlImagesForTest(async () => 'data:image/png;base64,AAAA');
  setLinkPreviewPreference('compact');
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.useRealTimers();
  resetUnfurlImagesForTest();
});

describe('폰 채널 화면의 링크 미리보기 이음매 (#5016)', () => {
  it('✕를 누른 메시지만 보내기 본문에 억제 필드가 실리고, 다음 메시지는 키가 없다', async () => {
    await openChannel();
    await writeLinkAndWait();
    // 이 채널로 물었고, 카드가 알약 위에 섰다.
    expect(previewChannels).toEqual([GENERAL]);
    expect(screen.getByTestId('composer-link-preview')).toBeTruthy();

    await press('composer-link-preview-dismiss');
    expect(screen.queryByTestId('composer-link-preview')).toBeNull();
    await press('composer-send');
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toMatchObject({body: LINK, suppressUnfurl: true});

    // 같은 링크를 다시 쓰면 카드가 다시 서고(처음부터), 끄지 않고 보내면 그 키가 없다.
    await writeLinkAndWait();
    expect(screen.getByTestId('composer-link-preview')).toBeTruthy();
    await press('composer-send');
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1]).toMatchObject({body: LINK});
    expect(sentBodies[1]).not.toHaveProperty('suppressUnfurl');
  });
});

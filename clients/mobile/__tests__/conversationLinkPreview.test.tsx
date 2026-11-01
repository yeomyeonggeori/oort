import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {setLinkPreviewPreference} from '../src/features/conversation/linkPreviewPreference';
import {resetUnfurlImagesForTest} from '../src/features/conversation/unfurlImage';
import {__resetSpawnPort, registerSpawnPort} from '../src/features/work/ask/spawnPort';
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
//
// #5037: 내 개인 에이전트를 부르는 `@별칭` 글은 `onSend` 가 `useTimeline.send` 가 아니라 `tryPersonalCall` 로 빠진다
// (코어 `callPersonalAgent` 가 메시지를 직접 보낸다). 그 길에서도 ✕가 같은 본문 필드로 닿는지, 그리고 정말 호출
// 길을 탔는지(`POST …/work-spawns` 가 나갔는지)를 같은 셸에서 잰다. 서명(Face ID)만 가짜다.
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

// #5037 — 내 개인 에이전트(로스터)와 그 에이전트를 부를 내 맥(작업 호스트). 이 둘이 있어야 `@my-claude` 글이 호출 길을 탄다.
const MY_AGENT_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const MY_AGENT = {
  id: MY_AGENT_ID,
  workspaceId: WS,
  kind: 'agent',
  status: 'active',
  displayName: 'my-claude',
  handle: 'my-claude',
  channelCount: 1,
  channelIds: [GENERAL],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
  personalAgent: {
    label: '내 Claude Code',
    ownerId: SELF_ID,
    ownerDisplayName: '곽성재',
    harness: 'claude',
    enabled: true,
    mentionable: true,
  },
};
const MY_MAC = {
  id: 'mac-1',
  workspaceId: WS,
  scope: 'member',
  ownerMemberId: SELF_ID,
  type: 'workd',
  displayName: 'MacBook',
  capabilities: {},
  createdAtMs: 1,
  lastSeenAtMs: 10,
  online: true,
  folders: [{id: 'folder-q', displayName: '질문용 폴더', kind: 'question'}],
  defaultFolderId: 'folder-q',
};
const SIGNATURE = {
  deviceKeyId: 'key-1',
  nonce: 'n',
  issuedAtMs: 1,
  expiresAtMs: 2,
  signature: 'c2ln',
  folderId: 'folder-q',
  agentMemberId: MY_AGENT_ID,
};
// Face ID 서명자만 가짜다(`jest.mock` 공장은 `mock` 으로 시작하는 바깥 변수만 읽을 수 있다).
const mockSigner = {sign: jest.fn(async () => SIGNATURE)};
jest.mock('../src/features/work/ask/phoneSpawnPort', () => ({
  ...jest.requireActual('../src/features/work/ask/phoneSpawnPort'),
  lazyPhoneSigner: () => mockSigner,
}));

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
let rosterBody: unknown[] = ROSTER;
let workHostsBody: unknown[] = [];
let spawnBodies: Array<Record<string, unknown>> = [];

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
    if (url.includes('/work-spawns') && init?.method === 'POST') {
      spawnBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse(200, {workControl: {id: 'ctl-1', status: 'pending'}, replayed: false});
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
    if (url.includes('/roster')) return jsonResponse(200, {members: rosterBody});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: workHostsBody});
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
  rosterBody = ROSTER;
  workHostsBody = [];
  spawnBodies = [];
  mockSigner.sign.mockClear();
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
  __resetSpawnPort();
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

  /** `@my-claude <링크>` 를 쓰고, 카드가 서면 ✕를 눌러 보낸다. */
  async function callWithPreviewOff(): Promise<string> {
    rosterBody = [...ROSTER, MY_AGENT];
    registerSpawnPort({wired: true, spawn: async () => ({kind: 'sent', controlId: 'c', replayed: false})});
    const CALL = `@my-claude ${LINK}`;
    await openChannel();
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('composer-input'), CALL);
    });
    await settle(350);
    await settle();
    expect(screen.getByTestId('composer-link-preview')).toBeTruthy();
    await press('composer-link-preview-dismiss');
    await press('composer-send');
    return CALL;
  }

  it('내 개인 에이전트를 부르는 `@별칭` 글도 ✕가 보내기 본문에 실리고, 호출은 그대로 나간다 (#5037)', async () => {
    workHostsBody = [MY_MAC];
    const CALL = await callWithPreviewOff();
    // 호출 길을 탔다: 메시지가 먼저 나가고 그 id를 서명한 호출이 `work-spawns` 로 나간다.
    await waitFor(() => expect(spawnBodies).toHaveLength(1));
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toMatchObject({body: CALL, suppressUnfurl: true});
    expect(mockSigner.sign).toHaveBeenCalledTimes(1);
  });

  it('맥이 꺼져 호출 대신 평범한 전송으로 물러나도 ✕가 같은 본문 필드로 닿고, 서명도 호출도 없다 (#5037)', async () => {
    workHostsBody = [{...MY_MAC, online: false}];
    const CALL = await callWithPreviewOff();
    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]).toMatchObject({body: CALL, suppressUnfurl: true});
    expect(spawnBodies).toEqual([]);
    expect(mockSigner.sign).not.toHaveBeenCalled();
  });
});

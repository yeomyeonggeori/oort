import type {Member, RosterMember} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
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

import {createPhoneSpawnPort} from '../src/features/work/ask/phoneSpawnPort';
import {KEY_NOT_READY_DETAIL} from '../src/features/work/ask/model';
import {__resetSpawnPort, registerSpawnPort} from '../src/features/work/ask/spawnPort';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #3638 — 폰 컴포저 → 개인 에이전트 호출, 화면 끝에서 끝까지 (진짜 셸·진짜 컴포저·진짜 포트).
//
// 가짜는 `fetch`뿐이다. 이 시험은 두 가지를 잡는다.
//   ① 두 번 보내지 않는다 — 호출 경로는 코어가 메시지를 직접 보내므로 `timeline.send`를
//      겸해서 부르면 같은 글이 두 번 간다. 메시지 POST가 **한 번**인지 센다.
//   ② 시뮬레이터와 같은 상황 — Secure Enclave가 없으면(키 저장소가 `unsupported`) 서명하지
//      않고, 메시지는 남고, 「서명 키가 필요해요」 안내가 컴포저 위에 선다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const MATE = '33333333-3333-4333-8333-333333333333';
const MY_AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const THEIR_AGENT = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
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
  } as unknown as RosterMember;
}

function personal(id: string, handle: string, ownerId: string) {
  return rosterMember({
    id,
    kind: 'agent',
    handle,
    displayName: handle,
    personalAgent: {
      label: '내 Claude Code',
      ownerId,
      ownerDisplayName: '누군가',
      harness: 'claude',
      enabled: true,
      mentionable: true,
    },
  });
}

const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'}),
  rosterMember({id: MATE, displayName: '동료', handle: 'mate'}),
  personal(MY_AGENT, 'my-claude', SELF_ID),
  personal(THEIR_AGENT, 'mate-claude', MATE),
];

const HOST = {
  id: 'mac-1',
  workspaceId: WS,
  scope: 'member',
  ownerMemberId: SELF_ID,
  type: 'workd',
  displayName: '성재의 MacBook',
  capabilities: {},
  createdAtMs: 1,
  lastSeenAtMs: 1000,
  online: true,
  folders: [{id: 'folder-q', displayName: '질문용 폴더', kind: 'question'}],
  defaultFolderId: 'folder-q',
};

interface Wire {
  method: string;
  path: string;
  body: unknown;
}
let wire: Wire[];

function reply(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string, init?: {method?: string; body?: string}) => {
    const path = url.replace(BASE, '');
    const method = init?.method ?? 'GET';
    wire.push({method, path, body: init?.body === undefined ? undefined : JSON.parse(init.body)});
    if (path.endsWith('/messages') && method === 'POST') {
      const sent = JSON.parse(init?.body ?? '{}') as {body: string};
      return reply(200, {
        id: 'ffffffff-1111-4111-8111-ffffffffffff',
        workspaceId: WS,
        channelId: 'ch-general',
        seq: 1,
        hlcTs: 1,
        hlcCount: 0,
        authorMemberId: SELF_ID,
        type: 'text',
        body: sent.body,
        createdAtMs: 1,
      });
    }
    if (path.includes('/work-sessions')) return reply(200, {workSessions: []});
    if (path.includes('/work-hosts')) return reply(200, {workHosts: [HOST]});
    if (path.includes('/roster')) return reply(200, {members: ROSTER});
    if (path.includes('/signing-context')) {
      return reply(200, {
        instanceId: 'inst',
        serverTimeMs: 1,
        maxLifetimeMs: 600000,
        maxClockSkewMs: 300000,
        humanControlSignatureRequired: true,
        hostRegisterSignatureRequired: false,
      });
    }
    if (path.includes('/channels') && !path.includes('/messages')) {
      return reply(200, {
        channels: [{id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false}],
      });
    }
    if (path.includes('/read-state')) return reply(200, {read_states: []});
    if (path.includes('/messages')) return reply(200, {messages: []});
    if (path.includes('/approvals')) return reply(200, {approvals: []});
    if (path.includes('/runs')) return reply(200, {runs: []});
    if (path.includes('/pins')) return reply(200, {pins: []});
    return reply(200, {});
  }) as unknown as typeof fetch;
}

let queryClient: QueryClient | null = null;

async function openGeneral() {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
  fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
  await waitFor(() => expect(screen.getByTestId('composer-input')).toBeTruthy());
}

function send(text: string) {
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  fireEvent.press(screen.getByTestId('composer-send'));
}

const posts = (suffix: string) =>
  wire.filter(w => w.method === 'POST' && w.path.endsWith(suffix));

beforeEach(() => {
  wire = [];
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
  installFetch();
  registerSpawnPort(createPhoneSpawnPort());
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  __resetSpawnPort();
});

describe('폰 컴포저 → 개인 에이전트 호출', () => {
  it('내 별칭 멘션은 메시지를 한 번만 보내고, 서명 키가 없으면(시뮬레이터) 호출 없이 키 안내가 선다', async () => {
    await openGeneral();
    send('@my-claude 로그인 버그 봐줘');
    await waitFor(() =>
      expect(screen.getByTestId('personal-call-notice-error')).toHaveTextContent(KEY_NOT_READY_DETAIL),
    );
    expect(posts('/messages')).toHaveLength(1);
    expect(posts('/messages')[0]?.body).toMatchObject({body: '@my-claude 로그인 버그 봐줘'});
    expect(posts('/work-spawns')).toHaveLength(0);
  });

  it('팀원의 별칭 멘션은 평범한 메시지다 — 호출도 안내도 없다', async () => {
    await openGeneral();
    send('@mate-claude 로그인 버그 봐줘');
    await waitFor(() => expect(posts('/messages')).toHaveLength(1));
    expect(posts('/work-spawns')).toHaveLength(0);
    expect(screen.queryByTestId('personal-call-notice-error')).toBeNull();
    expect(screen.queryByTestId('personal-call-notice-info')).toBeNull();
  });

  it('포트가 꽂히지 않은 빌드에서는 내 별칭 멘션도 평범한 메시지다', async () => {
    __resetSpawnPort();
    await openGeneral();
    send('@my-claude 로그인 버그 봐줘');
    await waitFor(() => expect(posts('/messages')).toHaveLength(1));
    expect(wire.filter(w => w.path.includes('/work-hosts') || w.path.includes('/signing-context'))).toEqual([]);
    expect(screen.queryByTestId('personal-call-notice-error')).toBeNull();
  });
});

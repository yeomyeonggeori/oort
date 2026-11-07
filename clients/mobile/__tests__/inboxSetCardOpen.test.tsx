import type {Member} from '@momo/core/lib/api';
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

import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 이모티콘 세트 S4(폰, #5463): 받은함은 계획 카드(`expression.set.plan`)와 세트 카드(`expression.set.create`)에 승인·거부 단추를 세우지 않는다.
// 줄에는 「열기」 하나만 서고(planner 2026-11-07), 누르면 결정 요청이 나가지 않은 채 그 대화가 열린다. 다른 승인(`tool_call`)의 받은함 모습은 그대로다.
// `fetch` 만 가짜다: 행 모델·판정(`approvalOpensOnCard`)·화면은 진짜다. 이 시험은 `inboxApproval.test.tsx` 의 셸 바탕을 그대로 쓴다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const PLAN = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const SET = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa2';
const PLAIN = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa3';
const CHANNEL = 'ch-general';
const BASE = 'https://api.example.com';
const NOW = 1_700_000_000_000;

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
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: KIM_AGENT,
    workspaceId: WS,
    kind: 'agent',
    status: 'active',
    displayName: '김인턴',
    handle: 'kim-intern',
    ownerHumanId: SELF_ID,
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const CHANNELS = [
  {id: CHANNEL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

/** 서버가 올린 행동 승인 한 행: `payload.action.id` 가 열기 판정의 열쇠다. */
function wireAction(id: string, actionId: string) {
  return {
    id,
    workspaceId: WS,
    runId: 'run-1',
    channelId: CHANNEL,
    requestedBy: KIM_AGENT,
    actionType: 'workspace_action',
    payload: {
      run_id: 'run-1',
      action_type: 'workspace_action',
      action: {id: actionId, rows: [], required_role: 'member'},
    },
    status: 'pending',
    expiresAtMs: NOW + 600_000,
    createdAtMs: NOW - 1_000_000,
    requestMessageId: `message-of-${id}`,
  };
}
const wirePlain = () => ({
  id: PLAIN,
  workspaceId: WS,
  runId: 'run-2',
  channelId: CHANNEL,
  requestedBy: KIM_AGENT,
  actionType: 'tool_call',
  payload: {
    run_id: 'run-2',
    action_type: 'tool_call',
    tool_call: {call_id: 'call-1', name: 'work.session.end', arguments: '{}', arguments_json: {}},
    approval_reason: 'irreversible tool',
  },
  status: 'pending',
  expiresAtMs: NOW + 600_000,
  createdAtMs: NOW - 1_000_000,
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const decisions: string[] = [];
function installFetch() {
  const mock = jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/decision')) {
      decisions.push(target);
      return jsonResponse(200, {approvalId: PLAN, status: 'approved'});
    }
    if (target.includes('/approvals')) {
      const status = new URL(target).searchParams.get('status') ?? 'pending';
      return jsonResponse(200, {
        approvals:
          status === 'pending'
            ? [wireAction(PLAN, 'expression.set.plan'), wireAction(SET, 'expression.set.create'), wirePlain()]
            : [],
      });
    }
    if (target.includes('/agent-runs')) return jsonResponse(200, {runs: []});
    if (target.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (target.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (target.includes('/messages')) return jsonResponse(200, {messages: []});
    if (target.includes('/channels')) return jsonResponse(200, {channels: CHANNELS});
    throw new Error(`unrouted request: ${target}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
let queryClient: QueryClient | null = null;
jest.setTimeout(30_000);
const settled = (assertion: () => void) => waitFor(assertion, {timeout: 10_000});

async function openInbox() {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await settled(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('tab-inbox'));
  await settled(() => expect(screen.getByTestId('header-title')).toBeTruthy());
  fireEvent.press(screen.getByTestId('inbox-tab-needs-action'));
  await settled(() => expect(screen.getByTestId(`feed-row-approval:${PLAN}`)).toBeTruthy());
}

beforeEach(() => {
  decisions.length = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => NOW);
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
});

describe('받은함: 이모티콘 세트의 두 카드는 「열기」만 선다', () => {
  it('계획 카드·세트 카드 줄에는 승인·거부가 없고 「열기」 하나가 서며, 다른 승인의 승인·거부는 그대로다', async () => {
    await openInbox();
    for (const id of [PLAN, SET]) {
      await settled(() => expect(screen.getByTestId(`decision-open-approval:${id}`)).toBeTruthy());
      expect(screen.queryByTestId(`inbox-approval-${id}-approve`)).toBeNull();
      expect(screen.queryByTestId(`inbox-approval-${id}-reject`)).toBeNull();
      expect(screen.getByTestId(`decision-open-approval:${id}`).props.accessibilityLabel).toBe('열기');
    }
    // 같은 목록의 다른 승인은 예전 그대로 승인·거부를 세우고 「열기」는 없다.
    await settled(() => expect(screen.getByTestId(`inbox-approval-${PLAIN}-approve`)).toBeTruthy());
    expect(screen.getByTestId(`inbox-approval-${PLAIN}-reject`)).toBeTruthy();
    expect(screen.queryByTestId(`decision-open-approval:${PLAIN}`)).toBeNull();
  });

  it('「열기」를 눌러도 결정 요청은 나가지 않고 그 대화가 열린다', async () => {
    await openInbox();
    await settled(() => expect(screen.getByTestId(`decision-open-approval:${PLAN}`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`decision-open-approval:${PLAN}`));
    await settled(() => expect(screen.getByTestId('conversation-column')).toBeTruthy());
    expect(decisions).toEqual([]);
  });
});

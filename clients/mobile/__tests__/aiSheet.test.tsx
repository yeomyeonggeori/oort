import type {Member, RosterMember} from '@momo/core/lib/api';
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

import {
  aiSheetSections,
  macChip,
  personalAgentRows,
} from '../src/features/ai/aiSheetModel';
import {macState, ownMacs} from '../src/features/work/ask/model';
import {
  __resetSpawnPort,
  registerSpawnPort,
  UNWIRED_SPAWN_PORT,
} from '../src/features/work/ask/spawnPort';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// N10 #3598 — + 메뉴의 「AI」 시트.
//
// ## 무엇이 진짜이고 무엇이 가짜인가
//
// 가짜는 `fetch`(로스터·맥 목록)와 **게이트의 한 칸**(`registerSpawnPort` — 승격 뒤에야
// 진짜 포트가 꽂힌다)뿐이다. 구획 판정·표식·칩·행이 여는 시트는 진짜다.
//
// ## 단정이 각각 무엇을 잡는가 (RED PROOF — 제품 소스를 한 번 틀려서 붉어짐을 봤다)
//
//   ① 옛 행 부재 · AI 한 줄     PlusMenu 항목에 옛 `agents`/`delegate`/`ask-mac`을 되살리면 붉어진다.
//   ② 게이트 꺼짐               `myToolsGateOpen`을 `true`로 고정하면 「내 도구」가 서서 붉어진다.
//   ③ 게이트 켜짐               `aiSheetSections`의 `myTools`를 `false`로 고정하면 붉어진다.
//   ④ 개인 표식 · 맥 칩          `personalAgentRows`의 소유자 비교를 지우면 남의 에이전트가 보여 붉어진다.
//   ⑤ 은퇴 · 비활성 에이전트     `subscriptionRetired` 검사를 지우면 붉어진다.
//   ⑥ 행 선택 → N8 / T6b        `onDelegate`/`onAskMac` 연결을 바꾸면 붉어진다.
//   ⑦ 햅틱                      행 선택의 `haptics.selection()`을 지우거나 두 번 부르면 붉어진다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
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

function personalAgent(
  id: string,
  over: {ownerId?: string; enabled?: boolean; retired?: boolean; label?: string} = {},
) {
  return rosterMember({
    id,
    kind: 'agent',
    displayName: over.label ?? '내 Claude Code',
    handle: `pa-${id.slice(0, 4)}`,
    ...(over.retired === true ? {subscriptionRetired: true} : {}),
    personalAgent: {
      label: over.label ?? '내 Claude Code',
      ownerId: over.ownerId ?? SELF_ID,
      ownerDisplayName: '곽성재',
      harness: 'claude',
      enabled: over.enabled ?? true,
      mentionable: true,
    },
  });
}

const MINE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const RETIRED = 'cccccccc-1111-4111-8111-cccccccccccc';
const OFF = 'dddddddd-1111-4111-8111-dddddddddddd';

const HUMANS = [rosterMember({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'})];

function host(online: boolean, over: Record<string, unknown> = {}) {
  return {
    id: 'mac-1',
    workspaceId: WS,
    scope: 'member',
    ownerMemberId: SELF_ID,
    type: 'workd',
    displayName: '성재의 MacBook',
    capabilities: {},
    createdAtMs: 1,
    lastSeenAtMs: 1000,
    online,
    folders: [],
    defaultFolderId: null,
    ...over,
  };
}

let rosterWire: RosterMember[] = HUMANS;
let hostsWire: unknown[] = [];

function reply(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/work-sessions')) return reply(200, {workSessions: []});
    if (url.includes('/work-hosts')) return reply(200, {workHosts: hostsWire});
    if (url.includes('/roster')) return reply(200, {members: rosterWire});
    if (url.includes('/signing-context')) {
      return reply(200, {
        instanceId: 'inst',
        serverTimeMs: 1,
        maxLifetimeMs: 600000,
        maxClockSkewMs: 300000,
        humanControlSignatureRequired: true,
        hostRegisterSignatureRequired: false,
      });
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return reply(200, {
        channels: [{id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false}],
      });
    }
    if (url.includes('/read-state')) return reply(200, {read_states: []});
    if (url.includes('/messages')) return reply(200, {messages: []});
    if (url.includes('/approvals')) return reply(200, {approvals: []});
    if (url.includes('/agent-runs') || url.includes('/runs')) return reply(200, {runs: []});
    if (url.includes('/pins')) return reply(200, {pins: []});
    if (url.includes('/hosted-agents') || url.includes('/connections')) {
      return reply(200, {connections: []});
    }
    return reply(200, {});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

let queryClient: QueryClient | null = null;

async function renderReady() {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
}

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
  rosterWire = HUMANS;
  hostsWire = [];
  hapticCalls.length = 0;
  __resetSpawnPort();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  __resetSpawnPort();
});

/** 승격 뒤의 모습: 내 맥으로 보내는 길이 꽂혀 있다. */
function wirePort() {
  registerSpawnPort({
    wired: true,
    spawn: async () => ({kind: 'sent', controlId: 'ctl', replayed: false}),
  });
}

async function openAi() {
  fireEvent.press(screen.getByTestId('shell-plus'));
  fireEvent.press(screen.getByTestId('plus-menu-ai'));
  expect(screen.getByTestId('ai-sheet')).toBeTruthy();
}

describe('+ 메뉴 → AI 시트', () => {
  it('+ 메뉴의 AI 줄이 시트를 열고, 옛 AI 행들은 메뉴에 없다', async () => {
    installFetch();
    wirePort(); // 게이트가 열려도 옛 「내 맥에 물어보기」 행은 메뉴에 서지 않는다.
    await renderReady();
    fireEvent.press(screen.getByTestId('shell-plus'));
    for (const gone of ['agents', 'delegate', 'ask-mac']) {
      expect([gone, screen.queryByTestId(`plus-menu-${gone}`) !== null]).toEqual([gone, false]);
    }
    expect(screen.getByTestId('plus-menu-ai')).toHaveProp('accessibilityLabel', 'AI');
    fireEvent.press(screen.getByTestId('plus-menu-ai'));
    expect(screen.queryByTestId('plus-menu')).toBeNull();
    expect(screen.getByTestId('ai-sheet')).toBeTruthy();
  });

  it('시트를 여는 누름은 햅틱 light 한 번이다 (+ 의 한 번과 합쳐 두 번 — 누름 두 번)', async () => {
    installFetch();
    await renderReady();
    fireEvent.press(screen.getByTestId('shell-plus'));
    expect(hapticCalls).toEqual(['impact:light']);
    fireEvent.press(screen.getByTestId('plus-menu-ai'));
    expect(hapticCalls).toEqual(['impact:light', 'impact:light']);
  });
});

describe('구획 노출 조건', () => {
  it('게이트가 꺼져 있으면 「에이전트」만 서고, 로스터에 개인 에이전트가 있어도 안 보인다', async () => {
    rosterWire = [...HUMANS, personalAgent(MINE)];
    hostsWire = [host(true)];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    expect(screen.getByTestId('ai-section-agents')).toBeTruthy();
    expect(screen.getByTestId('ai-row-delegate')).toBeTruthy();
    expect(screen.getByTestId('ai-row-agents')).toBeTruthy();
    expect(screen.queryByTestId('ai-section-tools')).toBeNull();
    expect(screen.queryByTestId('ai-row-ask-mac')).toBeNull();
    expect(screen.queryByTestId('ai-section-personal')).toBeNull();
    expect(screen.queryByTestId('ai-mac-chip')).toBeNull();
  });

  it('게이트가 켜지면 「내 도구」가 서고, 개인 에이전트가 없으면 그 구획은 서지 않는다', async () => {
    wirePort();
    installFetch();
    await renderReady();
    await openAi();
    expect(screen.getByTestId('ai-section-tools')).toBeTruthy();
    expect(screen.getByTestId('ai-row-ask-mac')).toBeTruthy();
    expect(screen.queryByTestId('ai-section-personal')).toBeNull();
  });

  it('게이트가 켜지고 내 개인 에이전트가 있으면 「개인」 표식과 함께 선다', async () => {
    wirePort();
    rosterWire = [...HUMANS, personalAgent(MINE)];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId('ai-section-personal')).toBeTruthy());
    expect(screen.getByTestId(`ai-row-personal-${MINE}`)).toBeTruthy();
    expect(screen.getByTestId(`ai-personal-${MINE}`)).toHaveTextContent('개인');
    expect(within(screen.getByTestId(`ai-row-personal-${MINE}`)).getByText('내 Claude Code')).toBeTruthy();
  });
});

describe('맥 칩', () => {
  it('맥이 켜져 있으면 「내 맥 켜짐」을 내 도구 줄과 개인 에이전트 줄에 단다', async () => {
    wirePort();
    rosterWire = [...HUMANS, personalAgent(MINE)];
    hostsWire = [host(true)];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId('ai-mac-chip')).toBeTruthy());
    expect(screen.getByTestId('ai-mac-chip')).toHaveTextContent('내 맥 켜짐');
    expect(screen.getByTestId(`ai-personal-mac-${MINE}`)).toHaveTextContent('내 맥 켜짐');
  });

  it('맥이 꺼져 있으면 「내 맥 꺼짐」이다 — 줄은 그대로 눌린다 (T6b가 꺼짐을 안내한다)', async () => {
    wirePort();
    rosterWire = [...HUMANS, personalAgent(MINE)];
    hostsWire = [host(false)];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId('ai-mac-chip')).toBeTruthy());
    expect(screen.getByTestId('ai-mac-chip')).toHaveTextContent('내 맥 꺼짐');
    expect(screen.getByTestId(`ai-personal-mac-${MINE}`)).toHaveTextContent('내 맥 꺼짐');
    fireEvent.press(screen.getByTestId('ai-row-ask-mac'));
    expect(screen.getByTestId('ask-mac-sheet')).toBeTruthy();
  });

  it('등록된 맥이 없으면 칩이 없다 — 값이 없는 것을 「꺼짐」으로 말하지 않는다', async () => {
    wirePort();
    hostsWire = [];
    installFetch();
    await renderReady();
    await openAi();
    await waitFor(() => expect(screen.getByTestId('ai-row-ask-mac')).toBeTruthy());
    expect(screen.queryByTestId('ai-mac-chip')).toBeNull();
  });
});

describe('개인 에이전트 거르기', () => {
  it('남의 것 · 꺼진 것 · 은퇴한 것은 숨고, 내 켜진 것만 남는다', async () => {
    wirePort();
    rosterWire = [
      ...HUMANS,
      personalAgent(MINE),
      personalAgent(THEIRS, {ownerId: OTHER_ID, label: '남의 Claude Code'}),
      personalAgent(RETIRED, {retired: true, label: '이전 구독 에이전트'}),
      personalAgent(OFF, {enabled: false, label: '꺼 둔 에이전트'}),
    ];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId(`ai-row-personal-${MINE}`)).toBeTruthy());
    for (const hidden of [THEIRS, RETIRED, OFF]) {
      expect([hidden, screen.queryByTestId(`ai-row-personal-${hidden}`) !== null]).toEqual([
        hidden,
        false,
      ]);
    }
  });

  it('모델: 모양이 다른 personalAgent·비활성 멤버·사람은 없는 것이다', () => {
    const rows = personalAgentRows(
      [
        personalAgent(MINE),
        rosterMember({id: 'x1', kind: 'agent', personalAgent: 'yes'}),
        rosterMember({id: 'x2', kind: 'agent', personalAgent: {label: 'a', ownerId: SELF_ID}}),
        rosterMember({...(personalAgent('x3') as object), status: 'suspended'}),
        rosterMember({...(personalAgent('x4') as object), kind: 'human'}),
        rosterMember({
          id: 'x5',
          kind: 'agent',
          personalAgent: {
            label: '안쪽 은퇴',
            ownerId: SELF_ID,
            harness: 'claude',
            enabled: true,
            subscriptionRetired: true,
          },
        }),
      ],
      SELF_ID,
    );
    expect(rows.map(row => row.id)).toEqual([MINE]);
    expect(rows[0]).toMatchObject({label: '내 Claude Code', harnessLabel: 'Claude Code'});
  });

  it('모델: 구획 판정과 칩 값', () => {
    const one = personalAgentRows([personalAgent(MINE)], SELF_ID);
    expect(aiSheetSections({gateOpen: false, personal: one})).toEqual({
      agents: true,
      myTools: false,
      personal: false,
    });
    expect(aiSheetSections({gateOpen: true, personal: []})).toEqual({
      agents: true,
      myTools: true,
      personal: false,
    });
    expect(aiSheetSections({gateOpen: true, personal: one}).personal).toBe(true);
    expect(macChip(null)).toBeNull();
    expect(macChip(macState([]))).toBeNull();
    expect(macChip(macState(ownMacs([host(true)] as never, SELF_ID)))).toMatchObject({on: true});
    expect(macChip(macState(ownMacs([host(false)] as never, SELF_ID)))).toMatchObject({on: false});
    expect(UNWIRED_SPAWN_PORT.wired).toBe(false);
  });
});

describe('행 선택', () => {
  it('「작업 맡기기」가 N8 시트를 열고 AI 시트를 닫는다 — 햅틱 selection 한 번', async () => {
    installFetch();
    await renderReady();
    await openAi();
    hapticCalls.length = 0;
    fireEvent.press(screen.getByTestId('ai-row-delegate'));
    expect(hapticCalls).toEqual(['selection']);
    expect(screen.queryByTestId('ai-sheet')).toBeNull();
    expect(screen.getByTestId('delegate-sheet')).toBeTruthy();
    // 한 번에 시트 하나 — 다른 쪽이 함께 서 있으면 연결이 섞인 것이다.
    expect(screen.queryByTestId('ask-mac-sheet') !== null).toBe(false);
  });

  it('「내 맥에 물어보기」가 T6b 시트를 연다', async () => {
    wirePort();
    installFetch();
    await renderReady();
    await openAi();
    hapticCalls.length = 0;
    fireEvent.press(screen.getByTestId('ai-row-ask-mac'));
    expect(hapticCalls).toEqual(['selection']);
    expect(screen.queryByTestId('ai-sheet')).toBeNull();
    expect(screen.getByTestId('ask-mac-sheet')).toBeTruthy();
    expect(screen.queryByTestId('delegate-sheet') !== null).toBe(false);
  });

  it('개인 에이전트 줄도 T6b 시트로 이어진다', async () => {
    wirePort();
    rosterWire = [...HUMANS, personalAgent(MINE)];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId(`ai-row-personal-${MINE}`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`ai-row-personal-${MINE}`));
    expect(screen.getByTestId('ask-mac-sheet')).toBeTruthy();
  });

  it('「에이전트 부르기」는 에이전트 목록을 연다', async () => {
    installFetch();
    await renderReady();
    await openAi();
    fireEvent.press(screen.getByTestId('ai-row-agents'));
    expect(screen.queryByTestId('ai-sheet')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('agent-list-pane')).toBeTruthy());
  });
});

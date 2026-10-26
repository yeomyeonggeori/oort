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
import {Dimensions, StyleSheet} from 'react-native';

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
import {GroupRow, GroupSection} from '../src/design/atoms';
import {SHEET_ICONS} from '../src/design/icons';
import {GroupCard} from '../src/design/sheetParts';
import AppShell from '../src/shell/AppShell';
import {describeCloseContract, imageSources} from './fixtures/sheetContract';
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
  over: {ownerId?: string; enabled?: boolean; retired?: boolean; label?: string; harness?: string} = {},
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
      harness: over.harness ?? 'claude',
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

// 시험의 기본 창은 글자 배율 2(큰 글씨)다 — 칩이 오른쪽에 서는 보통 크기의 시험은 배율 1 로 연다(아래 큰 글씨 묶음이 올린다).
const BASE_WINDOW = Dimensions.get('window');
function setFontScale(fontScale: number) {
  const window = {...BASE_WINDOW, fontScale};
  Dimensions.set({window, screen: window});
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
  setFontScale(1);
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  __resetSpawnPort();
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
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
    // 맥 칩은 어느 줄에도 새지 않는다(그려진 칩도, 그 글자도).
    expect(screen.queryByTestId('ai-mac-chip')).toBeNull();
    expect(screen.queryByText(/내 맥 (켜짐|꺼짐)/)).toBeNull();
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
    const row = screen.getByTestId(`ai-row-personal-${MINE}`);
    expect(within(row).getByText('내 Claude Code')).toBeTruthy();
    // 「개인」 표식은 행의 오른쪽 임의 노드(`ListRow trailing`)다 — 행 **안에** 서고 맥이 등록돼 있지 않으면 표식만이다.
    expect(within(row).getByTestId(`ai-personal-${MINE}`)).toHaveTextContent('개인');
    expect(screen.queryByTestId(`ai-personal-mac-${MINE}`)).toBeNull();
    expect(within(row).getByText('Claude Code · 나만 쓸 수 있어요.')).toBeTruthy();
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
    // 칩은 두 줄의 오른쪽 임의 노드이고(#4458 `ListRow trailing`) 글자가 켜짐을 말한다 — 색만으로 말하지 않는다.
    await waitFor(() => expect(screen.getByTestId('ai-mac-chip')).toBeTruthy());
    expect(screen.getByTestId('ai-mac-chip')).toHaveTextContent('내 맥 켜짐');
    expect(screen.getByTestId(`ai-personal-mac-${MINE}`)).toHaveTextContent('내 맥 켜짐');
    expect(within(screen.getByTestId('ai-row-ask-mac')).getByTestId('ai-mac-chip')).toBeTruthy();
    // **그려진** 모양: 켜짐 칩은 채움이 있고(transparent 가 아니다) 점이 있다. 꺼짐 칩은 아래 시험이 채움 없음을 잰다.
    const on = StyleSheet.flatten(screen.getByTestId('ai-mac-chip').props.style);
    expect(on.backgroundColor).not.toBe('transparent');
    expect(on.borderRadius).toBe(999);
  });

  it('칩의 글자는 행의 보조기술 이름에도 들어 있다 — `trailing` 은 기본 이름에 안 들어가므로 이름에 직접 잇는다', async () => {
    wirePort();
    rosterWire = [...HUMANS, personalAgent(MINE)];
    hostsWire = [host(true)];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId('ai-mac-chip')).toBeTruthy());
    // 접었던 때(칩 글자 = 오른쪽 값)의 낭독 「이름, 보조 줄, 값」을 잃지 않는다. 눌리는 행의 이름이 칩 글자를 든다.
    expect(screen.getByTestId('ai-row-ask-mac').props.accessibilityLabel).toBe(
      '내 맥에 물어보기, 내 맥의 Claude Code 같은 도구에 물어보거나 일을 시켜요., 내 맥 켜짐',
    );
    expect(screen.getByTestId(`ai-row-personal-${MINE}`).props.accessibilityLabel).toBe(
      '내 Claude Code, Claude Code · 나만 쓸 수 있어요., 개인, 내 맥 켜짐',
    );
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
    // **그려진** 모양: 꺼짐 칩은 채움이 없다(켜짐과 달리 transparent) — 글자만이 아니라 모양도 다르다.
    expect(StyleSheet.flatten(screen.getByTestId('ai-mac-chip').props.style).backgroundColor).toBe(
      'transparent',
    );
    expect(screen.getByTestId('ai-row-ask-mac').props.accessibilityLabel).toMatch(/, 내 맥 꺼짐$/);
    fireEvent.press(screen.getByTestId('ai-row-ask-mac'));
    await waitFor(() => expect(screen.getByTestId('ask-mac-sheet')).toBeTruthy(), {timeout: 8000});
  });

  it('등록된 맥이 없으면 칩이 없다 — 값이 없는 것을 「꺼짐」으로 말하지 않는다', async () => {
    wirePort();
    hostsWire = [];
    installFetch();
    await renderReady();
    await openAi();
    await waitFor(() => expect(screen.getByTestId('ai-row-ask-mac')).toBeTruthy());
    expect(screen.queryByTestId('ai-mac-chip')).toBeNull();
    expect(within(screen.getByTestId('ai-row-ask-mac')).queryByText(/내 맥 (켜짐|꺼짐)/)).toBeNull();
    // 칩이 없으면 이름에도 칩 글자가 없다(끝에 쉼표가 남지 않는다).
    expect(screen.getByTestId('ai-row-ask-mac').props.accessibilityLabel).toBe(
      '내 맥에 물어보기, 내 맥의 Claude Code 같은 도구에 물어보거나 일을 시켜요.',
    );
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
    expect(aiSheetSections({gateOpen: false, personal: one, appsProvided: false})).toEqual({
      agents: true,
      myTools: false,
      personal: false,
      apps: false,
    });
    expect(aiSheetSections({gateOpen: true, personal: [], appsProvided: false})).toEqual({
      agents: true,
      myTools: true,
      personal: false,
      apps: false,
    });
    expect(
      aiSheetSections({gateOpen: true, personal: one, appsProvided: true}),
    ).toMatchObject({personal: true, apps: true});
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
    // 햅틱은 누르는 순간 동기로 한 번이고, 이동은 시트가 미끄러져 내려간 **뒤**다(#4458) — 누른 순간에는 AI 시트가
    // 아직 서 있고 N8 은 없다.
    expect(hapticCalls).toEqual(['selection']);
    expect(screen.getByTestId('ai-sheet')).toBeTruthy();
    expect(screen.queryByTestId('delegate-sheet')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('delegate-sheet')).toBeTruthy(), {timeout: 8000});
    expect(screen.queryByTestId('ai-sheet')).toBeNull();
    expect(hapticCalls).toEqual(['selection']); // 이동할 때 한 번 더 나지 않는다
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
    expect(screen.getByTestId('ai-sheet')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('ask-mac-sheet')).toBeTruthy(), {timeout: 8000});
    expect(screen.queryByTestId('ai-sheet')).toBeNull();
    expect(screen.queryByTestId('delegate-sheet') !== null).toBe(false);
  });

  it('개인 에이전트 줄은 T6b 시트를 열고, 그 에이전트의 하네스를 미리 고른다', async () => {
    wirePort();
    rosterWire = [...HUMANS, personalAgent(MINE, {harness: 'codex'})];
    hostsWire = [host(true, {folders: [{id: 'fq', displayName: '질문용 폴더', kind: 'question'}], defaultFolderId: 'fq'})];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId(`ai-row-personal-${MINE}`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`ai-row-personal-${MINE}`));
    await waitFor(() => expect(screen.getByTestId('ask-mac-sheet')).toBeTruthy(), {timeout: 8000});
    await waitFor(() => expect(screen.getByTestId('ask-mac-destination-line')).toBeTruthy());
    expect(screen.getByTestId('ask-mac-destination-line').props.children as string).toContain('Codex');
  });

  it('「에이전트 부르기」는 에이전트 목록을 연다', async () => {
    installFetch();
    await renderReady();
    await openAi();
    fireEvent.press(screen.getByTestId('ai-row-agents'));
    await waitFor(() => expect(screen.queryByTestId('ai-sheet')).toBeNull(), {timeout: 8000});
    await waitFor(() => expect(screen.getByTestId('agent-list-pane')).toBeTruthy());
  });
});

// ---- 공용 시트로 (#4458) ------------------------------------------------------------------

describe('AI 시트 — 공용 부품', () => {
  it('구획은 묶음 카드, 줄은 셰브론 행이다 — 옛 GroupSection·GroupRow 는 없고 칩은 행의 오른쪽 노드로 선다', async () => {
    wirePort();
    rosterWire = [...HUMANS, personalAgent(MINE)];
    hostsWire = [host(true)];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId(`ai-row-personal-${MINE}`)).toBeTruthy());
    expect(screen.UNSAFE_queryAllByType(GroupSection)).toHaveLength(0);
    expect(screen.UNSAFE_queryAllByType(GroupRow)).toHaveLength(0);
    // 구획 셋(에이전트·내 도구·개인 에이전트 — 앱 줄은 서버가 플러그인 표면을 실을 때만)이 모두 카드다.
    expect(screen.UNSAFE_getAllByType(GroupCard).length).toBeGreaterThanOrEqual(3);
    // 줄마다 **그려진** 오른쪽 셰브론이 하나씩 있다 — 「다른 곳으로 가는 문」이라는 말이 눈에도 선다.
    for (const id of [
      'ai-row-delegate',
      'ai-row-agents',
      'ai-row-ask-mac',
      `ai-row-personal-${MINE}`,
    ]) {
      expect([id, imageSources(screen.getByTestId(id))]).toEqual([id, [SHEET_ICONS.chevron]]);
    }
    // 구분선은 카드마다 줄 수 − 1 이다: 에이전트 둘 → 1, 내 도구 하나 → 0, 개인 하나 → 0.
    expect(within(screen.getByTestId('ai-section-agents')).getAllByTestId('group-divider')).toHaveLength(1);
    expect(within(screen.getByTestId('ai-section-tools')).queryAllByTestId('group-divider')).toHaveLength(0);
  });

  it('행이 다섯 이하인 문 모음이라 내용 맞춤 단이다 — 큰 단(위 58 에서 바닥까지)이 아니다', async () => {
    installFetch();
    await renderReady();
    await openAi();
    const sheet = StyleSheet.flatten(screen.getByTestId('page-sheet').props.style);
    expect(sheet.top).toBeUndefined();
    expect(sheet.maxHeight).toBeGreaterThan(0);
  });
});

// ---- 큰 글씨: 표식은 오른쪽 칩이 아니라 보조 줄 아래로 (design-review AX5·SE) -----------------------------------------------
//
// 오른쪽 칩이 폭을 먹으면 이름 칸이 한 글자 폭으로 접혀 「에/물/어/보/기」로 세로로 쌓였다(AX5·SE 캡처). 이름 아래로 내리는
// 문턱은 홈 카드·사이드바와 같은 `STACK_PILL_SCALE`(1.5)이다. Jest 는 레이아웃이 없어 **렌더된 구조**(칩 노드가 그려지는가,
// 글자가 보조 줄에 서는가)와 보조기술 이름이 같은지를 잰다 — 폭이 정말 안 접히는지는 AX5 캡처가 잰다.

describe('AI 시트 — 큰 글씨에서 표식이 보조 줄 아래로 내려간다 (#4458)', () => {
  async function openWithMac(fontScale: number) {
    setFontScale(fontScale);
    wirePort();
    rosterWire = [...HUMANS, personalAgent(MINE)];
    hostsWire = [host(true)];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId(`ai-row-personal-${MINE}`)).toBeTruthy());
  }

  it.each([[1], [1.3], [1.49]])('글자 배율 %s: 칩과 「개인」 표식은 행 오른쪽의 그려진 노드다', async scale => {
    await openWithMac(scale);
    await waitFor(() => expect(screen.getByTestId('ai-mac-chip')).toBeTruthy());
    expect(screen.getByTestId(`ai-personal-${MINE}`)).toHaveTextContent('개인');
    expect(screen.getByTestId(`ai-personal-mac-${MINE}`)).toHaveTextContent('내 맥 켜짐');
  });

  it.each([[1.5], [2], [3.1]])(
    '글자 배율 %s: 칩 노드는 그려지지 않고 그 글자가 보조 줄 아래 제 줄로 서며, 행 이름은 그대로다',
    async scale => {
      await openWithMac(scale);
      await waitFor(() => expect(screen.getByTestId('ai-row-ask-mac')).toBeTruthy());
      // 오른쪽 노드가 없다 — 이름 칸이 폭을 지킨다.
      expect(screen.queryByTestId('ai-mac-chip')).toBeNull();
      expect(screen.queryByTestId(`ai-personal-${MINE}`)).toBeNull();
      expect(screen.queryByTestId(`ai-personal-mac-${MINE}`)).toBeNull();
      // 상태 글자는 보조 줄 아래에 남는다(글자가 상태를 말한다).
      expect(screen.getByTestId('ai-row-ask-mac')).toHaveTextContent(/시켜요\.\s*내 맥 켜짐/);
      expect(screen.getByTestId(`ai-row-personal-${MINE}`)).toHaveTextContent(/나만 쓸 수 있어요\.\s*개인 · 내 맥 켜짐/);
      // 보조기술 이름은 배율과 무관하게 같다.
      expect(screen.getByTestId('ai-row-ask-mac').props.accessibilityLabel).toBe(
        '내 맥에 물어보기, 내 맥의 Claude Code 같은 도구에 물어보거나 일을 시켜요., 내 맥 켜짐',
      );
      expect(screen.getByTestId(`ai-row-personal-${MINE}`).props.accessibilityLabel).toBe(
        '내 Claude Code, Claude Code · 나만 쓸 수 있어요., 개인, 내 맥 켜짐',
      );
    },
  );

  it('큰 글씨에서 맥이 등록되지 않았으면 「개인」 표식만 보조 줄 아래에 선다', async () => {
    setFontScale(2);
    wirePort();
    rosterWire = [...HUMANS, personalAgent(MINE)];
    hostsWire = [];
    installFetch();
    await renderReady();
    await waitFor(() => expect(queryClient?.getQueryData(['roster', WS])).toBeTruthy());
    await openAi();
    await waitFor(() => expect(screen.getByTestId(`ai-row-personal-${MINE}`)).toBeTruthy());
    expect(screen.getByTestId(`ai-row-personal-${MINE}`)).toHaveTextContent(/나만 쓸 수 있어요\.\s*개인$/);
    expect(screen.getByTestId(`ai-row-personal-${MINE}`).props.accessibilityLabel).toBe(
      '내 Claude Code, Claude Code · 나만 쓸 수 있어요., 개인',
    );
  });
});

describeCloseContract({
  name: 'AiSheet',
  open: async () => {
    installFetch();
    await renderReady();
    await openAi();
  },
  closedCount: () => (screen.queryByTestId('ai-sheet') === null ? 1 : 0),
  closeTestID: 'ai-close',
  closeLabel: 'AI 닫기',
  scrimTestID: 'page-sheet-scrim',
  scrimLabel: 'AI 닫기',
});

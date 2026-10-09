import type {Member} from '@momo/core/lib/api';
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

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  defaultHarness,
  findSpawnedSession,
  labelFromPrompt,
  ownMacs,
  promptIssue,
  signingBlock,
} from '../src/features/work/ask/model';
import {
  type SpawnOutcome,
  type SpawnPort,
  type SpawnRequest,
} from '../src/features/work/ask/spawnPort';
import {SessionProvider} from '../src/session/useSession';
import {AskMacSheet} from '../src/shell/AskMacSheet';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {NON_SECRET_KEYS, nonSecretStore} from '../src/storage/kv';

// =============================================================================
// #3597 T6b — 폰 「내 맥에 보내기」 시트.
//
// ## 무엇을 가짜로 두는가
//
// 둘이다. `fetch`(서버가 무엇을 답했는가)와 **보내기 포트**(Face ID + `/work-spawns`는 engine
// 승격 뒤에야 이 트리에 있다 — `spawnPort.ts` 머리). 시트·후보 판정·기본값·세션 찾기는 진짜다.
// 그래서 아래 단정은 포트가 **받은 요청**과 **불리지 않았음**을 읽는다.
//
// ## 단정이 각각 무엇을 잡는가 (RED PROOF — 제품 소스를 한 번 틀려서 붉어짐을 봤다)
//
//   ① 도착지 문구        `destinationLine`의 가운데점 순서/하네스 이름을 바꾸면 붉어진다.
//   ② 맥 꺼짐 막힘+제안   `macState`의 `online` 걸러내기를 지우면(꺼진 맥도 폼) 붉어진다.
//   ③ 마지막 하네스       `defaultHarness`가 `last`를 무시하면 붉어진다.
//   ④ 폴더 기본값         `defaultFolderId`의 물어보기 분기를 프로젝트 폴더로 바꾸면 붉어진다.
//   ⑤ 전송 뒤 N3          `findSpawnedSession`의 `before` 제외를 지우면(옛 세션) 붉어진다.
//   ⑥ 과금 단정 부재      시트 문장에 「내 구독으로 실행돼요」를 넣으면 붉어진다.
//   ⑦ 서명 요구 꺼짐      `signingBlock`의 `flagRequired === false` 분기를 지우면 붉어진다.
// =============================================================================

jest.mock('../src/lib/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    light: jest.fn(),
    medium: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  },
}));

let mockKeyKind = 'approved';
jest.mock('../src/features/deviceKey/useDeviceKey', () => ({
  useDeviceKey: () => ({
    view: {kind: mockKeyKind},
    enroll: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
    busy: false,
    failure: null,
  }),
}));

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';
const CH_DEV = '44444444-4444-4444-8444-444444444441';
const CH_PRIV = '44444444-4444-4444-8444-444444444442';
const CH_DM = '44444444-4444-4444-8444-444444444443';
const MAC = '55555555-5555-4555-8555-555555555551';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

const CHANNELS = [
  {id: CH_DEV, workspaceId: WS, kind: 'public', name: '개발', muted: false},
  {id: CH_PRIV, workspaceId: WS, kind: 'private', name: '비밀', muted: false},
  {id: CH_DM, workspaceId: WS, kind: 'dm', muted: false},
];

function hostWire(over: Record<string, unknown> = {}) {
  return {
    id: MAC,
    workspaceId: WS,
    scope: 'member',
    ownerMemberId: SELF_ID,
    type: 'workd',
    displayName: '성재의 MacBook',
    capabilities: {},
    createdAtMs: 1,
    lastSeenAtMs: 1000,
    online: true,
    folders: [
      {id: 'fld_question', displayName: '질문용 폴더', kind: 'question'},
      {id: 'fld_app', displayName: 'oort-app', kind: 'project'},
      {id: 'fld_docs', displayName: 'docs', kind: 'project'},
    ],
    defaultFolderId: 'fld_question',
    ...over,
  };
}

function reply(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function sessionWire(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-old',
    workspaceId: WS,
    channelId: CH_DEV,
    memberId: SELF_ID,
    hostId: MAC,
    rootMessageId: 'root-1',
    tool: 'claude',
    label: '옛 질문',
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: 1,
    ...over,
  };
}

function installFetch(options: {
  hosts?: unknown[];
  /** 호출 순서대로 답하는 세션 목록들(마지막이 계속 쓰인다). */
  sessions?: unknown[][];
  signatureRequired?: boolean | 'error';
}) {
  const answers = [...(options.sessions ?? [[]])];
  const mock = jest.fn(async (url: string) => {
    const target = String(url);
    if (target.endsWith('/channels')) return reply(200, {channels: CHANNELS});
    if (target.endsWith('/work-hosts')) {
      return reply(200, {workHosts: options.hosts ?? [hostWire()]});
    }
    if (target.endsWith('/work-sessions')) {
      const next = answers.length > 1 ? answers.shift() : answers[0];
      return reply(200, {workSessions: next ?? []});
    }
    if (target.endsWith('/signing-context')) {
      if (options.signatureRequired === 'error') return reply(500, {error: {}});
      return reply(200, {
        instanceId: 'inst',
        serverTimeMs: 1,
        maxLifetimeMs: 600000,
        maxClockSkewMs: 300000,
        humanControlSignatureRequired: options.signatureRequired ?? true,
        hostRegisterSignatureRequired: false,
      });
    }
    throw new Error(`unrouted request: ${target}`);
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

function fakePort(outcome: SpawnOutcome | (() => SpawnOutcome) = {
  kind: 'sent',
  controlId: 'ctl-1',
  replayed: false,
}) {
  const requests: SpawnRequest[] = [];
  const port: SpawnPort = {
    wired: true,
    spawn: jest.fn(async (request: SpawnRequest) => {
      requests.push(request);
      return typeof outcome === 'function' ? outcome() : outcome;
    }),
  };
  return {port, requests};
}

function mount(port: SpawnPort, extra: {waitTimeoutMs?: number} = {}) {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {gcTime: 0}},
  });
  const handlers = {
    onClose: jest.fn(),
    onUseAgent: jest.fn(),
    onOpenSession: jest.fn(),
    onOpenWorkList: jest.fn(),
  };
  const view = render(
    <QueryClientProvider client={client}>
      <SessionProvider member={SELF}>
        <AskMacSheet port={port} {...handlers} {...extra} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return {...handlers, unmount: () => view.unmount()};
}

async function pickChannelAndType(text = '이 에러가 무슨 뜻이야?') {
  fireEvent.press(await screen.findByTestId('ask-mac-channel-개발'));
  fireEvent.changeText(screen.getByTestId('ask-mac-prompt'), text);
}

const destinationText = () =>
  screen.getByTestId('ask-mac-destination-line').props.children as string;

beforeEach(async () => {
  jest.clearAllMocks();
  mockKeyKind = 'approved';
  __resetSessionStore();
  __resetServerBaseCache();
  nonSecretStore().remove(NON_SECRET_KEYS.askMacLast);
  await setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('① 도착지는 항상 「내 맥 · <기기> · <하네스>」', () => {
  it('맥이 켜져 있으면 입력 전에 그 한 줄이 서고, 하네스를 바꾸면 따라 바뀐다', async () => {
    installFetch({});
    mount(fakePort().port);
    await screen.findByTestId('ask-mac-form');
    expect(destinationText()).toBe('내 맥 · 성재의 MacBook · Claude Code');
    fireEvent.press(screen.getByTestId('ask-mac-harness-codex'));
    expect(destinationText()).toBe('내 맥 · 성재의 MacBook · Codex');
  });

  it('맥이 꺼져 있어도 도착지 줄은 서 있다(기기 이름과 꺼짐)', async () => {
    installFetch({hosts: [hostWire({online: false})]});
    mount(fakePort().port);
    await screen.findByTestId('ask-mac-off');
    expect(destinationText()).toBe('내 맥 · 성재의 MacBook · 꺼져 있음');
  });
});

describe('② 맥이 꺼져 있으면 보내기가 막히고 에이전트만 제안한다', () => {
  it('폼도 보내기 버튼도 없고, 포트는 불리지 않으며, 제안은 사람이 눌러야 한다', async () => {
    installFetch({hosts: [hostWire({online: false})]});
    const {port} = fakePort();
    const handlers = mount(port);
    await screen.findByText('내 맥이 꺼져 있어요');
    expect(screen.queryByTestId('ask-mac-send')).toBeNull();
    expect(screen.queryByTestId('ask-mac-prompt')).toBeNull();
    expect(port.spawn).not.toHaveBeenCalled();
    // 대기 요청 문구가 없다.
    expect(screen.getByText(/기다렸다가 보내지 않아요/)).toBeTruthy();
    // 자동 전환이 아니다: 누르기 전에는 에이전트 시트로 가지 않았다.
    expect(handlers.onUseAgent).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('ask-mac-use-agent'));
    expect(handlers.onUseAgent).toHaveBeenCalledTimes(1);
    expect(port.spawn).not.toHaveBeenCalled();
  });

  it('등록된 내 맥이 없어도 같은 말과 같은 제안이다(남의 맥·팀 맥은 내 맥이 아니다)', async () => {
    installFetch({
      hosts: [
        hostWire({ownerMemberId: OTHER_ID}),
        hostWire({id: 'team', scope: 'workspace'}),
        hostWire({id: 'gone', revokedAtMs: 5}),
      ],
    });
    mount(fakePort().port);
    await screen.findByText('내 맥이 꺼져 있어요');
    expect(screen.getByTestId('ask-mac-destination-line').props.children).toBe(
      '내 맥 · 연결 안 됨',
    );
    expect(screen.getByTestId('ask-mac-use-agent')).toBeTruthy();
  });
});

describe('③ 하네스는 마지막에 쓴 것이 기본이다', () => {
  it('Codex로 보낸 뒤 다시 열면 Codex가 미리 서 있다', async () => {
    installFetch({});
    const {port, requests} = fakePort();
    const first = mount(port, {waitTimeoutMs: 60_000});
    await screen.findByTestId('ask-mac-form');
    fireEvent.press(screen.getByTestId('ask-mac-harness-codex'));
    await pickChannelAndType();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-mac-send'));
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.tool).toBe('codex');

    first.unmount();
    installFetch({});
    mount(fakePort().port);
    await screen.findByTestId('ask-mac-form');
    expect(destinationText()).toBe('내 맥 · 성재의 MacBook · Codex');
  });

  it('순수 규칙: 기억한 하네스가 이 맥에 없으면 첫째', () => {
    expect(defaultHarness(['claude', 'codex'], 'codex')).toBe('codex');
    expect(defaultHarness(['claude', 'codex'], 'opencode')).toBe('claude');
    expect(defaultHarness(['claude', 'codex'], null)).toBe('claude');
  });

  it('OpenCode는 맥이 감지했다고 알릴 때만 나온다', async () => {
    installFetch({});
    const first = mount(fakePort().port);
    await screen.findByTestId('ask-mac-form');
    expect(screen.queryByTestId('ask-mac-harness-opencode')).toBeNull();

    first.unmount();
    installFetch({hosts: [hostWire({capabilities: {opencode: true}})]});
    mount(fakePort().port);
    expect(await screen.findByTestId('ask-mac-harness-opencode')).toBeTruthy();
  });
});

describe('④ 폴더 기본값: 물어보기는 질문용 폴더, 없으면 조용히 대신하지 않는다', () => {
  it('물어보기는 질문용 폴더 id로, 작업 요청은 고른 프로젝트 폴더 id로 나간다', async () => {
    installFetch({});
    const {port, requests} = fakePort();
    mount(port, {waitTimeoutMs: 60_000});
    await screen.findByTestId('ask-mac-form');
    expect(screen.getByTestId('ask-mac-folder-line')).toBeTruthy();
    await pickChannelAndType();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-mac-send'));
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      hostId: MAC,
      folderId: 'fld_question',
      tool: 'claude',
      channelId: CH_DEV,
      label: '이 에러가 무슨 뜻이야?',
    });
  });

  it('작업 요청은 프로젝트 폴더를 고르기 전에는 보낼 수 없다', async () => {
    installFetch({});
    const {port, requests} = fakePort();
    mount(port, {waitTimeoutMs: 60_000});
    await screen.findByTestId('ask-mac-form');
    fireEvent.press(screen.getByTestId('ask-mac-mode-work'));
    await pickChannelAndType('로그인 버그를 고쳐 줘');
    expect(screen.getByTestId('ask-mac-send')).toBeDisabled();
    expect(screen.queryByTestId('ask-mac-folder-fld_question')).toBeNull();
    fireEvent.press(screen.getByTestId('ask-mac-folder-fld_app'));
    fireEvent.press(screen.getByTestId('ask-mac-channel-개발'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-mac-send'));
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.folderId).toBe('fld_app');
  });

  it('서버가 질문용 폴더를 알리지 않으면 프로젝트 폴더로 대신하지 않고 고르게 한다', async () => {
    installFetch({hosts: [hostWire({defaultFolderId: undefined})]});
    const {port} = fakePort();
    mount(port);
    await screen.findByTestId('ask-mac-form');
    expect(screen.getByTestId('ask-mac-folders')).toBeTruthy();
    await pickChannelAndType();
    expect(screen.getByTestId('ask-mac-send')).toBeDisabled();
  });
});

describe('⑤ 전송 뒤에는 내 요청이 만든 세션의 N3 화면으로 간다', () => {
  it('보내기 전에 있던 세션은 건너뛰고, 새로 생긴 내 세션 하나로 간다', async () => {
    installFetch({
      sessions: [
        [sessionWire()],
        [sessionWire()],
        [
          sessionWire(),
          sessionWire({id: 'sess-new', label: '이 에러가 무슨 뜻이야?'}),
        ],
      ],
    });
    const {port} = fakePort();
    const handlers = mount(port, {waitTimeoutMs: 60_000});
    await screen.findByTestId('ask-mac-form');
    await pickChannelAndType();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-mac-send'));
    });
    await screen.findByTestId('ask-mac-waiting');
    await waitFor(() => expect(handlers.onOpenSession).toHaveBeenCalledWith('sess-new'), {
      timeout: 6000,
    });
    expect(handlers.onOpenWorkList).not.toHaveBeenCalled();
  });

  it('세션이 정해지지 않으면 엉뚱한 세션을 열지 않고 작업 목록으로 간다', async () => {
    installFetch({sessions: [[sessionWire()]]});
    const handlers = mount(fakePort().port, {waitTimeoutMs: 150});
    await screen.findByTestId('ask-mac-form');
    await pickChannelAndType();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-mac-send'));
    });
    await waitFor(() => expect(handlers.onOpenWorkList).toHaveBeenCalledTimes(1));
    expect(handlers.onOpenSession).not.toHaveBeenCalled();
  });

  it('순수 규칙: 보내기 전부터 있던 세션·남의 세션·다른 채널·둘 이상은 고르지 않는다', () => {
    const want = {selfId: SELF_ID, hostId: MAC, channelId: CH_DEV, label: 'q'};
    const mk = (over: Record<string, string>) => ({
      id: 'a',
      memberId: SELF_ID,
      hostId: MAC,
      channelId: CH_DEV,
      label: 'q',
      ...over,
    });
    expect(findSpawnedSession([mk({})], new Set(['a']), want)).toBeNull();
    expect(findSpawnedSession([mk({memberId: OTHER_ID})], new Set(), want)).toBeNull();
    expect(findSpawnedSession([mk({channelId: CH_PRIV})], new Set(), want)).toBeNull();
    expect(findSpawnedSession([mk({}), mk({id: 'b'})], new Set(), want)).toBeNull();
    expect(findSpawnedSession([mk({})], new Set(), want)).toBe('a');
  });
});

describe('⑥ 과금을 단정하지 않는다(#3566 미측정)', () => {
  const BILLING = /구독|과금|요금|비용|무료|내 구독으로 실행/;

  it('켜짐·꺼짐·막힘·거절 어느 판에도 그런 문장이 없다', async () => {
    const seen: string[] = [];
    installFetch({});
    const a = mount(fakePort({kind: 'refused', sentence: '서버가 받지 않았어요.'}).port);
    await screen.findByTestId('ask-mac-form');
    seen.push(JSON.stringify(screen.toJSON()));
    await pickChannelAndType();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-mac-send'));
    });
    await screen.findByTestId('ask-mac-banner');
    seen.push(JSON.stringify(screen.toJSON()));
    a.unmount();

    installFetch({hosts: [hostWire({online: false})]});
    const b = mount(fakePort().port);
    await screen.findByTestId('ask-mac-off');
    seen.push(JSON.stringify(screen.toJSON()));
    b.unmount();

    installFetch({signatureRequired: false});
    mount(fakePort().port);
    await screen.findByTestId('ask-mac-signing');
    seen.push(JSON.stringify(screen.toJSON()));

    expect(seen).toHaveLength(4);
    for (const rendered of seen) expect(rendered).not.toMatch(BILLING);
  });
});

describe('⑦ 서명 요구가 꺼진 서버에서는 Face ID 전에 막고 정직하게 말한다', () => {
  it('서버 플래그가 꺼져 있으면 보내기가 막히고 포트는 불리지 않는다', async () => {
    installFetch({signatureRequired: false});
    const {port} = fakePort();
    mount(port);
    await screen.findByTestId('ask-mac-signing');
    expect(screen.getByText(/아직 내 맥으로 보내는 요청을 받지 않아요/)).toBeTruthy();
    await pickChannelAndType();
    expect(screen.getByTestId('ask-mac-send')).toBeDisabled();
    fireEvent.press(screen.getByTestId('ask-mac-send'));
    expect(port.spawn).not.toHaveBeenCalled();
  });

  it('승인된 서명 키가 없으면 키 안내로 막는다', async () => {
    mockKeyKind = 'unregistered';
    installFetch({});
    const {port} = fakePort();
    mount(port);
    await screen.findByTestId('ask-mac-signing');
    expect(screen.getByText(/지시 서명 키가 아직 준비되지 않았어요/)).toBeTruthy();
    await pickChannelAndType();
    expect(screen.getByTestId('ask-mac-send')).toBeDisabled();
  });

  it('플래그를 읽지 못하면(null) 막지 않고 보내 본다', () => {
    expect(signingBlock(null, 'approved')).toBeNull();
    expect(signingBlock(false, 'approved')).toBe('flag_off');
    expect(signingBlock(true, 'pending')).toBe('key');
  });

  it('보낸 뒤 서버가 403 signed_spawn_disabled로 답하면 같은 안내로 막힌다', async () => {
    installFetch({});
    mount(fakePort({kind: 'flag_off'}).port);
    await screen.findByTestId('ask-mac-form');
    await pickChannelAndType();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-mac-send'));
    });
    await screen.findByTestId('ask-mac-signing');
    expect(screen.getByTestId('ask-mac-send')).toBeDisabled();
  });
});

describe('⑧ 전송 직전에 맥이 꺼지면 조용히 다른 곳으로 보내지 않는다', () => {
  it('mac_off는 안내만 하고 시트는 에이전트로 넘어가지 않는다', async () => {
    installFetch({});
    const handlers = mount(fakePort({kind: 'mac_off'}).port);
    await screen.findByTestId('ask-mac-form');
    await pickChannelAndType();
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-mac-send'));
    });
    await screen.findByText(/보내는 사이에 내 맥이 꺼졌어요/);
    expect(handlers.onUseAgent).not.toHaveBeenCalled();
    expect(handlers.onOpenSession).not.toHaveBeenCalled();
  });
});

describe('보낼 글과 집 채널', () => {
  it('DM은 집 채널 후보에 없고, 채널마다 읽는 범위가 보인다', async () => {
    installFetch({});
    mount(fakePort().port);
    await screen.findByTestId('ask-mac-form');
    expect(screen.getByTestId('ask-mac-channel-개발')).toBeTruthy();
    expect(screen.getByText('이 채널 멤버가 모두 읽어요')).toBeTruthy();
    expect(screen.getByText('비공개 채널 · 이 채널 멤버가 읽어요')).toBeTruthy();
    expect(screen.queryByTestId(`ask-mac-channel-${CH_DM}`)).toBeNull();
  });

  it('채널을 고르기 전에는 보낼 수 없다', async () => {
    installFetch({});
    mount(fakePort().port);
    await screen.findByTestId('ask-mac-form');
    fireEvent.changeText(screen.getByTestId('ask-mac-prompt'), '질문');
    expect(screen.getByTestId('ask-mac-send')).toBeDisabled();
  });

  it('「/」로 시작하는 글은 보내기 전에 막힌다', async () => {
    installFetch({});
    const {port} = fakePort();
    mount(port);
    await screen.findByTestId('ask-mac-form');
    await pickChannelAndType('/compact');
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-mac-send'));
    });
    expect(await screen.findByTestId('ask-mac-issue')).toBeTruthy();
    expect(port.spawn).not.toHaveBeenCalled();
  });

  it('순수 규칙: 글 검사와 제목', () => {
    expect(promptIssue('  ')).not.toBeNull();
    expect(promptIssue('/x')).not.toBeNull();
    expect(promptIssue('a\u0000b')).not.toBeNull();
    expect(promptIssue('줄\n바꿈\t탭')).toBeNull();
    expect(labelFromPrompt('\n  첫   줄 \n둘째')).toBe('첫 줄');
    expect(Array.from(labelFromPrompt('가'.repeat(300))).length).toBe(120);
  });

  it('순수 규칙: 내 맥만 — 남의 호스트·팀 호스트·해지된 호스트는 빠진다', () => {
    const host = (over: Record<string, unknown>) =>
      ({...hostWire(), ...over}) as unknown as Parameters<typeof ownMacs>[0] extends
        | readonly (infer H)[]
        | undefined
        ? H
        : never;
    expect(
      ownMacs(
        [
          host({}),
          host({id: 'o', ownerMemberId: OTHER_ID}),
          host({id: 't', scope: 'workspace'}),
          host({id: 'r', revokedAtMs: 1}),
        ],
        SELF_ID,
      ).map(mac => mac.id),
    ).toEqual([MAC]);
  });
});

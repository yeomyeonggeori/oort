jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
}));

import {callPersonalAgent} from '@momo/core/features/auth/personalAgentCall';
import {
  SignerRefusal,
  type ControlToSign,
  type HumanControlSigner,
} from '@momo/core/features/auth/signedControl';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {
  Channel,
  HumanSignatureRequest,
  Message,
  RosterMember,
  WorkHost,
} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, render, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  CALL_RECEIVED_LINE,
  usePersonalAgentCall,
} from '../src/features/conversation/usePersonalAgentCall';
import {
  personalAgentCallTarget,
  pickDestination,
  runPersonalAgentCall,
  type CallDeps,
} from '../src/features/conversation/personalAgentCallModel';
import {KEY_NOT_READY_DETAIL} from '../src/features/work/ask/model';
import {
  __resetSpawnPort,
  registerSpawnPort,
} from '../src/features/work/ask/spawnPort';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #3638 — 폰 컴포저: 소유자가 `@<내 개인 에이전트>`를 멘션하거나 별칭 DM에 보내면
// 코어 `callPersonalAgent`(메시지 전송 → Face ID v4 서명 → /work-spawns)로 간다.
//
// 가짜: `fetch`(서버)와 서명자(Face ID)뿐이다. 대상 판정·목적지 선택·코어 호출 흐름·실패
// 문장은 진짜다. 코어 호출은 실제 `callPersonalAgent`가 가짜 서버에 대고 돈다.
//
// 단정이 각각 무엇을 잡는가 (RED PROOF — 제품 소스를 한 번 틀려서 붉어짐을 봤다)
//   ① 소유자 멘션만 대상            `personalAgentRows`의 `uuidEq(ownerId, selfId)`를 지우면 남의 별칭도 대상이 되어 붉어진다.
//   ② 팀원 멘션은 spawn 0           ① 위에서 `/work-spawns` POST가 0건임을 센다.
//   ③ 응답 id로 서명                서명이 `originMessageId`로 받는 값이 **서버가 돌려준 메시지 id**여야 한다.
//   ④ 맥 꺼짐·없음은 Face ID 전      `pickDestination`을 지우면 서명자가 불려 붉어진다.
//   ⑤ 사유별 문장                   코어 `callFailureLine`의 문장을 그대로 본다.
//   ⑥ N3 이동                       새 세션이 보이면 `onOpenWorkSession`, 못 찾으면 `onOpenWorkList`.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const ME = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '33333333-3333-4333-8333-333333333333';
const MY_AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const THEIR_AGENT = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const PLAIN_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const CH = 'dddddddd-1111-4111-8111-dddddddddddd';
const DM = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const SENT_ID = 'ffffffff-1111-4111-8111-ffffffffffff';
const BASE = 'https://api.example.com';

function member(fields: Record<string, unknown>): RosterMember {
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

function personal(id: string, handle: string, ownerId: string): RosterMember {
  return member({
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

const MEMBERS: RosterMember[] = [
  member({id: ME, handle: 'seongjae'}),
  member({id: TEAMMATE, handle: 'mate'}),
  personal(MY_AGENT, 'my-claude', ME),
  personal(THEIR_AGENT, 'mate-claude', TEAMMATE),
  member({id: PLAIN_AGENT, kind: 'agent', handle: 'hermes'}),
];

const CHANNEL: Channel = {id: CH, workspaceId: WS, kind: 'public', name: 'general', muted: false};
const MY_DM: Channel = {id: DM, workspaceId: WS, kind: 'dm', muted: false, memberIds: [ME, MY_AGENT]};
const THEIR_DM: Channel = {id: DM, workspaceId: WS, kind: 'dm', muted: false, memberIds: [ME, THEIR_AGENT]};

function mac(over: Partial<WorkHost> = {}): WorkHost {
  return {
    id: 'mac-1',
    workspaceId: WS,
    scope: 'member',
    ownerMemberId: ME,
    type: 'workd',
    displayName: 'MacBook',
    capabilities: {},
    createdAtMs: 1,
    lastSeenAtMs: 10,
    online: true,
    folders: [{id: 'folder-q', displayName: '질문용 폴더', kind: 'question'}],
    defaultFolderId: 'folder-q',
    ...over,
  } as WorkHost;
}

const target = (body: string, channel: Channel | null = CHANNEL, members = MEMBERS) =>
  personalAgentCallTarget({
    body,
    channel,
    directory: makeDirectory(members),
    members,
    selfId: ME,
  });

describe('대상 — 내 개인 에이전트만', () => {
  it('내 별칭 멘션은 대상이다 (등장 순서의 첫 내 별칭)', () => {
    expect(target('@my-claude 로그인 버그 봐줘')).toEqual({
      memberId: MY_AGENT,
      handle: 'my-claude',
      harness: 'claude',
    });
    // 문장 속 언급은 부름이 아니다(Face ID를 올리지 않는다).
    expect(target('이거 @my-claude 가 봐줘')).toBeNull();
  });

  it('팀원의 별칭·일반 에이전트·사람 멘션은 대상이 아니다 — 평범한 메시지다', () => {
    expect(target('@mate-claude 봐줘')).toBeNull();
    expect(target('@hermes 봐줘')).toBeNull();
    expect(target('@mate 봐줘')).toBeNull();
    expect(target('멘션 없음')).toBeNull();
  });

  it('내 별칭과의 DM은 멘션 없이도 대상이고, 팀원 별칭과의 DM은 아니다', () => {
    expect(target('봐줘', MY_DM)?.memberId).toBe(MY_AGENT);
    expect(target('봐줘', THEIR_DM)).toBeNull();
  });

  it('소유자가 내가 아니면(로스터가 다른 소유자로 말하면) 같은 핸들이어도 대상이 아니다', () => {
    const stolen = MEMBERS.map(m => (m.id === MY_AGENT ? personal(MY_AGENT, 'my-claude', TEAMMATE) : m));
    expect(target('@my-claude 봐줘', CHANNEL, stolen)).toBeNull();
  });
});

describe('목적지 — 내 켜진 맥의 질문용 폴더', () => {
  it('켜진 내 맥과 그 맥이 알린 질문용 폴더를 고른다', () => {
    expect(pickDestination([mac()], ME, 'claude')).toEqual({
      kind: 'ok',
      destination: {hostId: 'mac-1', folderId: 'folder-q', tool: 'claude'},
    });
  });

  it('맥 없음·꺼짐·질문용 폴더 없음은 서명 없이 사람 말로 멈춘다', () => {
    expect(pickDestination([], ME, 'claude')).toEqual({
      kind: 'none',
      sentence: '연결된 내 맥을 찾지 못했어요. 데스크탑 앱에서 내 맥을 연결해 주세요.',
    });
    expect(pickDestination([mac({online: false})], ME, 'claude')).toEqual({
      kind: 'none',
      sentence: '내 맥이 꺼져 있어요. 맥을 켠 뒤 다시 불러 주세요.',
    });
    expect(pickDestination([mac({defaultFolderId: undefined})], ME, 'claude')).toEqual({
      kind: 'none',
      sentence: '내 맥이 이 작업 폴더를 허용하고 있지 않아요. 맥 앱에서 폴더를 확인해 주세요.',
    });
  });

  it('남의 맥·팀 맥은 후보가 아니다', () => {
    expect(pickDestination([mac({ownerMemberId: TEAMMATE})], ME, 'claude').kind).toBe('none');
    expect(pickDestination([mac({scope: 'workspace'})], ME, 'claude').kind).toBe('none');
  });
});

// ---- 진짜 코어 호출을 가짜 서버에 대고 ----------------------------------------------

interface Wire {
  method: string;
  path: string;
  body: unknown;
}

let wire: Wire[];
let spawnReply: {status: number; body: unknown};
let sessionsWire: Array<Record<string, unknown>>;

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
    wire.push({
      method: init?.method ?? 'GET',
      path,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
    if (path.endsWith('/messages') && init?.method === 'POST') {
      return reply(200, {
        id: SENT_ID,
        workspaceId: WS,
        channelId: CH,
        seq: 7,
        authorMemberId: ME,
        type: 'text',
        body: (JSON.parse(init.body ?? '{}') as {body: string}).body,
        createdAtMs: 1,
      });
    }
    if (path.endsWith('/work-spawns')) return reply(spawnReply.status, spawnReply.body);
    if (path.endsWith('/work-sessions')) return reply(200, {workSessions: sessionsWire});
    return reply(200, {});
  }) as unknown as typeof fetch;
}

const SIGNATURE: HumanSignatureRequest = {
  deviceKeyId: 'key-1',
  nonce: 'n',
  issuedAtMs: 1,
  expiresAtMs: 2,
  signature: 'c2ln',
  folderId: 'folder-q',
  agentMemberId: MY_AGENT,
};

function fakeSigner(over: {error?: unknown} = {}): HumanControlSigner & {seen: ControlToSign[]} {
  const seen: ControlToSign[] = [];
  return {
    seen,
    sign: async control => {
      seen.push(control);
      if (over.error !== undefined) throw over.error;
      return SIGNATURE;
    },
  };
}

const spawnPosts = () => wire.filter(w => w.path.endsWith('/work-spawns'));
const messagePosts = () => wire.filter(w => w.path.endsWith('/messages') && w.method === 'POST');

function deps(over: Partial<CallDeps> = {}, hosts: WorkHost[] = [mac()]): CallDeps {
  return {
    fetchHosts: async () => hosts,
    fetchSessionIds: async () => ['old-session'],
    call: callPersonalAgent,
    newClientMsgId: () => 'client-msg-1',
    ...over,
  };
}

const MY_TARGET = {memberId: MY_AGENT, handle: 'my-claude', harness: 'claude'};

function runWith(signer: HumanControlSigner, d: CallDeps, body = '@my-claude 로그인 버그 봐줘') {
  return runPersonalAgentCall(
    {workspaceId: WS, channelId: CH, selfId: ME, body, target: MY_TARGET, signer},
    d,
  );
}

beforeEach(() => {
  wire = [];
  spawnReply = {status: 200, body: {workControl: {id: 'ctl-9', status: 'pending'}, replayed: false}};
  sessionsWire = [];
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: {id: ME, workspaceId: WS, kind: 'human', displayName: '곽성재', handle: 'seongjae'},
  });
  installFetch();
});

afterEach(() => {
  cleanup();
  __resetSpawnPort();
});

describe('runPersonalAgentCall — 메시지 → 서명 → /work-spawns', () => {
  it('서버가 돌려준 메시지 id로 서명하고, 그 서명을 /work-spawns에 싣는다', async () => {
    const signer = fakeSigner();
    const run = await runWith(signer, deps());
    expect(run.kind).toBe('sent');
    // 순서: 메시지가 먼저, 호출이 나중.
    expect(wire.filter(w => w.method === 'POST').map(w => w.path.split('/').pop())).toEqual([
      'messages',
      'work-spawns',
    ]);
    expect(signer.seen).toHaveLength(1);
    expect(signer.seen[0]).toMatchObject({
      hostId: 'mac-1',
      content: {
        kind: 'spawn_task',
        agentMemberId: MY_AGENT,
        folderId: 'folder-q',
        tool: 'claude',
        channelId: CH,
        originMessageId: SENT_ID,
        prompt: '로그인 버그 봐줘',
        label: '로그인 버그 봐줘',
      },
    });
    expect(spawnPosts()[0]?.body).toMatchObject({
      tool: 'claude',
      channelId: CH,
      originMessageId: SENT_ID,
      targetHostId: 'mac-1',
      humanSignature: SIGNATURE,
    });
    if (run.kind === 'sent') {
      expect(run.call).toMatchObject({state: 'called', controlId: 'ctl-9'});
      expect(run.wait).toMatchObject({hostId: 'mac-1', channelId: CH, label: '로그인 버그 봐줘'});
      expect([...(run.wait?.before ?? [])]).toEqual(['old-session']);
    }
  });

  it('맥이 꺼져 있으면 Face ID도 메시지 전송도 하지 않고 plain으로 돌려준다', async () => {
    const signer = fakeSigner();
    const run = await runWith(signer, deps({}, [mac({online: false})]));
    expect(run).toEqual({
      kind: 'plain',
      sentence: '내 맥이 꺼져 있어요. 맥을 켠 뒤 다시 불러 주세요.',
      clientMsgId: 'client-msg-1',
    });
    expect(signer.seen).toEqual([]);
    expect(wire).toEqual([]);
  });

  it('서명 키가 없으면 메시지는 가고 호출은 안 가며, 키 안내 문장이 그대로 나온다', async () => {
    const run = await runWith(fakeSigner({error: new SignerRefusal(KEY_NOT_READY_DETAIL)}), deps());
    expect(messagePosts()).toHaveLength(1);
    expect(spawnPosts()).toHaveLength(0);
    expect(run).toMatchObject({
      kind: 'sent',
      wait: null,
      call: {state: 'not_delivered', stage: 'sign', text: KEY_NOT_READY_DETAIL},
    });
  });

  it.each([
    ['work_host_offline', 409, '내 맥이 꺼져 있어요. 맥을 켠 뒤 다시 불러 주세요.'],
    ['signed_spawn_disabled', 403, '이 서버는 아직 내 맥으로 보내는 호출을 받지 않아요.'],
    ['spawn_agent_not_allowed', 403, '이 개인 에이전트는 지금 부를 수 없어요. 켜져 있는지 확인해 주세요.'],
    ['pool_exhausted', 429, '지금 돌릴 수 있는 작업이 가득 찼어요. 끝난 작업이 있으면 다시 불러 주세요.'],
  ])('서버가 %s로 거절하면 코어의 문장 그대로다', async (code, status, text) => {
    spawnReply = {status, body: {error: {code, message: 'x'}}};
    const run = await runWith(fakeSigner(), deps());
    expect(run).toMatchObject({kind: 'sent', call: {state: 'not_delivered', stage: 'server', text}});
  });

  it('Face ID를 접으면 메시지만 남고 취소 문장이 나온다', async () => {
    const cancel = new SignerRefusal('Face ID를 취소해서 보내지 않았어요.', true);
    const run = await runWith(fakeSigner({error: cancel}), deps());
    expect(run).toMatchObject({
      kind: 'sent',
      call: {state: 'not_delivered', text: 'Face ID를 취소해서 보내지 않았어요.'},
    });
    expect(spawnPosts()).toHaveLength(0);
  });

  it('별칭만 보내면 할 일이 없다는 안내이고 서명하지 않는다', async () => {
    const signer = fakeSigner();
    const run = await runWith(signer, deps(), '@my-claude');
    expect(run).toMatchObject({kind: 'sent', call: {state: 'message_only', reason: 'nothing_to_ask'}});
    expect(signer.seen).toEqual([]);
  });

  it('메시지 전송이 실패하면 unsent다 (평범한 전송이 실패 줄과 재시도를 맡는다)', async () => {
    const run = await runWith(
      fakeSigner(),
      deps({call: async () => Promise.reject(new Error('network'))}),
    );
    expect(run).toEqual({kind: 'unsent', clientMsgId: 'client-msg-1'});
  });
});

// ---- 훅: 보내기를 맡는가, N3로 가는가 ---------------------------------------------

interface HookProbe {
  tryCall: (body: string) => boolean;
  notice: {text: string; tone: string} | null;
}

function mountHook(opts: {
  channel?: Channel;
  members?: RosterMember[];
  call?: CallDeps['call'];
  hosts?: WorkHost[];
  waitTimeoutMs?: number;
}) {
  const sendPlain = jest.fn();
  const ingest = jest.fn();
  const onOpenWorkSession = jest.fn();
  const onOpenWorkList = jest.fn();
  const probe: {current: HookProbe | null} = {current: null};
  const members = opts.members ?? MEMBERS;
  const room = {current: opts.channel ?? CHANNEL};
  function Probe() {
    const result = usePersonalAgentCall({
      workspaceId: WS,
      selfId: ME,
      channel: room.current,
      directory: makeDirectory(members),
      members,
      sendPlain,
      ingest,
      onOpenWorkSession,
      onOpenWorkList,
      deps: deps({...(opts.call ? {call: opts.call} : {})}, opts.hosts ?? [mac()]),
      ...(opts.waitTimeoutMs === undefined ? {} : {waitTimeoutMs: opts.waitTimeoutMs}),
    });
    probe.current = result;
    return null;
  }
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  const tree = () => (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
  const view = render(tree());
  const moveTo = (channel: Channel) => {
    room.current = channel;
    view.rerender(tree());
  };
  return {probe, sendPlain, ingest, onOpenWorkSession, onOpenWorkList, moveTo};
}

function wirePort(): void {
  registerSpawnPort({wired: true, spawn: async () => ({kind: 'sent', controlId: 'c', replayed: false})});
}

const mockSignerForHook = fakeSigner();
jest.mock('../src/features/work/ask/phoneSpawnPort', () => ({
  ...jest.requireActual('../src/features/work/ask/phoneSpawnPort'),
  lazyPhoneSigner: () => mockSignerForHook,
}));

describe('usePersonalAgentCall — 컴포저에서', () => {
  beforeEach(() => {
    mockSignerForHook.seen.length = 0;
    wirePort();
  });

  it('팀원의 별칭 멘션·일반 에이전트 멘션은 맡지 않는다 — spawn 요청은 0건', async () => {
    const h = mountHook({});
    expect(h.probe.current?.tryCall('@mate-claude 봐줘')).toBe(false);
    expect(h.probe.current?.tryCall('@hermes 봐줘')).toBe(false);
    expect(h.probe.current?.tryCall('그냥 말')).toBe(false);
    expect(wire).toEqual([]);
    expect(h.sendPlain).not.toHaveBeenCalled();
  });

  it('보내는 길이 이 빌드에 없으면(포트 미등록) 내 별칭 멘션이어도 평범한 메시지다', () => {
    __resetSpawnPort();
    const h = mountHook({});
    expect(h.probe.current?.tryCall('@my-claude 봐줘')).toBe(false);
    expect(wire).toEqual([]);
  });

  it('내 별칭 멘션은 맡고, 보낸 메시지를 타임라인에 합치고, 새 세션이 보이면 N3로 간다', async () => {
    const h = mountHook({});
    let took = false;
    act(() => {
      took = h.probe.current?.tryCall('@my-claude 로그인 버그 봐줘') ?? false;
    });
    expect(took).toBe(true);
    await waitFor(() => expect(h.ingest).toHaveBeenCalledTimes(1));
    expect(h.ingest.mock.calls[0]?.[0]).toMatchObject({id: SENT_ID} satisfies Partial<Message>);
    expect(h.sendPlain).not.toHaveBeenCalled();
    expect(mockSignerForHook.seen[0]?.content).toMatchObject({originMessageId: SENT_ID});
    await waitFor(() => expect(h.probe.current?.notice?.text).toBe(CALL_RECEIVED_LINE));
    expect(h.onOpenWorkSession).not.toHaveBeenCalled();

    sessionsWire = [
      {id: 'old-session', memberId: ME, hostId: 'mac-1', channelId: CH, label: '로그인 버그 봐줘'},
      {id: 'new-session', memberId: ME, hostId: 'mac-1', channelId: CH, label: '로그인 버그 봐줘'},
    ];
    await waitFor(() => expect(h.onOpenWorkSession).toHaveBeenCalledWith('new-session'), {timeout: 6000});
    expect(h.onOpenWorkList).not.toHaveBeenCalled();
  }, 10000);

  it('세션을 못 찾으면 시간이 다 된 뒤 작업 목록으로 간다 (엉뚱한 세션을 열지 않는다)', async () => {
    sessionsWire = [{id: 'old-session', memberId: ME, hostId: 'mac-1', channelId: CH, label: '로그인 버그 봐줘'}];
    const h = mountHook({waitTimeoutMs: 300});
    act(() => {
      h.probe.current?.tryCall('@my-claude 로그인 버그 봐줘');
    });
    await waitFor(() => expect(h.onOpenWorkList).toHaveBeenCalledTimes(1), {timeout: 3000});
    expect(h.onOpenWorkSession).not.toHaveBeenCalled();
  });

  it('맥이 꺼져 있으면 평범한 메시지로 보내고 사유를 말한다 — 서명은 없다', async () => {
    const h = mountHook({hosts: [mac({online: false})]});
    act(() => {
      h.probe.current?.tryCall('@my-claude 봐줘');
    });
    await waitFor(() =>
      expect(h.sendPlain).toHaveBeenCalledWith('@my-claude 봐줘', 'client-msg-1'),
    );
    expect(h.probe.current?.notice).toEqual({
      text: '내 맥이 꺼져 있어요. 맥을 켠 뒤 다시 불러 주세요.',
      tone: 'info',
    });
    expect(mockSignerForHook.seen).toEqual([]);
    expect(spawnPosts()).toHaveLength(0);
  });

  it('서버 거절은 코어 문장 그대로, 빨간 안내다', async () => {
    const h = mountHook({});
    spawnReply = {status: 403, body: {error: {code: 'signed_spawn_disabled', message: 'x'}}};
    act(() => {
      h.probe.current?.tryCall('@my-claude 봐줘');
    });
    await waitFor(() =>
      expect(h.probe.current?.notice).toEqual({
        text: '이 서버는 아직 내 맥으로 보내는 호출을 받지 않아요.',
        tone: 'error',
      }),
    );
    expect(h.onOpenWorkSession).not.toHaveBeenCalled();
  });

  it('내 별칭 DM은 멘션 없이도 맡는다', async () => {
    const h = mountHook({channel: MY_DM});
    let took = false;
    act(() => {
      took = h.probe.current?.tryCall('로그인 버그 봐줘') ?? false;
    });
    expect(took).toBe(true);
    await waitFor(() => expect(spawnPosts()).toHaveLength(1));
  });

  it('호출이 끝나기 전에 다른 방으로 옮겨 가면, 폴백 전송은 쓰던 방으로 같은 키로 간다 (타임라인 send는 부르지 않는다)', async () => {
    const h = mountHook({hosts: [mac({online: false})]});
    act(() => {
      h.probe.current?.tryCall('@my-claude 봐줘');
      h.moveTo({...CHANNEL, id: 'other-room', name: 'other'});
    });
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    expect(h.sendPlain).not.toHaveBeenCalled();
    expect(messagePosts()[0]?.path).toContain(CH);
    expect(messagePosts()[0]?.body).toMatchObject({clientMsgId: 'client-msg-1'});
  });
});

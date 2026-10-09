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
import {AccessibilityInfo} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  intentKey,
  nextRunId,
  delegateAgents,
  HOSTED_UNKNOWN,
} from '../src/features/work/delegate/model';
import {__resetDelegateDrafts} from '../src/features/work/delegate/session';
import {SessionProvider} from '../src/session/useSession';
import {DelegateWorkSheet, type DelegatePrefill} from '../src/shell/DelegateWorkSheet';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #3588 N8 — 폰 「작업 맡기기」 시트.
//
// ## 무엇을 가짜로 두는가
//
// `fetch`가 무엇을 답했는가, 그것뿐이다. 시트·코어 `createAgentWorkRun`·`workRunFailure`·
// 후보 판정·id 규칙은 전부 진짜다. 그래서 아래 단정은 **호출 인자**가 아니라 나간
// 요청의 **본문**을 읽는다: 「같은 id로 다시 보낸다」는 네트워크에 나간 두 본문이 같다는
// 뜻이고, 「서버를 부르지 않는다」는 POST가 한 번도 없었다는 뜻이다.
//
// ## 다섯 단정이 각각 무엇을 잡는가 (RED PROOF — 제품 소스를 한 번 틀려서 붉어짐을 봤다)
//
//   ① 재시도는 같은 clientRunId   `nextRunId`의 `previous.key === key` 분기를 지우면 붉어진다.
//   ② 에이전트·채널·내용이 바뀌면 새 id   `intentKey`에서 channelId를 빼면 붉어진다.
//   ③ 승인 채널 0개면 보내기 막힘+문장   `filteredByApproval` 걸러내기를 지우면 붉어진다.
//   ④ 사유별 버튼   `failureAction`의 fix_elsewhere 분기를 retry로 바꾸면 붉어진다.
//   ⑤ 한글 67자 제목은 보내기 전에 막힘   코어 `trimmed`의 바이트 검사를 글자 수로 바꾸면 붉어진다.
// =============================================================================

// 햅틱은 래퍼(`lib/haptics`) 한 곳으로만 부른다(#3585). 네이티브 모듈이 없는 Jest 에서는
// 래퍼를 가짜로 두고 **언제 불렸는가**만 잰다 — 실기기 감각은 runtime-unverified.
jest.mock('../src/lib/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    light: jest.fn(),
    medium: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  },
}));
import {haptics} from '../src/lib/haptics';

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT = '33333333-3333-4333-8333-333333333333';
const CH_DEV = '44444444-4444-4444-8444-444444444441';
const CH_OPS = '44444444-4444-4444-8444-444444444442';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

function rosterMember(over: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    workspaceId: WS,
    kind: 'agent',
    status: 'active',
    displayName: '그록봇',
    handle: 'grokbot',
    channelCount: 2,
    channelIds: [CH_DEV, CH_OPS],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  };
}

const CHANNELS = [
  {id: CH_DEV, workspaceId: WS, kind: 'public', name: '개발', muted: false},
  {id: CH_OPS, workspaceId: WS, kind: 'public', name: '운영', muted: false},
];

function connectionWire(over: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    agentMemberId: AGENT,
    status: 'active',
    authMode: 'static_bearer',
    audience: '/v1/mcp/agent-port',
    approvedChannelIds: [CH_DEV, CH_OPS],
    approvedScopes: ['agent:port:connect'],
    activeCredentialId: '66666666-6666-4666-8666-666666666666',
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  };
}

function runWire() {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    workspaceId: WS,
    agentMemberId: AGENT,
    channelId: CH_DEV,
    status: 'queued',
    stepCount: 0,
    maxSteps: 20,
    depth: 0,
    input: {type: 'work', title: 't', brief: 'b'},
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

type RunAnswer =
  | {kind: 'ok'}
  | {kind: 'network'}
  | {kind: 'refuse'; status: number; code?: string; message: string};

interface Posted {
  url: string;
  body: {
    agentMemberId: string;
    clientRunId: string;
    input: Record<string, unknown>;
  };
}

function reply(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(options: {
  members?: unknown[];
  /** `null` = 호스티드 목록을 읽지 못함(일반 멤버의 403). */
  hosted?: unknown[] | null;
  runs?: RunAnswer[];
}) {
  const posted: Posted[] = [];
  const answers = [...(options.runs ?? [{kind: 'ok'}])];
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/roster')) {
      return reply(200, {members: options.members ?? [rosterMember()]});
    }
    if (target.endsWith('/channels')) return reply(200, {channels: CHANNELS});
    if (target.endsWith('/hosted-agent-connections')) {
      if (options.hosted === null || options.hosted === undefined) {
        return reply(403, {error: {message: 'forbidden'}});
      }
      return reply(200, {connections: options.hosted});
    }
    if (target.endsWith('/agent-runs') && init?.method === 'POST') {
      posted.push({url: target, body: JSON.parse(String(init.body))});
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer?.kind === 'network') throw new TypeError('Network request failed');
      if (answer?.kind === 'refuse') {
        return reply(answer.status, {
          error: {code: answer.code, message: answer.message},
        });
      }
      return reply(201, runWire());
    }
    throw new Error(`unrouted request: ${target}`);
  });
  global.fetch = mock as unknown as typeof fetch;
  return {posted: () => posted, fetch: mock};
}

function mount(prefill: DelegatePrefill = {}, props: {boardAvailable?: boolean} = {}) {
  const client = new QueryClient({
    // 변이의 gc 기본값은 5분짜리 타이머라 Jest 의 종료를 붙잡는다.
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {gcTime: 0}},
  });
  const onSubmitted = jest.fn();
  const onClose = jest.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <SessionProvider member={SELF}>
        <DelegateWorkSheet
          prefill={prefill}
          boardAvailable={props.boardAvailable ?? true}
          onClose={onClose}
          onSubmitted={onSubmitted}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return {view, onSubmitted, onClose};
}

async function fillAndSend(title = '로그인 버그 고치기', brief = '재현 순서는 이슈에 있어요.') {
  fireEvent.changeText(await screen.findByTestId('delegate-title'), title);
  fireEvent.changeText(screen.getByTestId('delegate-brief'), brief);
  await act(async () => {
    fireEvent.press(screen.getByTestId('delegate-send'));
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  __resetSessionStore();
  __resetServerBaseCache();
  __resetDelegateDrafts();
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

describe('① 같은 의도의 재시도는 같은 clientRunId를 보낸다', () => {
  it('네트워크가 끊겼다가 「다시 보내기」를 누르면 두 본문이 같다', async () => {
    const fixture = installFetch({
      members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})],
      runs: [{kind: 'network'}, {kind: 'ok'}],
    });
    const {onSubmitted} = mount({agentMemberId: AGENT});
    await fillAndSend();

    const retry = await screen.findByTestId('delegate-error-retry');
    expect(screen.getByText('다시 보내기')).toBeTruthy();
    await act(async () => {
      fireEvent.press(retry);
    });

    await waitFor(() => expect(fixture.posted()).toHaveLength(2));
    const [first, second] = fixture.posted();
    expect(first!.body.clientRunId).toBe(second!.body.clientRunId);
    expect(JSON.stringify(first!.body)).toBe(JSON.stringify(second!.body));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it('순수 규칙: 같은 지문이면 같은 슬롯, 다르면 새 슬롯', () => {
    let n = 0;
    const fresh = () => `id-${++n}`;
    const key = intentKey(AGENT, CH_DEV, {title: 'a', brief: 'b'});
    const first = nextRunId(null, key, fresh);
    expect(nextRunId(first, key, fresh)).toBe(first);
    expect(nextRunId(first, key, fresh, true).id).not.toBe(first.id);
  });
});

describe('② 에이전트·채널·내용이 바뀌면 새 id가 나간다', () => {
  it('채널을 바꾸거나 제목을 고친 뒤에 보내면 앞의 id를 쓰지 않는다', async () => {
    const fixture = installFetch({runs: [{kind: 'network'}]});
    mount({});

    // A 단계: 에이전트·채널을 고른다.
    fireEvent.press(await screen.findByTestId('delegate-agent-grokbot'));
    fireEvent.press(screen.getByTestId('delegate-channel-개발'));
    fireEvent.press(screen.getByTestId('delegate-next'));
    await fillAndSend();
    await screen.findByTestId('delegate-error-retry');
    expect(fixture.posted()).toHaveLength(1);

    // 같은 내용으로 다시 보내면 같은 id(대조군).
    await act(async () => {
      fireEvent.press(screen.getByTestId('delegate-error-retry'));
    });
    await waitFor(() => expect(fixture.posted()).toHaveLength(2));
    expect(fixture.posted()[1]!.body.clientRunId).toBe(
      fixture.posted()[0]!.body.clientRunId,
    );

    // 채널을 바꾸면 새 id.
    await screen.findByTestId('delegate-error-retry');
    fireEvent.press(screen.getByTestId('delegate-change-target'));
    fireEvent.press(await screen.findByTestId('delegate-channel-운영'));
    fireEvent.press(screen.getByTestId('delegate-next'));
    await act(async () => {
      fireEvent.press(await screen.findByTestId('delegate-send'));
    });
    await waitFor(() => expect(fixture.posted()).toHaveLength(3));
    expect(fixture.posted()[2]!.url).toContain(`/channels/${CH_OPS}/agent-runs`);
    expect(fixture.posted()[2]!.body.clientRunId).not.toBe(
      fixture.posted()[0]!.body.clientRunId,
    );

    // 제목을 고치면 또 새 id.
    await screen.findByTestId('delegate-error-retry');
    fireEvent.changeText(screen.getByTestId('delegate-title'), '다른 제목');
    await act(async () => {
      fireEvent.press(screen.getByTestId('delegate-send'));
    });
    await waitFor(() => expect(fixture.posted()).toHaveLength(4));
    expect(fixture.posted()[3]!.body.clientRunId).not.toBe(
      fixture.posted()[2]!.body.clientRunId,
    );
  });
});

describe('③ 승인 채널이 0개면 보내기가 막히고 이유가 선다', () => {
  it('목록을 읽었고 연결이 있는데 승인이 비면: 문장 + 다음 비활성 + 요청 없음', async () => {
    const fixture = installFetch({
      hosted: [connectionWire({approvedChannelIds: []})],
    });
    mount({});
    fireEvent.press(await screen.findByTestId('delegate-agent-grokbot'));

    expect(screen.getByTestId('delegate-no-channel')).toBeTruthy();
    expect(
      screen.getByText('이 에이전트는 아직 승인된 채널이 없어요. 승인은 데스크탑에서 해요.'),
    ).toBeTruthy();
    const next = screen.getByTestId('delegate-next');
    expect(next.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(next);
    expect(screen.queryByTestId('delegate-step-b')).toBeNull();
    expect(fixture.posted()).toHaveLength(0);
  });

  it('대조군: 목록을 못 읽으면(일반 멤버의 403) 거르지 않고 서버에 맡긴다', async () => {
    installFetch({hosted: null});
    mount({});
    fireEvent.press(await screen.findByTestId('delegate-agent-grokbot'));
    expect(screen.queryByTestId('delegate-no-channel')).toBeNull();
    expect(screen.getByTestId('delegate-channel-개발')).toBeTruthy();
    expect(screen.getByTestId('delegate-channel-운영')).toBeTruthy();
  });

  it('승인된 채널만 선택지로 서고, 안 된 채널은 서지 않는다', async () => {
    installFetch({hosted: [connectionWire({approvedChannelIds: [CH_OPS]})]});
    mount({});
    fireEvent.press(await screen.findByTestId('delegate-agent-grokbot'));
    // 하나뿐이면 자동으로 정해진다: 고르는 줄 없이 곧장 「다음」이 열린다.
    expect(screen.getByTestId('delegate-channel-운영')).toBeTruthy();
    expect(screen.queryByTestId('delegate-channel-개발')).toBeNull();
  });

  it('연결이 끊긴 에이전트는 회색이고 눌러도 고르지 않는다', async () => {
    installFetch({hosted: [connectionWire({status: 'expired'})]});
    mount({});
    const row = await screen.findByTestId('delegate-agent-grokbot');
    expect(row.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('oort와 연결이 끊겨 있어요')).toBeTruthy();
    fireEvent.press(row);
    expect(screen.queryByTestId('delegate-channels')).toBeNull();
  });
});

describe('④ 거절 사유마다 서는 버튼이 다르다', () => {
  async function refused(answer: RunAnswer) {
    const fixture = installFetch({
      members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})],
      runs: [answer],
    });
    mount({agentMemberId: AGENT});
    await fillAndSend();
    await screen.findByTestId('delegate-error');
    return fixture;
  }

  it('채널 미승인(409): 재시도 없음, 다른 곳 고르기, 보내기 막힘', async () => {
    const fixture = await refused({
      kind: 'refuse',
      status: 409,
      code: 'hosted_channel_not_approved',
      message: 'this channel is not approved for the hosted agent',
    });
    expect(
      screen.getByText(
        '이 채널은 아직 이 에이전트에게 승인되지 않았어요. 승인된 채널에서 맡겨 주세요.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('delegate-error-retry')).toBeNull();
    expect(screen.getByTestId('delegate-error-repick')).toBeTruthy();
    expect(screen.getByTestId('delegate-send').props.accessibilityState.disabled).toBe(
      true,
    );
    fireEvent.press(screen.getByTestId('delegate-send'));
    expect(fixture.posted()).toHaveLength(1);
  });

  it('연결 안 됨·게스트: 재시도 없음', async () => {
    await refused({
      kind: 'refuse',
      status: 409,
      code: 'hosted_connection_not_active',
      message: 'the hosted agent connection is not active',
    });
    expect(screen.queryByTestId('delegate-error-retry')).toBeNull();
    expect(screen.getByTestId('delegate-error-repick')).toBeTruthy();
  });

  it('서버 오류(500): 같은 id로 다시 보내기가 서고 「접수되지 않았어요」는 말하지 않는다', async () => {
    await refused({kind: 'refuse', status: 500, message: 'internal server error'});
    expect(screen.getByTestId('delegate-error-retry')).toBeTruthy();
    expect(screen.queryByTestId('delegate-error-repick')).toBeNull();
    expect(screen.queryByText(/접수되지 않았/)).toBeNull();
  });

  it('일시 정지(409 agent_paused): 「새로 맡기기」가 서고 누르면 새 id가 나간다', async () => {
    const fixture = installFetch({
      members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})],
      runs: [
        {kind: 'refuse', status: 409, code: 'agent_paused', message: 'agent is paused'},
        {kind: 'ok'},
      ],
    });
    mount({agentMemberId: AGENT});
    await fillAndSend();
    const again = await screen.findByTestId('delegate-error-retry');
    expect(screen.getByText('새로 맡기기')).toBeTruthy();
    await act(async () => {
      fireEvent.press(again);
    });
    await waitFor(() => expect(fixture.posted()).toHaveLength(2));
    expect(fixture.posted()[1]!.body.clientRunId).not.toBe(
      fixture.posted()[0]!.body.clientRunId,
    );
  });
});

describe('⑤ 한글 67자 제목은 보내기 전에 막힌다', () => {
  it('66자는 나가고 67자는 서버를 부르지 않는다', async () => {
    const fixture = installFetch({
      members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})],
    });
    mount({agentMemberId: AGENT});

    await fillAndSend('가'.repeat(67));
    expect(await screen.findByTestId('delegate-issue-title')).toBeTruthy();
    expect(screen.getByText('제목이 너무 길어요. 조금 줄여 주세요.')).toBeTruthy();
    expect(fixture.posted()).toHaveLength(0);

    fireEvent.changeText(screen.getByTestId('delegate-title'), '가'.repeat(66));
    await act(async () => {
      fireEvent.press(screen.getByTestId('delegate-send'));
    });
    await waitFor(() => expect(fixture.posted()).toHaveLength(1));
  });
});

describe('햅틱은 사용자 행동 한 번에 한 번, 입력 검증 오류에는 없다', () => {
  it('보내기 탭=light, 접수=success, 닫힌 거절=error, 검증 오류=없음', async () => {
    installFetch({
      members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})],
      runs: [
        {kind: 'refuse', status: 409, code: 'hosted_channel_not_approved', message: 'x'},
      ],
    });
    mount({agentMemberId: AGENT});

    // 검증 오류(제목 비움): 서버도 햅틱도 없다.
    await fillAndSend('', '설명');
    await screen.findByTestId('delegate-issue-title');
    expect(haptics.light).not.toHaveBeenCalled();
    expect(haptics.error).not.toHaveBeenCalled();

    // 거절: 탭에 light 한 번, 배너가 뜰 때 error 한 번.
    fireEvent.changeText(screen.getByTestId('delegate-title'), '제목');
    await act(async () => {
      fireEvent.press(screen.getByTestId('delegate-send'));
    });
    await screen.findByTestId('delegate-error');
    expect(haptics.light).toHaveBeenCalledTimes(1);
    expect(haptics.error).toHaveBeenCalledTimes(1);
    expect(haptics.success).not.toHaveBeenCalled();
  });

  it('접수되면 success 한 번', async () => {
    installFetch({members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})]});
    const view = mount({agentMemberId: AGENT});
    await fillAndSend();
    await waitFor(() => expect(view.onSubmitted).toHaveBeenCalled());
    expect(haptics.success).toHaveBeenCalledTimes(1);
    expect(haptics.error).not.toHaveBeenCalled();
  });
});

describe('VoiceOver: 거절과 칸 오류는 직접 알린다(iOS 는 live region 을 읽지 않는다)', () => {
  it('거절 문장과 검증 문장이 announceForAccessibility 로 나간다', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    installFetch({
      members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})],
      runs: [{kind: 'refuse', status: 500, message: 'boom'}],
    });
    mount({agentMemberId: AGENT});
    await fillAndSend('', '설명');
    await screen.findByTestId('delegate-issue-title');
    expect(announce).toHaveBeenCalledWith('제목을 적어 주세요.');

    fireEvent.changeText(screen.getByTestId('delegate-title'), '제목');
    await act(async () => {
      fireEvent.press(screen.getByTestId('delegate-send'));
    });
    await screen.findByTestId('delegate-error');
    expect(announce).toHaveBeenCalledWith(
      expect.stringContaining('서버에 문제가 생겼어요'),
    );
  });
});

describe('입력은 이 앱 실행 안의 메모리에만 남는다', () => {
  it('닫았다 다시 열면 되살아나지만 디스크(MMKV)에는 본문이 없다', async () => {
    installFetch({members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})]});
    const first = mount({agentMemberId: AGENT});
    fireEvent.changeText(await screen.findByTestId('delegate-title'), '비밀스러운 제목');
    fireEvent.changeText(screen.getByTestId('delegate-brief'), '고객사 이름이 든 설명');
    first.view.unmount();

    mount({agentMemberId: AGENT});
    expect((await screen.findByTestId('delegate-title')).props.value).toBe(
      '비밀스러운 제목',
    );
    const store = (require('react-native-mmkv') as {__store: Map<string, string>})
      .__store;
    expect(JSON.stringify([...store.values()])).not.toContain('비밀스러운 제목');
    expect(JSON.stringify([...store.values()])).not.toContain('고객사 이름이 든 설명');
  });

  it('접수되면 지운다', async () => {
    installFetch({members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})]});
    const first = mount({agentMemberId: AGENT});
    await fillAndSend();
    await waitFor(() => expect(first.onSubmitted).toHaveBeenCalled());
    first.view.unmount();
    mount({agentMemberId: AGENT});
    expect((await screen.findByTestId('delegate-title')).props.value).toBe('');
  });
});

describe('도착지는 입력 전에 이름으로 보인다', () => {
  it('B 단계 맨 위에 「그록봇 · #개발 채널로 보내요」', async () => {
    installFetch({members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})]});
    mount({agentMemberId: AGENT});
    await screen.findByTestId('delegate-title');
    expect(screen.getByText('그록봇 · #개발 채널로 보내요')).toBeTruthy();
  });

  it('작업 보드가 없는 서버에서는 시트 안에 접수 사실을 남긴다', async () => {
    installFetch({members: [rosterMember({channelIds: [CH_DEV], channelCount: 1})]});
    const view = mount({agentMemberId: AGENT}, {boardAvailable: false});
    await fillAndSend();
    expect(await screen.findByTestId('delegate-received')).toBeTruthy();
    expect(view.onSubmitted).not.toHaveBeenCalled();
  });
});

describe('후보 판정(순수)', () => {
  const directoryOf = (members: unknown[]) => ({
    members: members as never[],
    byId: new Map(),
    ambiguousNames: new Set<string>(),
  });
  const channels = CHANNELS.map(channel => ({...channel})) as never[];

  it('소유자 전용 에이전트는 소유자가 아닌 사람에게 나오지 않는다', () => {
    const mine = rosterMember({
      callableBy: 'owner_only',
      owner: {id: SELF_ID, displayName: '곽성재'},
    });
    const theirs = rosterMember({
      id: '99999999-9999-4999-8999-999999999999',
      handle: 'other',
      callableBy: 'owner_only',
      owner: {id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: '남'},
    });
    const out = delegateAgents({
      directory: directoryOf([mine, theirs]),
      channels,
      selfId: SELF_ID,
      hosted: HOSTED_UNKNOWN,
    });
    expect(out.map(agent => agent.member.handle)).toEqual(['grokbot']);
  });

  it('쉬는 에이전트는 빼지 않고 이유와 함께 남긴다', () => {
    const out = delegateAgents({
      directory: directoryOf([rosterMember({paused: true})]),
      channels,
      selfId: SELF_ID,
      hosted: HOSTED_UNKNOWN,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.rest).toBe('paused');
  });
});

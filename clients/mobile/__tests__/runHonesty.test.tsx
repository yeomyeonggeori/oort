import {ApiError, type AgentRunProgress, type Channel} from '@momo/core/lib/api';
import {signalFromProgress} from '@momo/core/features/agents/runPhase';
import {
  isStaleSignal,
  type AgentWorkingSignal,
} from '@momo/core/features/agents/workingSignal';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {AgentLivenessLabel} from '../src/features/agents/AgentLivenessLabel';
import {darkPalette, lightPalette} from '../src/design/tokens';
import {WorkingCard} from '../src/screens/SidebarScreen';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {buildWorkingCard, workingStep} from '../src/features/home/workingCard';

// =============================================================================
// 폰이 서버의 run 상태와 생존 라벨을 말한다 (ADR-0200, U4 #3750). 규칙은 웹과 같은
// core(`runPhase`·`liveness`)가 갖고 거기서 검증된다. 여기서 지키는 것은 **폰의 표면이
// 그 말을 그대로 하는가**다 — 문구를 mock하지 않는다. 「대기를 작업 중이라 하지 않는다」는
// 단정이 mock된 문자열을 향하면 아무것도 지키지 못한다. 지켜야 하는 것은 화면에 그
// 글자가 없다는 것이다.
// =============================================================================

const WS = '00000000-0000-7000-8000-000000000001';
const ME = '00000000-0000-7000-8000-000000000101';
const AGENT = '00000000-0000-7000-8000-000000000301';
const CH = '00000000-0000-7000-8000-000000000201';
const MIN = 60_000;

// jest.mock 팩토리는 `mock`으로 시작하는 변수만 밖에서 읽을 수 있다(babel-plugin-jest-hoist).
const mockState: {role: 'owner' | 'admin' | 'member'} = {role: 'owner'};
const mockFetchLiveness = jest.fn();

jest.mock('../src/session/useSession', () => ({
  ...jest.requireActual('../src/session/useSession'),
  useSession: () => ({
    workspaceId: '00000000-0000-7000-8000-000000000001',
    member: {id: '00000000-0000-7000-8000-000000000101'},
  }),
}));
jest.mock('../src/features/workspace/queries', () => ({
  ...jest.requireActual('../src/features/workspace/queries'),
  useDirectory: () => ({
    directory: jest
      .requireActual('@momo/core/features/workspace/directory')
      .makeDirectory([
        {
          id: '00000000-0000-7000-8000-000000000101',
          workspaceId: '00000000-0000-7000-8000-000000000001',
          kind: 'human',
          status: 'active',
          displayName: '곽성재',
          handle: 'seongjae',
          role: mockState.role,
          channelCount: 1,
          channelIds: [],
          capabilities: [],
          createdAtMs: 0,
          updatedAtMs: 0,
        },
      ]),
  }),
}));
jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  fetchAgentLiveness: (ws: string, agent: string) => mockFetchLiveness(ws, agent),
}));

let client: QueryClient | null = null;

afterEach(() => {
  cleanup();
  // 쿼리 캐시를 비워야 갱신 타이머(60초 주기)가 남아 잰 프로세스를 붙잡지 않는다.
  client?.clear();
  client = null;
  mockFetchLiveness.mockReset();
  mockState.role = 'owner';
});

function progress(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  const now = Date.now();
  return {
    id: '0199aa11-2222-7000-8000-0000000000b1',
    channelId: CH,
    agentMemberId: AGENT,
    status: 'queued',
    phase: 'queued',
    leaseState: 'none',
    stepCount: 0,
    ahead: [],
    createdAtMs: now - 11 * MIN,
    updatedAtMs: now - 11 * MIN,
    ...extra,
  };
}

function signalOf(extra: Partial<AgentRunProgress> = {}): AgentWorkingSignal {
  const signal = signalFromProgress(progress(extra));
  if (signal === null) {
    throw new Error('signal');
  }
  return signal;
}

const DIRECTORY = makeDirectory([
  {
    id: AGENT,
    workspaceId: WS,
    kind: 'agent',
    status: 'active',
    displayName: '그록봇',
    handle: 'grokbot',
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
] as never);
const CHANNELS = [
  {id: CH, workspaceId: WS, kind: 'public', name: '계획', muted: false},
] as unknown as Channel[];

function card(signal: AgentWorkingSignal) {
  return buildWorkingCard({
    signals: new Map([[`${signal.channelId}|${signal.memberId}`, signal]]),
    nowMs: Date.now(),
    directory: DIRECTORY,
    channels: CHANNELS,
    selfMemberId: ME,
    live: true,
  });
}

describe('홈 카드: 서버가 말한 단계 그대로', () => {
  // 2026-10-13 실측: 11분 뒤에 수령되는 정상 run이 55초에 「신호 소실」로 보였다. 이 시험은
  // `isStaleSignal`의 server 우회를 빼면 첫 단정부터 실패한다.
  it('11분 동안 수령되지 않은 정상 run은 카드가 서고, 「작업 중」도 「신호 소실」도 아니다', () => {
    const signal = signalOf({queuePosition: 2, aheadTotal: 1});
    expect(Date.now() - signal.lastActivityAtMs).toBeGreaterThan(90_000);
    expect(isStaleSignal(signal, Date.now())).toBe(false);

    const model = card(signal);
    expect(model).not.toBeNull();
    // 5분을 넘긴 사람 요청이라 「대기 2번째」가 아니라 「아직 받지 않았어요」다(#4285). 순번은 근거 줄의
    // 「에이전트 앞에 1건」이 이어 말한다.
    expect(model?.liveText).toBe('아직 받지 않았어요');
    expect(model?.detail).toBe('11분째 기다려요 · 에이전트 앞에 1건');
    expect(model?.state).toBe('queued');
    expect(model?.accessibilityLabel).not.toMatch(/작업 중|신호 소실|끊/);
  });

  it('server를 빼면 같은 run이 90초에 걸러진다 (관리형·옛 서버의 규칙은 그대로)', () => {
    const legacy = {...signalOf({queuePosition: 2})};
    delete legacy.server;
    expect(card(legacy)).toBeNull();
  });

  it('대기 run은 막대를 켜지 않고 「시작함」이라 말하지 않는다', () => {
    const queued = signalOf({queuePosition: 1});
    expect(workingStep(queued)).toBe(0);
    const model = card(queued);
    expect(model?.step).toBe(0);
    expect(model?.accessibilityLabel).toContain('아직 시작 전');
    expect(model?.accessibilityLabel).not.toContain('시작함');
  });

  it('가져감·작업 중(에이전트가 보고한 단계)·승인 필요', () => {
    expect(
      card(signalOf({phase: 'claimed', leaseState: 'live', claimedAtMs: Date.now() - 20_000}))
        ?.liveText,
    ).toBe('가져감');
    const running = card(
      signalOf({
        phase: 'running',
        status: 'running',
        leaseState: 'live',
        startedAtMs: Date.now() - 60_000,
        latestStage: '채널 이름 확인',
      }),
    );
    expect(running?.liveText).toBe('작업 중');
    expect(running?.headline).toBe('채널 이름 확인');
    expect(
      card(signalOf({phase: 'awaiting_approval', status: 'awaiting_approval'}))?.liveText,
    ).toBe('승인 필요');
  });

  it('가져간 뒤 lease가 만료됐어도 끊겼다고 하지 않는다', () => {
    const model = card(
      signalOf({
        phase: 'claimed',
        leaseState: 'stale',
        claimedAtMs: Date.now() - 34 * MIN,
      }),
    );
    expect(model?.detail).toBe('가져간 뒤 34분째 소식이 없어요');
    expect(model?.accessibilityLabel).not.toMatch(/신호 소실|끊/);
  });
});

describe('홈 카드 본문', () => {
  it('장소도 한 줄도 없을 때 「대화」 뒤에 근거 줄이 붙어 읽히지 않고 구분자가 선다', () => {
    const model = buildWorkingCard({
      signals: new Map([['x|y', signalOf({queuePosition: 2, aheadTotal: 1})]]),
      nowMs: Date.now(),
      directory: DIRECTORY,
      channels: [],
      selfMemberId: ME,
      live: true,
    });
    expect(model?.place).toBeNull();
    if (model === null) {
      throw new Error('card');
    }
    render(<WorkingCard card={model} onPress={() => undefined} />);
    expect(screen.getByTestId('home-working-line')).toHaveTextContent(
      '대화 · 11분째 기다려요 · 에이전트 앞에 1건',
    );
  });
});

describe('대화 위 활동 줄', () => {
  it('대기 run은 「대기 2번째」와 근거 줄을 말하고 「작업 중」이라 하지 않는다', () => {
    // 5분이 안 된 요청이다: 5분을 넘으면 「아직 받지 않았어요」로 바뀐다(#4285, `uncollectedRun.test.tsx`).
    const now = Date.now();
    render(
      <AgentActivityBar
        turns={[signalOf({queuePosition: 2, aheadTotal: 1, createdAtMs: now - 3 * MIN})]}
        directory={DIRECTORY}
        nowMs={now}
        live
      />,
    );
    const bar = screen.getByTestId('composer-working');
    expect(bar).toHaveTextContent(/그록봇.*대기 2번째/);
    expect(bar).not.toHaveTextContent(/작업 중/);
    expect(screen.getByTestId('activity-detail')).toHaveTextContent(
      '3분째 기다려요 · 에이전트 앞에 1건',
    );
  });

  it('승인 필요에는 근거 줄이 없다', () => {
    render(
      <AgentActivityBar
        turns={[signalOf({phase: 'awaiting_approval', status: 'awaiting_approval'})]}
        directory={DIRECTORY}
        nowMs={Date.now()}
        live
      />,
    );
    expect(screen.queryByTestId('activity-detail')).toBeNull();
  });
});

describe('생존 라벨', () => {
  function mount() {
    client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}},
    });
    return render(
      <QueryClientProvider client={client}>
        <AgentLivenessLabel agentId={AGENT} />
      </QueryClientProvider>,
    );
  }

  it('hosted가 아닌 에이전트(404)에는 아무것도 서지 않는다', async () => {
    mockFetchLiveness.mockRejectedValue(new ApiError(404, 'not found'));
    mount();
    await waitFor(() => expect(mockFetchLiveness).toHaveBeenCalled());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(screen.queryByTestId('agent-liveness')).toBeNull();
  });

  it('서버가 준 상태가 그대로 낱말이 된다', async () => {
    mockFetchLiveness.mockResolvedValue({
      agentMemberId: AGENT,
      state: 'responsive',
      lastSignalAtMs: Date.now() - 3 * MIN,
    });
    mount();
    expect(await screen.findByTestId('agent-liveness-text')).toHaveTextContent('응답함 3분 전');
    expect(screen.getByTestId('agent-liveness').props.accessibilityLabel).toContain(
      '응답함 3분 전',
    );
  });

  it('칩의 점은 사이드바 줄의 점과 같은 함수를 읽는다 — 살아 있음·대기도 초록, 꺼짐은 채운 회색(낱말이 곁에 있다)', async () => {
    const dotColor = () => {
      const style = StyleSheet.flatten(screen.getByTestId('agent-liveness-dot').props.style) as {
        backgroundColor?: string;
      };
      return style.backgroundColor;
    };
    mockFetchLiveness.mockResolvedValue({agentMemberId: AGENT, state: 'alive_idle'});
    const alive = mount();
    await screen.findByTestId('agent-liveness-text');
    expect([lightPalette.ok, darkPalette.ok]).toContain(dotColor());
    alive.unmount();

    mockFetchLiveness.mockResolvedValue({agentMemberId: AGENT, state: 'inactive'});
    mount();
    await screen.findByTestId('agent-liveness-text');
    expect([lightPalette.textFaint, darkPalette.textFaint]).toContain(dotColor());
  });

  it('깨웠지만 안 가져감은 owner/admin에게만 경고색이다', async () => {
    mockFetchLiveness.mockResolvedValue({agentMemberId: AGENT, state: 'woken_not_collected'});
    const ownerView = mount();
    const ownerText = await screen.findByTestId('agent-liveness-text');
    expect(ownerText).toHaveTextContent('깨웠지만 아직 안 가져감');
    const flat = (node: {props: {style?: unknown}}) =>
      JSON.stringify(node.props.style);
    const ownerColor = flat(ownerText);
    ownerView.unmount();

    mockState.role = 'member';
    mockFetchLiveness.mockResolvedValue({agentMemberId: AGENT, state: 'woken_not_collected'});
    mount();
    const memberText = await screen.findByTestId('agent-liveness-text');
    // 같은 사실, 같은 낱말. 할 수 있는 일이 없는 사람에게는 색이 경고하지 않는다.
    expect(memberText).toHaveTextContent('깨웠지만 아직 안 가져감');
    expect(flat(memberText)).not.toEqual(ownerColor);
  });
});

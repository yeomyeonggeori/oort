import {
  agentRunProgressFromWire,
  ApiError,
  type AgentLiveness,
  type AgentRunProgress,
  type Channel,
} from '@momo/core/lib/api';
import {signalFromProgress} from '@momo/core/features/agents/runPhase';
import type {AgentLivenessLookup} from '@momo/core/features/agents/turnCopy';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, renderHook, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Text} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  resetRunProgress,
  runProgressSignals,
  startRunProgress,
  nudgeRunProgress,
} from '../src/features/agents/agentRunProgressStore';
import {useAgentLivenessLookup} from '../src/features/agents/useAgentLiveness';
import {AgentActivityBar} from '../src/features/agents/turnSurfaces';
import {
  buildWorkingCard,
  cardCancelRunId,
  leadWorkingTurn,
  revealOverflow,
} from '../src/features/home/workingCard';

// =============================================================================
// 아무도 가져가지 않은 채 오래 머무는 「사람이 부른 일」과 시스템 작업 (#4285, ADR-0200 증보 3 E6).
// 문구의 판정은 코어(`runWaiting`)에서 검증된다. 여기서 지키는 것은 **폰의 표면이 그 말을 그대로
// 하는가**다: 홈 카드의 모델, 대화 아래 활동 줄, 생존 판정을 여럿 읽는 훅, 그리고 서버가 끝낸 run이
// 카드에서 사라지는 길. 문구는 mock하지 않는다 — 화면에 그 글자가 있는지/없는지를 센다.
// =============================================================================

const WS = '00000000-0000-7000-8000-000000000001';
const ME = '00000000-0000-7000-8000-000000000101';
const AGENT = '00000000-0000-7000-8000-000000000301';
const AGENT_B = '00000000-0000-7000-8000-000000000302';
const CH = '00000000-0000-7000-8000-000000000201';
const RUN = '0199aa11-2222-7000-8000-0000000000b1';
const MIN = 60_000;
const HOUR = 60 * MIN;

// jest.mock 팩토리는 `mock`으로 시작하는 변수만 밖에서 읽을 수 있다(babel-plugin-jest-hoist).
const mockFetchLiveness = jest.fn();

jest.mock('../src/session/useSession', () => ({
  ...jest.requireActual('../src/session/useSession'),
  useSession: () => ({
    workspaceId: '00000000-0000-7000-8000-000000000001',
    member: {id: '00000000-0000-7000-8000-000000000101'},
  }),
}));
jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  fetchAgentLiveness: (ws: string, agent: string) => mockFetchLiveness(ws, agent),
}));

let client: QueryClient | null = null;

afterEach(() => {
  cleanup();
  client?.clear();
  client = null;
  mockFetchLiveness.mockReset();
  resetRunProgress();
});

const DIRECTORY = makeDirectory([
  {
    id: AGENT,
    workspaceId: WS,
    kind: 'agent',
    status: 'active',
    displayName: '달무리봇',
    handle: 'dalmuri-bot',
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: AGENT_B,
    workspaceId: WS,
    kind: 'agent',
    status: 'active',
    displayName: '모래시계봇',
    handle: 'sand-bot',
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
] as never);
const CHANNELS = [
  {id: CH, workspaceId: WS, kind: 'public', name: 'general', muted: false},
] as unknown as Channel[];

/** 사람이 부른 대기 run(트리거 메시지가 있다). 서버가 알린 사실 그대로. */
function progress(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  const now = Date.now();
  return {
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: '0199aa11-2222-7000-8000-0000000000c1',
    status: 'queued',
    phase: 'queued',
    leaseState: 'none',
    stepCount: 0,
    ahead: [],
    createdAtMs: now - 17 * HOUR,
    updatedAtMs: now - 17 * HOUR,
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

function mapOf(...signals: AgentWorkingSignal[]): Map<string, AgentWorkingSignal> {
  return new Map(signals.map(s => [`${s.channelId}|${s.memberId}|${s.runId}`, s]));
}

function liveness(state: AgentLiveness['state'], agentMemberId = AGENT): AgentLiveness {
  return {agentMemberId, state, lastSignalAtMs: Date.now() - 3 * HOUR};
}

function card(
  signals: Map<string, AgentWorkingSignal>,
  extra: {liveness?: AgentLiveness | null; live?: boolean} = {},
) {
  return buildWorkingCard({
    signals,
    nowMs: Date.now(),
    directory: DIRECTORY,
    channels: CHANNELS,
    selfMemberId: ME,
    live: extra.live ?? true,
    liveness: extra.liveness,
  });
}

describe('홈 카드: 누가 기다리는 일만 싣는다 (#4285)', () => {
  it('부른 사람이 없는 시스템 작업(환영)은 카드가 아니다 — 서버가 5시간 기다렸다고 해도', () => {
    // 와이어에서 읽은 그대로: 트리거 메시지도 작업 제목도 없는 run.
    const welcome = agentRunProgressFromWire({
      id: RUN,
      channelId: CH,
      agentMemberId: AGENT,
      status: 'queued',
      phase: 'queued',
      leaseState: 'none',
      stepCount: 0,
      queuePosition: 1,
      createdAtMs: Date.now() - 5 * HOUR,
      updatedAtMs: Date.now() - 5 * HOUR,
    });
    expect(welcome.system).toBe(true);
    const signal = signalFromProgress(welcome);
    expect(signal).not.toBeNull();
    expect(card(mapOf(signal as AgentWorkingSignal))).toBeNull();
    expect(leadWorkingTurn(mapOf(signal as AgentWorkingSignal), Date.now())).toBeUndefined();
  });

  it('시스템 작업이 먼저 와 있어도 카드는 사람이 부른 요청이고, 「그 밖에 n건」도 숨은 일을 세지 않는다', () => {
    const welcome = signalOf({id: 'w1', agentMemberId: AGENT_B, system: true});
    const human = signalOf({id: RUN, queuePosition: 1});
    const model = card(mapOf(welcome, human));
    expect(model?.memberId).toBe(AGENT);
    expect(model?.others).toBe(0);
    expect(model?.accessibilityLabel).not.toContain('그 밖에');
    // 숨은 일 때문에 사람이 부른 일이 밀려나지도 않는다.
    expect(model?.runId).toBe(RUN);
  });

  it('사람이 부른 작업(제목만 있고 트리거 메시지는 없다)은 카드가 서고 가져가지 않았으면 취소가 선다', () => {
    const work = agentRunProgressFromWire({
      id: RUN,
      channelId: CH,
      agentMemberId: AGENT,
      triggerSummary: '배포 점검표 만들기',
      status: 'queued',
      phase: 'queued',
      leaseState: 'none',
      stepCount: 0,
      createdAtMs: Date.now() - 10 * MIN,
      updatedAtMs: Date.now() - 10 * MIN,
    });
    expect(work.system).toBeUndefined();
    const model = card(mapOf(signalFromProgress(work) as AgentWorkingSignal));
    expect(model?.uncollected).toBe(true);
    expect(model?.runId).toBe(RUN);
  });

  it('제목이 U+FEFF뿐인 작업도 숨지 않는다 — 서버가 제목으로 센 글자를 우리가 「없음」으로 읽으면 사람의 요청이 홈에서 사라진다 (planner 결정 1)', () => {
    // 서버의 `trim()`은 U+FEFF를 글자로 세어 이 제목을 받아들이고(`required_string`), JS의 `trim()`은
    // 지운다. 와이어 경계가 글자 그대로 비었는지만 보므로 이 run은 사람이 부른 run으로 남는다.
    const work = agentRunProgressFromWire({
      id: RUN,
      channelId: CH,
      agentMemberId: AGENT,
      triggerSummary: '\uFEFF',
      status: 'queued',
      phase: 'queued',
      leaseState: 'none',
      stepCount: 0,
      createdAtMs: Date.now() - 10 * MIN,
      updatedAtMs: Date.now() - 10 * MIN,
    });
    expect(work.system).toBeUndefined();
    const model = card(mapOf(signalFromProgress(work) as AgentWorkingSignal));
    expect(model).not.toBeNull();
    expect(model?.uncollected).toBe(true);
    expect(cardCancelRunId(model!)).toBe(RUN);
  });
});

describe('홈 카드: 아무도 가져가지 않은 채 5분을 넘은 사람 요청', () => {
  it('낱말은 「아직 받지 않았어요」, 근거 줄은 서버의 생존 경고가 앞이고 경과 시간이 뒤다', () => {
    const model = card(mapOf(signalOf({queuePosition: 1, aheadTotal: 0})), {
      liveness: liveness('woken_not_collected'),
    });
    expect(model?.uncollected).toBe(true);
    expect(model?.liveText).toBe('아직 받지 않았어요');
    expect(model?.detail).toBe('깨웠지만 아직 안 가져감 · 17시간째 기다려요');
    expect(model?.reason).toBe('연결이 꺼져 있을 수 있어요');
    expect(model?.accessibilityLabel).toContain('아직 받지 않았어요');
    expect(model?.accessibilityLabel).toContain('연결이 꺼져 있을 수 있어요');
    expect(model?.accessibilityLabel).not.toContain('대기 1번째');
    expect(model?.runId).toBe(RUN);
    expect(model?.step).toBe(0);
  });

  it('호스티드가 아닌 에이전트(null)나 아직 읽는 중(undefined)이면 경고 문구도 이유도 지어내지 않는다', () => {
    for (const unknown of [null, undefined]) {
      const model = card(mapOf(signalOf({queuePosition: 1})), {liveness: unknown});
      expect(model?.liveText).toBe('아직 받지 않았어요');
      expect(model?.detail).toBe('17시간째 기다려요');
      expect(model?.reason).toBeNull();
    }
  });

  it('살아 있는데 일을 안 가져가는 에이전트에는 「연결이 꺼져 있을 수 있어요」를 붙이지 않는다', () => {
    const model = card(mapOf(signalOf({queuePosition: 1})), {
      liveness: liveness('work_waiting'),
    });
    expect(model?.detail).toBe('일이 기다리는 중 · 17시간째 기다려요');
    expect(model?.reason).toBeNull();
  });

  it('5분 안의 요청은 서버가 말한 「대기 n번째」 그대로이고 이유 문장도 취소도 서지 않는다', () => {
    const young = signalOf({
      queuePosition: 2,
      aheadTotal: 1,
      createdAtMs: Date.now() - 2 * MIN,
    });
    // 경고가 없는 에이전트: 근거 줄은 전과 같다.
    const calm = card(mapOf(young), {liveness: liveness('responsive')});
    expect(calm?.uncollected).toBe(false);
    expect(calm?.liveText).toBe('대기 2번째');
    expect(calm?.detail).toBe('2분째 기다려요 · 에이전트 앞에 1건');
    expect(calm?.reason).toBeNull();
    // 경고 라벨은 N과 무관하게 근거 줄 맨 앞에 선다(E6). 이유 문장은 5분을 넘어야 선다 — 지우면 여기서 빨개진다.
    const warned = card(mapOf(young), {liveness: liveness('woken_not_collected')});
    expect(warned?.uncollected).toBe(false);
    expect(warned?.liveText).toBe('대기 2번째');
    expect(warned?.detail).toBe('깨웠지만 아직 안 가져감 · 2분째 기다려요 · 에이전트 앞에 1건');
    expect(warned?.reason).toBeNull();
    expect(cardCancelRunId(warned!)).toBeNull();
  });

  it('가져간(claimed) run은 「받지 않았어요」가 아니다', () => {
    const model = card(
      mapOf(
        signalOf({
          phase: 'claimed',
          leaseState: 'live',
          claimedAtMs: Date.now() - 20_000,
          createdAtMs: Date.now() - 2 * HOUR,
        }),
      ),
      {liveness: liveness('woken_not_collected')},
    );
    expect(model?.liveText).toBe('가져감');
    expect(model?.uncollected).toBe(false);
  });
});

describe('카드가 자랄 때 보이는 영역 (design-review #4285 r1 H1)', () => {
  it('카드 아래 끝이 보이는 영역 밖이면 그만큼, 안이면 0 이하다 — 숨(gap)까지 남긴다', () => {
    // 가장 큰 글씨(AX5)의 확인 줄: 카드 아래 끝이 창 아래로 넘친다.
    expect(revealOverflow({cardBottom: 1100, viewportBottom: 790, gap: 12})).toBe(322);
    // 이미 보인다: 스크롤할 필요가 없다(0 이하).
    expect(revealOverflow({cardBottom: 600, viewportBottom: 790, gap: 12})).toBeLessThanOrEqual(0);
    // 딱 맞아도 숨은 남긴다: 단추가 탭바에 붙어 서지 않는다.
    expect(revealOverflow({cardBottom: 778, viewportBottom: 790, gap: 12})).toBe(0);
    expect(revealOverflow({cardBottom: 779, viewportBottom: 790, gap: 12})).toBe(1);
  });
});

describe('끊긴 레일의 카드', () => {
  it('이유 줄이 서지 않는다 — 「연결이 끊겨 갱신이 멈췄어요」 바로 위에 다른 연결 문장이 서면 어느 연결인지 가려지지 않는다 (design-review #4285 r1 M2)', () => {
    const live = card(mapOf(signalOf({queuePosition: 1})), {liveness: liveness('woken_not_collected')});
    expect(live?.reason).toBe('연결이 꺼져 있을 수 있어요');
    const offline = card(mapOf(signalOf({queuePosition: 1})), {
      liveness: liveness('woken_not_collected'),
      live: false,
    });
    expect(offline?.reason).toBeNull();
    expect(offline?.accessibilityLabel).not.toContain('연결이 꺼져 있을 수 있어요');
    // 낱말과 근거 줄은 마지막으로 확인된 사실 그대로 남는다.
    expect(offline?.liveText).toBe('아직 받지 않았어요');
    expect(offline?.detail).toBe('깨웠지만 아직 안 가져감 · 17시간째 기다려요');
  });
});

describe('홈 카드가 「취소」를 내는 때', () => {
  it('아무도 가져가지 않은 채 5분을 넘은 요청이고 연결이 살아 있을 때만, 그 실행을 가리킨다', () => {
    const uncollected = card(mapOf(signalOf({queuePosition: 1})));
    expect(cardCancelRunId(uncollected!)).toBe(RUN);

    // 5분이 안 됐다.
    const young = card(mapOf(signalOf({createdAtMs: Date.now() - 2 * MIN})));
    expect(young?.uncollected).toBe(false);
    expect(cardCancelRunId(young!)).toBeNull();

    // 끊긴 레일: 마지막으로 확인된 상태일 뿐이고 그 요청은 이미 끝났을 수 있다.
    const offline = card(mapOf(signalOf({queuePosition: 1})), {live: false});
    expect(offline?.uncollected).toBe(true);
    expect(cardCancelRunId(offline!)).toBeNull();

    // 가져간 run은 취소 카드가 아니다.
    const claimed = card(
      mapOf(signalOf({phase: 'claimed', leaseState: 'live', claimedAtMs: Date.now() - 20_000})),
    );
    expect(cardCancelRunId(claimed!)).toBeNull();
  });

  it('보낼 실행을 모르는 카드(레일이 진행 중에 붙었다)에는 취소를 권하지 않는다', () => {
    const noRun: AgentWorkingSignal = {...signalOf({queuePosition: 1})};
    delete noRun.runId;
    const model = card(mapOf(noRun));
    expect(model?.uncollected).toBe(true);
    expect(model?.runId).toBeNull();
    expect(cardCancelRunId(model!)).toBeNull();
  });
});

describe('서버가 woken_not_collected로 끝내면 카드가 사라진다 (#4284 짝)', () => {
  it('진행 스토어가 끝난 run을 읽으면 카드의 재료가 사라진다 (우리 시계가 지우지 않는다)', async () => {
    const open = progress({queuePosition: 1});
    const ended: AgentRunProgress = {
      ...open,
      status: 'timed_out',
      phase: 'timed_out',
      endReason: 'woken_not_collected',
      queuePosition: undefined,
      updatedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    };
    let current: AgentRunProgress[] = [open];
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH],
      rail: null,
      fetchProgress: async () => current,
      pollMs: 3_600_000,
    });
    try {
      await waitFor(() => expect(runProgressSignals()).toHaveLength(1));
      const shown = card(mapOf(...runProgressSignals()));
      expect(shown?.uncollected).toBe(true);

      current = [ended];
      nudgeRunProgress(CH);
      await waitFor(() => expect(runProgressSignals()).toHaveLength(0));
      expect(card(mapOf(...runProgressSignals()))).toBeNull();
    } finally {
      stop();
    }
  });
});

describe('대화 아래 활동 줄', () => {
  const lookup =
    (answers: Record<string, AgentLiveness | null>): AgentLivenessLookup =>
    memberId =>
      answers[memberId.toLowerCase()];

  function bar(
    turns: AgentWorkingSignal[],
    answers?: Record<string, AgentLiveness | null>,
    renderStop?: React.ComponentProps<typeof AgentActivityBar>['renderStop'],
  ) {
    return render(
      <AgentActivityBar
        turns={turns}
        directory={DIRECTORY}
        nowMs={Date.now()}
        live
        livenessFor={answers === undefined ? undefined : lookup(answers)}
        renderStop={renderStop}
      />,
    );
  }

  it('아무도 가져가지 않은 요청: 「아직 받지 않았어요」, 경고 문구가 앞, 이유가 끝에', () => {
    bar([signalOf({queuePosition: 1})], {[AGENT]: liveness('woken_not_collected')});
    const row = screen.getByTestId('composer-working');
    expect(row).toHaveTextContent(/달무리봇: 아직 받지 않았어요/);
    expect(row).not.toHaveTextContent(/대기 1번째/);
    expect(screen.getByTestId('activity-detail')).toHaveTextContent(
      '깨웠지만 아직 안 가져감 · 17시간째 기다려요 · 연결이 꺼져 있을 수 있어요',
    );
    // 이 문장은 낭독 이름에도 같다(숫자 없이).
    expect(screen.getByLabelText('달무리봇: 아직 받지 않았어요')).toBeTruthy();
  });

  it('생존 판정을 안 주면(생략) 낱말은 바뀌어도 경고 문구·이유는 없다', () => {
    bar([signalOf({queuePosition: 1})]);
    expect(screen.getByTestId('composer-working')).toHaveTextContent(/달무리봇: 아직 받지 않았어요/);
    expect(screen.getByTestId('activity-detail')).toHaveTextContent('17시간째 기다려요');
    expect(screen.getByTestId('activity-detail')).not.toHaveTextContent('깨웠지만');
  });

  it('멈추는 컨트롤은 요청이 아직 아무에게도 가지 않았으면 「취소」, 가져간 뒤는 「중단」 한 벌을 받는다', () => {
    const seen: Record<string, string> = {};
    const renderStop: React.ComponentProps<typeof AgentActivityBar>['renderStop'] = turn => {
      seen[turn.memberId] = turn.wording.action;
      return <Text testID={`wording-${turn.memberId}`}>{turn.wording.action}</Text>;
    };
    bar(
      [
        signalOf({queuePosition: 1}),
        signalOf({
          id: '0199aa11-2222-7000-8000-0000000000b2',
          agentMemberId: AGENT_B,
          phase: 'claimed',
          leaseState: 'live',
          claimedAtMs: Date.now() - 20_000,
        }),
      ],
      undefined,
      renderStop,
    );
    expect(seen[AGENT]).toBe('취소');
    expect(seen[AGENT_B]).toBe('중단');
    expect(screen.getByTestId(`wording-${AGENT}`)).toHaveTextContent('취소');
  });

  it('시스템 작업 줄은 기존 말이다 (카드만 숨기고 줄은 그대로)', () => {
    bar([signalOf({queuePosition: 1, system: true})], {[AGENT]: liveness('woken_not_collected')});
    expect(screen.getByTestId('composer-working')).toHaveTextContent(/달무리봇: 대기 1번째/);
    expect(screen.getByTestId('activity-detail')).toHaveTextContent('17시간째 기다려요');
  });
});

describe('useAgentLivenessLookup — 여러 에이전트의 생존 판정을 한 함수로', () => {
  function wrapper({children}: {children: React.ReactNode}) {
    return <QueryClientProvider client={client as QueryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  });

  it('호스티드는 판정, 호스티드가 아니면(404) null, 아직 읽는 중이면 undefined', async () => {
    mockFetchLiveness.mockImplementation(async (_ws: string, agent: string) => {
      if (agent === AGENT) return {agentMemberId: AGENT, state: 'woken_not_collected'};
      if (agent === AGENT_B) throw new ApiError(404, 'not found');
      return new Promise(() => {});
    });
    const {result} = renderHook(() => useAgentLivenessLookup([AGENT, AGENT_B, 'pending-agent']), {
      wrapper,
    });
    expect(result.current(AGENT)).toBeUndefined();
    await waitFor(() => expect(result.current(AGENT)?.state).toBe('woken_not_collected'));
    await waitFor(() => expect(result.current(AGENT_B)).toBeNull());
    expect(result.current('pending-agent')).toBeUndefined();
    // 대소문자가 섞여 와도 같은 에이전트다(와이어 id는 섞여 온다).
    expect(result.current(AGENT.toUpperCase())?.state).toBe('woken_not_collected');
  });

  it('답이 같으면 같은 함수를 돌려준다 — 1Hz로 다시 그려지는 활동 줄의 메모가 깨지지 않는다', async () => {
    mockFetchLiveness.mockResolvedValue({agentMemberId: AGENT, state: 'responsive'});
    const {result, rerender} = renderHook(() => useAgentLivenessLookup([AGENT]), {wrapper});
    await waitFor(() => expect(result.current(AGENT)?.state).toBe('responsive'));
    const first = result.current;
    rerender({});
    rerender({});
    expect(result.current).toBe(first);
  });

  it('읽을 에이전트가 없으면 요청을 보내지 않는다', async () => {
    renderHook(() => useAgentLivenessLookup([]), {wrapper});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockFetchLiveness).not.toHaveBeenCalled();
  });
});

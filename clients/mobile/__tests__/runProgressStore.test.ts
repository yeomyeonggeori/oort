import {ApiError, type AgentRunProgress} from '@momo/core/lib/api';
import {WireShapeError} from '@momo/core/lib/wire';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  nudgeRunProgress,
  resetRunProgress,
  runFactsFor,
  subscribeRunLedgerFrames,
  runProgressSignals,
  runProgressUnsupported,
  RUN_PROGRESS_POLL_MS,
  startRunProgress,
} from '../src/features/agents/agentRunProgressStore';
import {
  agentWorkingSnapshot,
  markAgentWorking,
  resetAgentWorking,
  sweepAgentWorking,
  ZOMBIE_CLEAR_MS,
} from '../src/features/agents/workingSignal';
import type {ChannelRail} from '../src/realtime/channelRail';
import type {AgentRunEventFrame} from '@momo/core/lib/realtimeEvents';

// =============================================================================
// 폰의 서버 진행 스토어 (ADR-0200, U4 #3750). 웹의 같은 이름 스토어와 같은 약속을
// 지킨다: 규칙(phase → 낱말)은 core가 갖고 거기서 검증된다. 여기서 지키는 것은 core가
// 알 수 없는 것이다 — **언제 다시 읽는가**, 그리고 **구 서버에서 두드리지 않는가**.
// =============================================================================

const WS = '00000000-0000-7000-8000-000000000001';
const CH_A = '00000000-0000-7000-8000-000000000201';
const CH_B = '00000000-0000-7000-8000-000000000202';
const AGENT = '00000000-0000-7000-8000-000000000301';
const RUN_1 = '0199aa11-2222-7000-8000-0000000000b1';
const T0 = 1_800_000_000_000;

function row(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: RUN_1,
    channelId: CH_A,
    agentMemberId: AGENT,
    status: 'queued',
    phase: 'queued',
    leaseState: 'none',
    stepCount: 0,
    ahead: [],
    queuePosition: 2,
    createdAtMs: T0,
    updatedAtMs: T0,
    ...extra,
  };
}

function fakeRail() {
  const handlers = new Map<
    string,
    {onRunEvent: (frame?: AgentRunEventFrame) => void; onResync: () => void}
  >();
  const stops: string[] = [];
  const rail = {
    subscribeRunEvents: (
      _ws: string,
      channelId: string,
      h: {onRunEvent: (frame?: AgentRunEventFrame) => void; onResync: () => void},
    ) => {
      handlers.set(channelId, h);
      return () => stops.push(channelId);
    },
  } as unknown as ChannelRail;
  return {rail, handlers, stops};
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  jest.useFakeTimers();
  resetRunProgress();
  resetAgentWorking();
});
afterEach(() => {
  jest.useRealTimers();
  resetRunProgress();
});

describe('진행 읽기', () => {
  it('시작하면 에이전트가 있는 채널마다 한 번 읽고, 대기 순번이 신호가 된다', async () => {
    const fetchProgress = jest.fn(async (_ws: string, ch: string) =>
      ch === CH_A ? [row()] : [],
    );
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A, CH_B, CH_A.toUpperCase()],
      rail: null,
      fetchProgress,
    });
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    expect(runProgressSignals()[0]).toMatchObject({state: 'queued', runId: RUN_1});
    expect(runFactsFor(RUN_1.toUpperCase())?.queuePosition).toBe(2);
    stop();
  });

  it('agent.run.event 프레임과 재구독이 그 채널만 다시 읽게 한다', async () => {
    const fetchProgress = jest.fn(async (_ws: string, _ch: string) => [row()]);
    const {rail, handlers} = fakeRail();
    const stop = startRunProgress({
      workspaceId: WS,
      channelIds: [CH_A, CH_B],
      rail,
      fetchProgress,
    });
    await settle();
    fetchProgress.mockClear();
    fetchProgress.mockResolvedValue([row({phase: 'claimed', queuePosition: undefined})]);
    handlers.get(CH_A)?.onRunEvent();
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchProgress.mock.calls[0]?.[1]).toBe(CH_A);
    expect(runFactsFor(RUN_1)?.phase).toBe('claimed');
    // 끊겼다 돌아온 폰: 놓친 프레임은 오지 않으므로 재구독이 읽기를 부른다.
    fetchProgress.mockClear();
    handlers.get(CH_B)?.onResync();
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchProgress.mock.calls[0]?.[1]).toBe(CH_B);
    stop();
  });

  it('프레임이 몰려도 읽기는 겹치지 않고 끝난 뒤 한 번 더 읽는다', async () => {
    let release: (rows: AgentRunProgress[]) => void = () => {};
    const fetchProgress = jest.fn(
      () => new Promise<AgentRunProgress[]>(resolve => (release = resolve)),
    );
    const {rail, handlers} = fakeRail();
    const stop = startRunProgress({workspaceId: WS, channelIds: [CH_A], rail, fetchProgress});
    await settle();
    for (let i = 0; i < 5; i += 1) {
      handlers.get(CH_A)?.onRunEvent();
    }
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    release([row()]);
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    release([row()]);
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    stop();
  });

  it('열린 run이 있는 동안에만 30초마다 다시 읽는다', async () => {
    const fetchProgress = jest.fn(async () => [row()]);
    const stop = startRunProgress({workspaceId: WS, channelIds: [CH_A], rail: null, fetchProgress});
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(RUN_PROGRESS_POLL_MS);
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(2);

    fetchProgress.mockResolvedValue([row({phase: 'succeeded', status: 'succeeded'})]);
    jest.advanceTimersByTime(RUN_PROGRESS_POLL_MS);
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(RUN_PROGRESS_POLL_MS * 4);
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(3);
    expect(runProgressSignals()).toEqual([]);
    stop();
  });

  it('멈추면 구독과 타이머를 놓는다 (백그라운드 정책이 소켓을 접을 때)', async () => {
    const fetchProgress = jest.fn(async () => [row()]);
    const {rail, stops} = fakeRail();
    const stop = startRunProgress({workspaceId: WS, channelIds: [CH_A, CH_B], rail, fetchProgress});
    await settle();
    stop();
    expect([...stops].sort()).toEqual([CH_A, CH_B].sort());
    fetchProgress.mockClear();
    jest.advanceTimersByTime(RUN_PROGRESS_POLL_MS * 3);
    await settle();
    expect(fetchProgress).not.toHaveBeenCalled();
  });
});

describe('구 서버 후퇴 경로', () => {
  it('404는 한 번 확인하고 접는다: 이후 프레임·타이머가 요청을 만들지 않는다', async () => {
    const fetchProgress = jest.fn(async () => {
      throw new ApiError(404, 'not found');
    });
    const {rail, handlers} = fakeRail();
    const stop = startRunProgress({workspaceId: WS, channelIds: [CH_A, CH_B], rail, fetchProgress});
    await settle();
    expect(runProgressUnsupported()).toBe(true);
    const calls = fetchProgress.mock.calls.length;
    handlers.get(CH_A)?.onRunEvent();
    jest.advanceTimersByTime(RUN_PROGRESS_POLL_MS * 5);
    await settle();
    expect(fetchProgress.mock.calls.length).toBe(calls);
    expect(runProgressSignals()).toEqual([]);
    stop();
  });

  it('읽지 못하는 모양도 같다', async () => {
    const fetchProgress = jest.fn(async () => {
      throw new WireShapeError();
    });
    const stop = startRunProgress({workspaceId: WS, channelIds: [CH_A], rail: null, fetchProgress});
    await settle();
    expect(runProgressUnsupported()).toBe(true);
    stop();
  });

  it('네트워크·5xx는 접지 않는다: 직전 답을 두고 다음에 다시 읽는다', async () => {
    const fetchProgress = jest
      .fn()
      .mockResolvedValueOnce([row()])
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockResolvedValue([row({phase: 'claimed', queuePosition: undefined})]);
    const stop = startRunProgress({workspaceId: WS, channelIds: [CH_A], rail: null, fetchProgress});
    await settle();
    jest.advanceTimersByTime(RUN_PROGRESS_POLL_MS);
    await settle();
    expect(runProgressUnsupported()).toBe(false);
    expect(runFactsFor(RUN_1)?.phase).toBe('queued');
    jest.advanceTimersByTime(RUN_PROGRESS_POLL_MS);
    await settle();
    expect(runFactsFor(RUN_1)?.phase).toBe('claimed');
    stop();
  });
});

describe('서버가 답한 신호는 폰의 시계로 지워지지 않는다', () => {
  it('zombie 청소는 server 신호를 건드리지 않는다 — 11분 대기도 그대로다', async () => {
    jest.setSystemTime(T0 + 11 * 60_000);
    const fetchProgress = jest.fn(async () => [row()]);
    const stop = startRunProgress({workspaceId: WS, channelIds: [CH_A], rail: null, fetchProgress});
    await settle();
    const signal = runProgressSignals()[0];
    if (signal === undefined) {
      throw new Error('signal');
    }
    markAgentWorking(signal);
    sweepAgentWorking(Date.now() + ZOMBIE_CLEAR_MS * 10);
    expect(agentWorkingSnapshot().size).toBe(1);

    // 같은 신호에서 server만 빼면 청소가 지운다 — 시험이 규칙을 잡는다는 증거.
    resetAgentWorking();
    const legacy = {...signal};
    delete legacy.server;
    markAgentWorking(legacy);
    sweepAgentWorking(Date.now() + ZOMBIE_CLEAR_MS * 10);
    expect(agentWorkingSnapshot().size).toBe(0);
    stop();
  });
});

describe('깨우는 신호와 방금 보낸 메시지 (#3824)', () => {
  it('doorbell_rung 프레임은 그 run의 원장 구독자를 깨운다', async () => {
    const fetchProgress = jest.fn(async () => [row()]);
    const {rail, handlers} = fakeRail();
    const stop = startRunProgress({workspaceId: WS, channelIds: [CH_A], rail, fetchProgress});
    await settle();
    const onLedger = jest.fn();
    const unsubscribe = subscribeRunLedgerFrames(RUN_1.toUpperCase(), onLedger);
    handlers.get(CH_A)?.onRunEvent({
      type: 'agent.run.event',
      v: 1,
      ts: Date.now(),
      payload: {run_id: RUN_1, channel_id: CH_A, kind: 'doorbell_rung'},
    });
    expect(onLedger).toHaveBeenCalledTimes(1);
    // 프레임 없이 부르는 옛 레일도 진행은 다시 읽고 원장 구독자는 건드리지 않는다.
    handlers.get(CH_A)?.onRunEvent();
    expect(onLedger).toHaveBeenCalledTimes(1);
    unsubscribe();
    stop();
  });

  it('방금 보낸 메시지가 지켜보는 채널만 한 번 당겨 읽는다', async () => {
    const fetchProgress = jest.fn(async (_ws: string, _ch: string) => [row()]);
    const stop = startRunProgress({workspaceId: WS, channelIds: [CH_A], rail: null, fetchProgress});
    await settle();
    fetchProgress.mockClear();
    nudgeRunProgress(CH_A.toUpperCase());
    nudgeRunProgress(CH_B);
    await settle();
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchProgress.mock.calls[0]?.[1]).toBe(CH_A);
    stop();
  });
});

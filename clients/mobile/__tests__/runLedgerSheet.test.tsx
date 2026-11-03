import type {AgentRunProgress, RosterMember} from '@momo/core/lib/api';
import {runPhaseLabel} from '@momo/core/features/agents/runPhase';
import {RUN_STATUS_WOKEN_FAILED} from '@momo/core/features/agents/runStatusLine';
import {UNCOLLECTED_WORD} from '@momo/core/features/agents/runWaiting';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';
import {RequestThinkingLine, REQUEST_THINKING_HEIGHT} from '../src/features/agents/RequestThinkingLine';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';
import type {AgentProgressEvent} from '@momo/core/lib/realtimeEvents';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {RunLedgerSheet} from '../src/features/agents/RunLedgerSheet';
import {GroupCard} from '../src/design/sheetParts';
import {describeCloseContract} from './fixtures/sheetContract';
import {MessageRunStatus} from '../src/features/agents/MessageRunStatus';
import {notifyRunLedgerFrame} from '../src/features/agents/agentRunProgressStore';

// =============================================================================
// 폰의 run 기록 시트와 메시지 아래 상태 줄 (#3824). 말은 core가 갖고 거기서 검증된다.
// 여기서 지키는 것: 폰에서 기록이 열리는가, 원장을 `?include=doorbell`로 읽는가, 이 앱이
// 모르는 원장 종류가 와도 시트가 깨지지 않는가, 깨우는 신호 프레임이 오면 다시 읽는가.
// 문구를 mock하지 않는다.
// =============================================================================

const WS = '00000000-0000-7000-8000-000000000001';
const AGENT = '00000000-0000-7000-8000-000000000301';
const CH = '00000000-0000-7000-8000-000000000201';
const RUN = '0199aa11-2222-7000-8000-0000000000b1';
const MSG = '00000000-0000-7000-8000-0000000a0001';
const SEC = 1000;
const MIN = 60 * SEC;

const mockFetchEvents = jest.fn();
const mockCancel = jest.fn();

jest.mock('../src/session/useSession', () => ({
  ...jest.requireActual('../src/session/useSession'),
  useSession: () => ({
    workspaceId: '00000000-0000-7000-8000-000000000001',
    member: {id: '00000000-0000-7000-8000-000000000101'},
  }),
}));
jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  fetchAgentRunEvents: (ws: string, run: string, options?: unknown) =>
    mockFetchEvents(ws, run, options),
  cancelAgentRun: (ws: string, run: string) => mockCancel(ws, run),
}));

const directory = makeDirectory([
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
]);

let client: QueryClient | null = null;

afterEach(() => {
  cleanup();
  client?.clear();
  client = null;
  mockFetchEvents.mockReset();
  mockCancel.mockReset();
});

function progress(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  const now = Date.now();
  return {
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: MSG,
    triggerSummary: '채널 하나 만들어 줄래요?',
    status: 'succeeded',
    phase: 'succeeded',
    leaseState: 'none',
    stepCount: 2,
    ahead: [],
    claimedAtMs: now - 10 * MIN + 12 * SEC,
    startedAtMs: now - 10 * MIN + 14 * SEC,
    finishedAtMs: now - 10 * MIN + 3 * MIN + 12 * SEC,
    createdAtMs: now - 10 * MIN,
    updatedAtMs: now - 7 * MIN,
    ...extra,
  };
}

function wrap(ui: React.ReactElement): React.ReactElement {
  client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

describe('요청 스레드의 생각 줄', () => {
  beforeEach(() => mockFetchEvents.mockResolvedValue({runId: RUN, events: []}));
  it('빈 예약 칸·생각·승인·끝·사라짐의 높이는 같아요', () => {
    const view = render(wrap(<RequestThinkingLine directory={directory} nowMs={Date.now()} />));
    const height = () => StyleSheet.flatten(screen.getByTestId('request-thinking-slot').props.style).minHeight;
    const reserved = height();
    expect(reserved).toBeGreaterThanOrEqual(REQUEST_THINKING_HEIGHT);
    for (const phase of ['running', 'awaiting_approval', 'succeeded'] as const) {
      view.rerender(<QueryClientProvider client={client!}><RequestThinkingLine progress={progress({phase})} directory={directory} nowMs={Date.now()} /></QueryClientProvider>);
      expect(height()).toBe(reserved);
    }
    view.rerender(<QueryClientProvider client={client!}><RequestThinkingLine directory={directory} nowMs={Date.now()} /></QueryClientProvider>);
    expect(height()).toBe(reserved);
  });
  it('단계는 40자까지이고 국면이 바뀔 때만 낭독해요', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const view = render(wrap(<RequestThinkingLine progress={progress({phase: 'running', latestStage: '한'.repeat(80)})} directory={directory} nowMs={Date.now()} />));
    announce.mockClear();
    const update = (phase: AgentRunProgress['phase'], latestStage: string) => view.rerender(<QueryClientProvider client={client!}><RequestThinkingLine progress={progress({phase, latestStage})} directory={directory} nowMs={Date.now()} /></QueryClientProvider>);
    expect(screen.getByTestId('request-thinking-line')).not.toHaveTextContent('한'.repeat(41));
    update('running', '다음 단계');
    expect(announce).not.toHaveBeenCalled();
    update('awaiting_approval', '다음 단계');
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('그록봇 · 승인 필요');
    announce.mockRestore();
  });
  it('펼친 뒤 받은 흐르는 글만 보이고 접기·종결 뒤에는 남지 않아요', () => {
    let receive: ((event: AgentProgressEvent) => void) | undefined;
    const stop = jest.fn();
    const rail = {subscribeAgent: (_ws: string, _ch: string, _agent: string, handlers: {onEvent: typeof receive}) => { receive = handlers.onEvent; return stop; }};
    const ui = (phase: AgentRunProgress['phase']) => <QueryClientProvider client={client!}>
      <RealtimeContext.Provider value={{rail: rail as never, status: 'connected', subscriptionsWanted: true}}>
        <RequestThinkingLine progress={progress({phase})} directory={directory} nowMs={Date.now()} />
      </RealtimeContext.Provider>
    </QueryClientProvider>;
    client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
    const view = render(ui('running'));
    fireEvent.press(screen.getByTestId('request-thinking-line'));
    act(() => receive?.({type: 'agent.partial', v: 1, ts: Date.now(), payload: {run_id: RUN, channel_id: CH, text_delta: '이 칸을 연 뒤 온 글'}}));
    expect(screen.getByTestId('request-thinking-stream')).toHaveTextContent('이 칸을 연 뒤 온 글');
    fireEvent.press(screen.getByTestId('request-thinking-line'));
    expect(stop).toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('request-thinking-line'));
    expect(screen.queryByTestId('request-thinking-stream')).toBeNull();
    act(() => receive?.({type: 'agent.partial', v: 1, ts: Date.now(), payload: {run_id: RUN, channel_id: CH, text_delta: '새 글'}}));
    view.rerender(ui('succeeded'));
    expect(screen.queryByTestId('request-thinking-stream')).toBeNull();
  });
  it('빈 과정과 원장 프레임 뒤 새 단계를 같은 펼친 칸에서 읽어요', async () => {
    render(wrap(<RequestThinkingLine progress={progress({phase: 'running'})} directory={directory} nowMs={Date.now()} />));
    fireEvent.press(screen.getByTestId('request-thinking-line'));
    await waitFor(() => expect(screen.getByText('아직 받은 과정이 없어요')).toBeTruthy());
    mockFetchEvents.mockResolvedValue({runId: RUN, events: [{ordinal: 1, kind: 'stage', stage: '프로필을 읽었어요', createdAtMs: Date.now()}]});
    act(() => notifyRunLedgerFrame(RUN));
    await waitFor(() => expect(screen.getByText('프로필을 읽었어요')).toBeTruthy());
  });
  it.each(['approval_rejected', 'approval_expired'])('%s는 예외 문장 줄이 서지 않아요', endReason => {
    render(wrap(<MessageRunStatus messageId={MSG} channelId={CH} createdAtMs={0}
      runs={[progress({phase: endReason === 'approval_rejected' ? 'cancelled' : 'timed_out', endReason})]} directory={directory} />));
    expect(screen.queryByTestId(`message-run-status-row-${RUN}`)).toBeNull();
  });
});

describe('폰 기록 시트 (#3824)', () => {
  it('모르는 원장 종류가 섞여 와도 기록이 서고, 깨우는 신호는 접혀 횟수가 붙는다', async () => {
    const at = Date.now() - 10 * MIN;
    mockFetchEvents.mockResolvedValue(
      jest.requireActual('@momo/core/lib/api').agentRunLedgerFromWire({
        runId: RUN,
        events: [
          {ordinal: 1, kind: 'queued', createdAtMs: at},
          {ordinal: 2, kind: 'doorbell_rung', code: 'leading_ok', createdAtMs: at + 1 * SEC},
          {ordinal: 3, kind: 'doorbell_rung', code: 'trailing_ok', createdAtMs: at + 5 * SEC},
          // `tool_call`은 코어가 아는 종류가 됐다(#4654). 서버가 앞서 늘릴 새 종류는 가상의 낱말로 잰다.
          {ordinal: 4, kind: 'future_kind', code: 'ok', createdAtMs: at + 6 * SEC},
          {ordinal: 5, kind: 'claimed', createdAtMs: at + 12 * SEC},
          {ordinal: 6, kind: 'succeeded', createdAtMs: at + 3 * MIN + 12 * SEC},
        ],
      }),
    );
    render(wrap(<RunLedgerSheet progress={progress()} directory={directory} onClose={() => {}} />));
    await waitFor(() => expect(screen.getByTestId('run-ledger-rows')).toBeTruthy());
    // 웹 작업 패널과 같은 질문이다(깨우는 신호 + oort가 잰 도구 호출 + 에이전트가 알린 활동·계획): 같은 키의 캐시를 나눠 쓴다.
    expect(mockFetchEvents).toHaveBeenCalledWith(WS, RUN, {
      includeDoorbell: true,
      includeTools: true,
      includeActivity: true,
    });
    expect(screen.getByText(/깨우는 신호를 보냈어요/)).toBeTruthy();
    expect(screen.getByText(/· 2번/)).toBeTruthy();
    expect(screen.getByText('이 앱이 아직 모르는 기록이에요')).toBeTruthy();
    expect(screen.getByTestId('run-ledger-phase').props.children).toBe('완료');
    expect(screen.getByTestId('run-ledger-detail').props.children).toBe('3분 12초 걸림');
    expect(screen.getByTestId('run-ledger-durations').props.children).toBe(
      '대기 12초 → 작업 2분 58초 → 총 3분 12초',
    );
    expect(screen.getByTestId('run-ledger-agent').props.children).toBe('그록봇');
    // 「3분 / 12초」·「2분 / 58초」가 음절 사이에서 갈리지 않게 어절 단위로 접는다.
    expect(screen.getByTestId('run-ledger-detail').props.lineBreakStrategyIOS).toBe(
      'hangul-word',
    );
    expect(screen.getByTestId('run-ledger-durations').props.lineBreakStrategyIOS).toBe(
      'hangul-word',
    );
  });

  // 낱말을 고르는 규칙은 코어 `runStateWord` 하나다(홈 카드·웹 패널 머리 칩·목록 칩과 같다). 시트의 칩이 그것을 부르는지
  // 세 장면으로 잰다(#4285 design-review r1 H5: 시트만 「대기 1번째」로 말하던 것).
  it.each([
    ['가져가는 이 없이 5분을 넘은 사람 요청은 「아직 받지 않았어요」', 17 * 60 * MIN, {}, '아직 받지 않았어요'],
    ['5분 안의 요청은 서버의 낱말 그대로 「대기 1번째」', 2 * MIN, {}, '대기 1번째'],
    [
      '부른 사람이 없는 시스템 작업은 오래 기다려도 「대기 1번째」 그대로',
      17 * 60 * MIN,
      {triggerMessageId: undefined, triggerSummary: undefined, system: true},
      '대기 1번째',
    ],
  ] as const)('시트의 상태 칩: %s', async (_name, waited, extra, word) => {
    const now = Date.now();
    mockFetchEvents.mockResolvedValue(
      jest.requireActual('@momo/core/lib/api').agentRunLedgerFromWire({
        runId: RUN,
        events: [{ordinal: 1, kind: 'queued', createdAtMs: now - waited}],
      }),
    );
    const queued = progress({
      status: 'queued',
      phase: 'queued',
      leaseState: 'none',
      claimedAtMs: undefined,
      startedAtMs: undefined,
      finishedAtMs: undefined,
      queuePosition: 1,
      createdAtMs: now - waited,
      updatedAtMs: now - waited,
      ...extra,
    });
    render(wrap(<RunLedgerSheet progress={queued} directory={directory} onClose={() => {}} />));
    await waitFor(() => expect(screen.getByTestId('run-ledger-rows')).toBeTruthy());
    expect(screen.getByTestId('run-ledger-phase').props.children).toBe(word);
  });

  it('읽지 못하면 침묵하지 않고 다시 시도를 준다', async () => {
    mockFetchEvents.mockRejectedValue(new Error('network'));
    render(wrap(<RunLedgerSheet progress={progress()} directory={directory} onClose={() => {}} />));
    // 원장 읽기는 한 번 다시 시도한다(`runLedgerQueryOptions.retry`).
    await waitFor(() => expect(screen.getByTestId('run-ledger-error')).toBeTruthy(), {
      timeout: 4000,
    });
    expect(screen.getByText('기록을 읽지 못했어요.')).toBeTruthy();
  });
});

describe('폰 메시지 아래 예외 줄 (#4620 D: 사람이 움직여야 할 수 있는 상태만, 초 단위 시계 없음)', () => {
  const REQUESTER = '00000000-0000-7000-8000-000000000101';
  const BYSTANDER = '00000000-0000-7000-8000-000000000102';
  const ADMIN = '00000000-0000-7000-8000-000000000103';
  const person = (id: string, role: string) =>
    ({
      id,
      workspaceId: WS,
      kind: 'human',
      status: 'active',
      displayName: id.slice(-3),
      handle: id.slice(-3),
      role,
      channelCount: 1,
      channelIds: [CH],
      capabilities: [],
      createdAtMs: 0,
      updatedAtMs: 0,
    }) as unknown as RosterMember;
  const people = makeDirectory([
    ...(directory.byId.size > 0 ? [...directory.byId.values()] : []),
    person(REQUESTER, 'member'),
    person(BYSTANDER, 'member'),
    person(ADMIN, 'admin'),
  ]);
  const mount = (
    run: AgentRunProgress,
    extra: Partial<React.ComponentProps<typeof MessageRunStatus>> = {},
  ) =>
    render(
      wrap(
        <MessageRunStatus
          messageId={MSG}
          channelId={CH}
          createdAtMs={Date.now() - 3 * SEC}
          runs={[run]}
          directory={people}
          requesterId={REQUESTER}
          viewerId={REQUESTER}
          onOpenProfile={() => {}}
          {...extra}
        />,
      ),
    );
  const base = (extra: Partial<AgentRunProgress>) =>
    progress({
      status: 'queued',
      phase: 'queued',
      claimedAtMs: undefined,
      startedAtMs: undefined,
      finishedAtMs: undefined,
      createdAtMs: Date.now() - 3 * SEC,
      ...extra,
    });
  const row = () => screen.queryByTestId(`message-run-status-row-${RUN}`);
  const waitedFor = (ms: number): Partial<AgentRunProgress> => ({
    createdAtMs: Date.now() - ms,
    updatedAtMs: Date.now() - ms,
  });

  it('평소의 진행·완료는 줄을 세우지 않는다: 깨우는 신호가 닿은 대기·가져감·작업 중·완료·취소', async () => {
    const now = Date.now();
    mockFetchEvents.mockResolvedValue({
      runId: RUN,
      events: [
        {ordinal: 1, kind: 'queued', createdAtMs: now - 3 * SEC},
        {ordinal: 2, kind: 'doorbell_rung', code: 'leading_ok', createdAtMs: now - 2 * SEC},
      ],
    });
    for (const extra of [
      {},
      {status: 'claimed', phase: 'claimed', leaseState: 'live', claimedAtMs: now - 5 * SEC},
      {status: 'running', phase: 'running', leaseState: 'live', startedAtMs: now - 60 * SEC},
      {status: 'succeeded', phase: 'succeeded', finishedAtMs: now - SEC},
      {status: 'cancelled', phase: 'cancelled', endReason: 'human_cancelled', finishedAtMs: now - SEC},
    ] as Partial<AgentRunProgress>[]) {
      const view = mount(base(extra));
      await act(async () => {
        await Promise.resolve();
      });
      expect(row()).toBeNull();
      view.unmount();
    }
  });

  it('깨우는 신호가 닿지 않으면 줄이 서고(유예를 기다리지 않는다), 누르면 기록 시트가 열린다', async () => {
    const now = Date.now();
    mockFetchEvents.mockResolvedValue({
      runId: RUN,
      events: [
        {ordinal: 1, kind: 'queued', createdAtMs: now - 3 * SEC},
        {ordinal: 2, kind: 'doorbell_rung', code: 'urgent_failed', createdAtMs: now - 2 * SEC},
      ],
    });
    mount(base({}));
    // 원장을 읽기 전에는 줄이 없다: 닿았는지 모르는 채로 아무 말도 하지 않는다.
    expect(row()).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('message-run-status-headline')).toHaveTextContent(RUN_STATUS_WOKEN_FAILED),
    );
    // 「깨우는 신호가 닿지 않음」이 「깨우는 신호 / 가 …」로 갈리지 않게(#3824 리뷰).
    expect(screen.getByTestId('message-run-status-text').props.lineBreakStrategyIOS).toBe('hangul-word');
    // 초 단위·분 단위 숫자가 없다(경과를 말하지 않는다).
    expect(screen.getByTestId('message-run-status-text')).not.toHaveTextContent(/\d/);
    fireEvent.press(screen.getByTestId(`message-run-status-open-${RUN}`));
    await waitFor(() => expect(screen.getByTestId('run-ledger-sheet')).toBeTruthy());
  });

  it('줄은 네 가지다: 실패 · 신호 소실 · 아직 받지 않았어요(열림) · 서버가 그래서 끝낸 것(같은 낱말). 승인 대기·소식 끊긴 가져감은 줄이 아니다', async () => {
    const now = Date.now();
    mockFetchEvents.mockResolvedValue({runId: RUN, events: []});
    const cases: [Partial<AgentRunProgress>, string][] = [
      [{status: 'failed', phase: 'failed', claimedAtMs: now - 9 * SEC, finishedAtMs: now - SEC}, runPhaseLabel({phase: 'failed', leaseState: 'none', queuedAtMs: 0})],
      [{status: 'timed_out', phase: 'timed_out', endReason: 'lease_abandoned', finishedAtMs: now - SEC}, runPhaseLabel({phase: 'timed_out', leaseState: 'none', queuedAtMs: 0, endReason: 'lease_abandoned'})],
      [{...waitedFor(6 * MIN)}, UNCOLLECTED_WORD],
      [{status: 'timed_out', phase: 'timed_out', endReason: 'unclaimed_expired', finishedAtMs: now - SEC}, UNCOLLECTED_WORD],
    ];
    for (const [extra, word] of cases) {
      const view = mount(base(extra));
      await waitFor(() => expect(screen.getByTestId('message-run-status-headline')).toHaveTextContent(word));
      view.unmount();
    }
    for (const extra of [
      {status: 'awaiting_approval', phase: 'awaiting_approval', leaseState: 'live', claimedAtMs: now - 9 * SEC, startedAtMs: now - 8 * SEC},
      {status: 'claimed', phase: 'claimed', leaseState: 'stale', claimedAtMs: now - 6 * MIN},
    ] as Partial<AgentRunProgress>[]) {
      const view = mount(base(extra));
      await act(async () => {
        await Promise.resolve();
      });
      expect(row()).toBeNull();
      view.unmount();
    }
  });

  it('시계가 없다: 간격 시계(setInterval)를 쓰지 않고, 유예 마감에 한 번만 다시 그려 「아직 받지 않았어요」가 선다', async () => {
    mockFetchEvents.mockResolvedValue({runId: RUN, events: [{ordinal: 1, kind: 'queued', createdAtMs: Date.now()}]});
    const interval = jest.spyOn(global, 'setInterval');
    // 마감(5분)까지 0.4초 남은 대기: 처음에는 줄이 없고, 마감에 줄이 선다.
    mount(base(waitedFor(5 * MIN - 400)));
    expect(row()).toBeNull();
    await waitFor(() => expect(row()).toBeTruthy(), {timeout: 2500});
    expect(screen.getByTestId('message-run-status-headline')).toHaveTextContent(UNCOLLECTED_WORD);
    // 줄은 초 단위 시계를 마운트하지 않는다. (질의 라이브러리의 1분 재조회와 테스트 도구의 50ms 대기 시계는 이 줄의 것이 아니다.)
    const fast = interval.mock.calls.filter(
      ([callback, delay]) =>
        (delay as number) <= 1_000 &&
        (callback as {name?: string}).name !== 'checkRealTimersCallback',
    );
    expect(fast).toEqual([]);
    interval.mockRestore();
  });

  it('행동 단추는 요청자와 owner/admin에게만 선다 — 구경꾼에게는 문장만이고, 끝난 run에는 행동이 없다', async () => {
    mockFetchEvents.mockResolvedValue({runId: RUN, events: []});
    const waiting = base(waitedFor(6 * MIN));
    const settings = `message-run-status-settings-${RUN}`;
    const cancel = `run-exception-stop-${RUN}-arm`;
    const mine = mount(waiting);
    await waitFor(() => expect(screen.getByTestId(settings)).toBeTruthy());
    expect(screen.getByTestId(cancel)).toBeTruthy();
    mine.unmount();
    const admin = mount(waiting, {viewerId: ADMIN});
    await waitFor(() => expect(screen.getByTestId(settings)).toBeTruthy());
    expect(screen.getByTestId(cancel)).toBeTruthy();
    admin.unmount();
    const bystander = mount(waiting, {viewerId: BYSTANDER});
    await waitFor(() => expect(screen.getByTestId('message-run-status-headline')).toBeTruthy());
    expect(screen.queryByTestId(settings)).toBeNull();
    expect(screen.queryByTestId(cancel)).toBeNull();
    bystander.unmount();
    // 설정을 열 곳이 없으면 죽은 단추를 세우지 않는다.
    const noProfile = mount(waiting, {onOpenProfile: undefined});
    await waitFor(() => expect(screen.getByTestId(cancel)).toBeTruthy());
    expect(screen.queryByTestId(settings)).toBeNull();
    noProfile.unmount();
    // 끝난 run(실패)에는 되돌릴 행동이 없다.
    mount(base({status: 'failed', phase: 'failed', claimedAtMs: Date.now() - 9 * SEC, finishedAtMs: Date.now() - SEC}));
    await waitFor(() => expect(screen.getByTestId('message-run-status-headline')).toBeTruthy());
    expect(screen.queryByTestId(cancel)).toBeNull();
    expect(screen.queryByTestId(settings)).toBeNull();
  });

  it('설정 열기는 그 에이전트의 프로필을 연다', async () => {
    mockFetchEvents.mockResolvedValue({runId: RUN, events: []});
    const open = jest.fn();
    mount(base(waitedFor(6 * MIN)), {onOpenProfile: open});
    await waitFor(() => expect(screen.getByTestId(`message-run-status-settings-${RUN}`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`message-run-status-settings-${RUN}`));
    expect(open).toHaveBeenCalledWith(AGENT);
  });

  it('취소 영수증은 줄이 사라져도 남는다 — 취소를 확정하면 run이 취소로 넘어가 예외가 걷히지만 결과 문장은 같은 자리에 남는다', async () => {
    mockFetchEvents.mockResolvedValue({runId: RUN, events: []});
    mockCancel.mockResolvedValue({runId: RUN, status: 'cancelled', linkedWorkSessionIds: []});
    const waiting = base(waitedFor(6 * MIN));
    const view = mount(waiting);
    await waitFor(() => expect(screen.getByTestId(`run-exception-stop-${RUN}-arm`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`run-exception-stop-${RUN}-arm`));
    await waitFor(() => expect(screen.getByTestId(`run-exception-stop-${RUN}-commit`)).toBeTruthy());
    const real = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + 2_000);
    fireEvent.press(screen.getByTestId(`run-exception-stop-${RUN}-commit`));
    (Date.now as unknown as jest.Mock).mockRestore();
    await waitFor(() => expect(screen.getByTestId('run-exception-stop-outcome-cancelled')).toBeTruthy());
    expect(mockCancel).toHaveBeenCalledWith(WS, RUN);
    // 서버가 취소로 넘기면 예외가 걷힌다 — 영수증은 남는다.
    view.rerender(
      wrap(
        <MessageRunStatus
          messageId={MSG}
          channelId={CH}
          createdAtMs={Date.now() - 3 * SEC}
          runs={[{...waiting, status: 'cancelled', phase: 'cancelled', endReason: 'human_cancelled'}]}
          directory={people}
          requesterId={REQUESTER}
          viewerId={REQUESTER}
        />,
      ),
    );
    expect(screen.queryByTestId('message-run-status-headline')).toBeNull();
    expect(screen.getByTestId('run-exception-stop-outcome-cancelled')).toBeTruthy();
  });

  it('run이 없으면 아무것도 그리지 않는다(옛 서버)', () => {
    render(
      wrap(
        <MessageRunStatus
          messageId={MSG}
          channelId={CH}
          createdAtMs={Date.now() - 60 * MIN}
          runs={[]}
          directory={directory}
        />,
      ),
    );
    expect(screen.queryByTestId('message-run-status')).toBeNull();
    expect(mockFetchEvents).not.toHaveBeenCalled();
  });
});

// ---- 공용 시트로 (#4458) ------------------------------------------------------------------

function ledgerOf(count: number) {
  const at = Date.now() - 10 * MIN;
  const kinds = ['queued', 'claimed', 'succeeded'].slice(0, count);
  return jest.requireActual('@momo/core/lib/api').agentRunLedgerFromWire({
    runId: RUN,
    events: kinds.map((kind, index) => ({ordinal: index + 1, kind, createdAtMs: at + index * SEC})),
  });
}

/** 그려진 트리에서 testID 를 **그려진 순서**(깊이 우선)대로 모은다 — 「무엇이 무엇보다 위에 서는가」를 재는 데 쓴다. */
interface DrawNode {
  props: {testID?: unknown};
  children: Array<DrawNode | string> | null;
}
function testIDsInDrawOrder(node: DrawNode | DrawNode[] | string | null): string[] {
  if (node === null || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap((child: DrawNode) => testIDsInDrawOrder(child));
  const own = typeof node.props.testID === 'string' ? [node.props.testID] : [];
  const kids: Array<DrawNode | string> = node.children ?? [];
  return [...own, ...kids.flatMap((child: DrawNode | string) => testIDsInDrawOrder(child))];
}

describe('폰 기록 시트 — 공용 부품 (#4458)', () => {
  it('한계·보관 문장은 「기록」 라벨 아래, 목록 위에 그려진다 — 스크롤을 내려야만 보이는 각주가 아니다 (ADR-0200 D5, design-review r1b M1)', async () => {
    mockFetchEvents.mockResolvedValue(ledgerOf(3));
    render(wrap(<RunLedgerSheet progress={progress()} directory={directory} onClose={() => {}} />));
    await waitFor(() => expect(screen.getByTestId('run-ledger-rows')).toBeTruthy());
    const order = testIDsInDrawOrder(screen.toJSON());
    const at = (id: string) => order.indexOf(id);
    expect(at('run-ledger-limit')).toBeGreaterThan(-1);
    // 그려진 순서: 한계 → 보관 → 목록. 목록 뒤에 서면(1단계의 각주) 붉어진다.
    expect(at('run-ledger-limit')).toBeLessThan(at('run-ledger-kept'));
    expect(at('run-ledger-kept')).toBeLessThan(at('run-ledger-rows'));
    // 별도 푸터가 아니라 같은 스크롤 몸 안이고, 문장은 코어의 것 그대로다.
    const scroll = within(screen.getByTestId('run-ledger-scroll'));
    expect(scroll.getByTestId('run-ledger-limit')).toHaveTextContent(/에이전트가 보낸 만큼만 보여요/);
    expect(scroll.getByTestId('run-ledger-kept')).toBeTruthy();
  });

  it('요약·기록 줄·한계 문장은 어절 단위로 접는다 — 「…으로 / 요.」처럼 한 음절이 줄 머리에 고아로 서지 않는다 (design-review r1b M2)', async () => {
    const at = Date.now() - 10 * MIN;
    mockFetchEvents.mockResolvedValue(
      jest.requireActual('@momo/core/lib/api').agentRunLedgerFromWire({
        runId: RUN,
        events: [
          {ordinal: 1, kind: 'queued', createdAtMs: at},
          {ordinal: 2, kind: 'doorbell_rung', code: 'leading_ok', createdAtMs: at + SEC},
        ],
      }),
    );
    render(
      wrap(
        <RunLedgerSheet
          progress={progress({triggerSummary: '채널 하나 만들어 줄래요? 이름은 grokbot-lab으로요.'})}
          directory={directory}
          onClose={() => {}}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('run-ledger-rows')).toBeTruthy());
    for (const id of ['run-ledger-summary', 'run-ledger-limit', 'run-ledger-kept']) {
      expect(screen.getByTestId(id).props.lineBreakStrategyIOS).toBe('hangul-word');
    }
    // 기록 줄의 본문(시각 라벨이 아니라 글)도 같다.
    expect(screen.getByText(/깨우는 신호를 보냈어요/).props.lineBreakStrategyIOS).toBe('hangul-word');
  });

  it('빈 기록의 머리말·설명도 어절 단위로 접는다 — 같은 시트의 다른 문장과 같은 규칙이다 (design-review r2 L2)', async () => {
    mockFetchEvents.mockResolvedValue(ledgerOf(0));
    render(wrap(<RunLedgerSheet progress={progress()} directory={directory} onClose={() => {}} />));
    await waitFor(() => expect(screen.getByTestId('run-ledger-empty')).toBeTruthy());
    for (const id of ['run-ledger-empty-headline', 'run-ledger-empty-detail']) {
      expect(screen.getByTestId(id).props.lineBreakStrategyIOS).toBe('hangul-word');
    }
  });

  it('요약은 카드 하나, 기록 줄은 묶음 카드의 줄이고 줄 사이는 카드의 구분선이다 — 글자 「닫기」·줄마다 아래 테두리는 없다', async () => {
    mockFetchEvents.mockResolvedValue(ledgerOf(3));
    render(wrap(<RunLedgerSheet progress={progress()} directory={directory} onClose={() => {}} />));
    await waitFor(() => expect(screen.getByTestId('run-ledger-rows')).toBeTruthy());
    // 「기록」은 묶음 카드 하나다. 이 응답은 구 서버의 것이라(`toolTally`·`activityTally` 없음) 아래 두 칸은 「서버 업데이트 뒤에 보여요」
    // 상태 카드 한 장씩이다 — 그 칸들의 시험은 `workTimelineSheet.test`가 맡는다. 요약 카드 하나 + 기록 + 상태 카드 둘 = 넷.
    expect(within(screen.getByTestId('run-ledger-record')).UNSAFE_getAllByType(GroupCard)).toHaveLength(1);
    expect(screen.UNSAFE_getAllByType(GroupCard)).toHaveLength(4);
    // 기록 셋 → 구분선 둘. 요약 카드는 자식이 하나라 구분선이 없다.
    expect(screen.getAllByTestId('group-divider')).toHaveLength(2);
    expect(screen.getAllByTestId(/^run-ledger-row-/)).toHaveLength(3);
    expect(screen.queryByText('닫기')).toBeNull();
  });

  it('기록을 읽는 중·못 읽음도 카드 안에 선다 — 상태 블록의 가로 여백이 시트 몸의 거터와 겹치지 않는다', async () => {
    mockFetchEvents.mockImplementation(() => new Promise(() => {}));
    render(wrap(<RunLedgerSheet progress={progress()} directory={directory} onClose={() => {}} />));
    await waitFor(() => expect(screen.getByTestId('run-ledger-loading')).toBeTruthy());
    expect(screen.UNSAFE_getAllByType(GroupCard)).toHaveLength(2);
  });
});

const closed = jest.fn();
beforeEach(() => closed.mockReset());

describeCloseContract({
  name: 'RunLedgerSheet',
  open: async () => {
    mockFetchEvents.mockResolvedValue(ledgerOf(2));
    render(wrap(<RunLedgerSheet progress={progress()} directory={directory} onClose={closed} />));
    await waitFor(() => expect(screen.getByTestId('run-ledger-rows')).toBeTruthy());
  },
  closedCount: () => closed.mock.calls.length,
  closeTestID: 'run-ledger-close',
  closeLabel: '작업 기록 닫기',
  scrimTestID: 'page-sheet-scrim',
  scrimLabel: '작업 기록 닫기',
});

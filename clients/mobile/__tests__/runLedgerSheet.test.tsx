import type {AgentRunProgress} from '@momo/core/lib/api';
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
    expect(mockFetchEvents).toHaveBeenCalledWith(WS, RUN, {includeDoorbell: true});
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

describe('폰 메시지 아래 상태 줄 (#3824, #4020: 사람이 알아야 하는 상태만)', () => {
  const mount = (run: AgentRunProgress) =>
    render(
      wrap(
        <MessageRunStatus
          messageId={MSG}
          channelId={CH}
          createdAtMs={Date.now() - 3 * SEC}
          runs={[run]}
          directory={directory}
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
      expect(screen.queryByTestId(`message-run-status-row-${RUN}`)).toBeNull();
      view.unmount();
    }
  });

  it('깨우는 신호가 닿지 않으면 줄이 서고, 누르면 기록 시트가 열린다', async () => {
    const now = Date.now();
    mockFetchEvents.mockResolvedValue({
      runId: RUN,
      events: [
        {ordinal: 1, kind: 'queued', createdAtMs: now - 3 * SEC},
        {ordinal: 2, kind: 'doorbell_rung', code: 'urgent_failed', createdAtMs: now - 2 * SEC},
      ],
    });
    mount(base({}));
    // 원장을 읽기 전에는 줄이 없다: 닿았는지 모르는 채로 「받았어요」만 그리지 않는다.
    expect(screen.queryByTestId(`message-run-status-row-${RUN}`)).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('message-run-status-step-woken')).toBeTruthy(),
    );
    // 「12분째」가 「12분 / 째」로 갈리지 않게(#3824 리뷰, RUN-STATUS 캡처).
    expect(screen.getByTestId('message-run-status-text').props.lineBreakStrategyIOS).toBe(
      'hangul-word',
    );
    fireEvent.press(screen.getByTestId(`message-run-status-row-${RUN}`));
    await waitFor(() => expect(screen.getByTestId('run-ledger-sheet')).toBeTruthy());
  });

  it('실패·시간 초과·승인 대기·가져간 뒤 소식 끊김은 줄이 선다', async () => {
    const now = Date.now();
    mockFetchEvents.mockResolvedValue({runId: RUN, events: []});
    for (const extra of [
      {status: 'failed', phase: 'failed', claimedAtMs: now - 9 * SEC, finishedAtMs: now - SEC},
      {status: 'timed_out', phase: 'timed_out', endReason: 'lease_abandoned', finishedAtMs: now - SEC},
      {status: 'awaiting_approval', phase: 'awaiting_approval', leaseState: 'live', claimedAtMs: now - 9 * SEC, startedAtMs: now - 8 * SEC},
      {status: 'claimed', phase: 'claimed', leaseState: 'stale', claimedAtMs: now - 6 * MIN},
    ] as Partial<AgentRunProgress>[]) {
      const view = mount(base(extra));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId(`message-run-status-row-${RUN}`)).toBeTruthy();
      view.unmount();
    }
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
    expect(screen.UNSAFE_getAllByType(GroupCard)).toHaveLength(2);
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

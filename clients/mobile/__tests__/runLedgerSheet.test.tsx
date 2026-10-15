import type {AgentRunProgress} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {RunLedgerSheet} from '../src/features/agents/RunLedgerSheet';
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
  client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

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
          {ordinal: 4, kind: 'tool_call', code: 'ok', createdAtMs: at + 6 * SEC},
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

describe('폰 메시지 아래 상태 줄 (#3824)', () => {
  it('받았어요가 서고, 깨우는 신호 프레임이 오면 단계가 더해지며, 누르면 기록 시트가 열린다', async () => {
    const now = Date.now();
    const queued = progress({
      status: 'queued',
      phase: 'queued',
      claimedAtMs: undefined,
      startedAtMs: undefined,
      finishedAtMs: undefined,
      createdAtMs: now - 3 * SEC,
    });
    mockFetchEvents.mockResolvedValue({
      runId: RUN,
      events: [{ordinal: 1, kind: 'queued', createdAtMs: now - 3 * SEC}],
    });
    render(
      wrap(
        <MessageRunStatus
          messageId={MSG}
          channelId={CH}
          createdAtMs={now - 3 * SEC}
          runs={[queued]}
          directory={directory}
        />,
      ),
    );
    expect(screen.getByTestId('message-run-status-step-received')).toBeTruthy();
    // 「12분째」가 「12분 / 째」로 갈리지 않게(#3824 리뷰, RUN-STATUS 캡처).
    expect(screen.getByTestId('message-run-status-text').props.lineBreakStrategyIOS).toBe(
      'hangul-word',
    );
    await waitFor(() => expect(mockFetchEvents).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('message-run-status-step-woken')).toBeNull();

    mockFetchEvents.mockResolvedValue({
      runId: RUN,
      events: [
        {ordinal: 1, kind: 'queued', createdAtMs: now - 3 * SEC},
        {ordinal: 2, kind: 'doorbell_rung', code: 'leading_ok', createdAtMs: now - 2 * SEC},
      ],
    });
    act(() => notifyRunLedgerFrame(RUN));
    await waitFor(() =>
      expect(screen.getByTestId('message-run-status-step-woken')).toBeTruthy(),
    );

    fireEvent.press(screen.getByTestId(`message-run-status-row-${RUN}`));
    await waitFor(() => expect(screen.getByTestId('run-ledger-sheet')).toBeTruthy());
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

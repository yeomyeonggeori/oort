import type {AgentRunProgress} from '@momo/core/lib/api';
import {TURN_STALE_SENTENCE} from '@momo/core/features/agents/turnCopy';
import {UNCOLLECTED_WORD} from '@momo/core/features/agents/runWaiting';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Animated, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {notifyRunLedgerFrame} from '../src/features/agents/agentRunProgressStore';
import {RequestThinkingLine} from '../src/features/agents/RequestThinkingLine';
import {RunLedgerSheet} from '../src/features/agents/RunLedgerSheet';
import {space} from '../src/design/tokens';
import {RealtimeContext} from '../src/realtime/RealtimeProvider';

// =============================================================================
// 폰 작업 타임라인 시트 (#4658): 웹 작업 패널(#4657)과 **같은 코어 모델**을 같은 말·같은 순서로 그린다. 줄·계획·건강 신호·요약의
// 규칙은 코어(`workReport`·`workHealth`·`workTimeline`)가 갖고 거기서 검증된다. 여기서 지키는 것: 폰이 그것을 **실제로** 그리는가 —
// 상태 넷, 묶음 접기, 계획 진척, 건강 줄, 끝난 요청의 요약 칩, 새 줄·상태 변화의 모션과 동작 줄이기, 초 시계가 없는 것, 구 서버·
// 빈 칸·연결 끊김. 문구를 mock하지 않는다.
//
// **연결 상태를 늘 명시한다.** `RealtimeContext`의 기본값은 `connecting`이라 감싸지 않으면 열린 run은 끊긴 화면으로 그려진다(점이 없고
// 에이전트색도 없다) — 「살아 있는 줄」을 단정하는 시험은 반드시 `connected`로 감싼다.
// =============================================================================

const WS = '00000000-0000-7000-8000-000000000001';
const AGENT = '00000000-0000-7000-8000-000000000301';
const CH = '00000000-0000-7000-8000-000000000201';
const RUN = '0199aa11-2222-7000-8000-0000000000c1';
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
    displayName: '달무리봇',
    handle: 'dalmuri',
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
  jest.restoreAllMocks();
});

// ---- 재료 ---------------------------------------------------------------------------

/** 지금 일하는 run(작업 12분째, 마지막 보고 20초 전). 시각은 부르는 순간에서 거꾸로 잡는다. */
function running(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  const t = Date.now();
  return {
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: MSG,
    triggerSummary: '리포트 정리해 줘',
    status: 'running',
    phase: 'running',
    leaseState: 'live',
    stepCount: 3,
    ahead: [],
    createdAtMs: t - 12 * MIN - 20 * SEC,
    claimedAtMs: t - 12 * MIN - 8 * SEC,
    startedAtMs: t - 12 * MIN,
    lastEventAtMs: t - 20 * SEC,
    updatedAtMs: t - 20 * SEC,
    ...extra,
  };
}

/** 13분 일하고 끝난 run. */
function finished(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  const t = Date.now();
  return running({
    status: 'succeeded',
    phase: 'succeeded',
    leaseState: 'none',
    createdAtMs: t - 20 * MIN - 20 * SEC,
    claimedAtMs: t - 20 * MIN - 8 * SEC,
    startedAtMs: t - 20 * MIN,
    finishedAtMs: t - 7 * MIN,
    lastEventAtMs: t - 7 * MIN,
    updatedAtMs: t - 7 * MIN,
    ...extra,
  });
}

const ledger = (events: unknown[], extra: Record<string, unknown> = {}) =>
  jest.requireActual('@momo/core/lib/api').agentRunLedgerFromWire({runId: RUN, events, ...extra});

/** 에이전트가 스스로 알린 활동 한 줄. 첫 보고 시각(줄의 자리)은 ordinal 순서로 늘어난다. */
function activity(
  ordinal: number,
  id: string,
  over: Partial<{kind: string; label: string; status: string; n: number}> = {},
) {
  const at = Date.now() - 10 * MIN + ordinal * SEC;
  return {
    ordinal,
    kind: 'activity',
    createdAtMs: at,
    activity: {id, kind: 'edit', status: 'completed', n: 1, startedAtMs: at, ...over},
  };
}

function plan(statuses: string[]) {
  return {
    ordinal: 90,
    kind: 'plan',
    createdAtMs: Date.now() - 9 * MIN,
    plan: statuses.map((status, index) => ({text: `계획 ${index + 1}단계`, status})),
  };
}

const queued = () => ({ordinal: 1, kind: 'queued', createdAtMs: Date.now() - 12 * MIN - 20 * SEC});

/** 서버가 `activity`·`tools`에 답했다는 표시(빈 합계도 「물었고 없다」다). */
const ANSWERED = {activityTally: [] as unknown[], toolTally: [] as unknown[]};

function mountSheet(run: AgentRunProgress, connected = true) {
  client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  const ui = (next: AgentRunProgress) => (
    <QueryClientProvider client={client!}>
      <RealtimeContext.Provider
        value={{rail: null, status: connected ? 'connected' : 'disconnected', subscriptionsWanted: true}}>
        <RunLedgerSheet progress={next} directory={directory} onClose={() => {}} />
      </RealtimeContext.Provider>
    </QueryClientProvider>
  );
  const view = render(ui(run));
  return {...view, rerenderRun: (next: AgentRunProgress) => view.rerender(ui(next))};
}

const agentRows = () => within(screen.getByTestId('run-ledger-agent-rows'));
const rowIds = () => agentRows().getAllByTestId(/^work-timeline-row-/).map(node => node.props.testID);
/** 칩의 왼쪽 안쪽 여백. 진행 중 칩만 점 자리(`space.md`)를 늘 예약한다 — 점이 서고 져도, 연결이 오가도 칩 폭이 변하지 않는다. */
const chipLeft = (node: {props: {style?: unknown}}) =>
  (StyleSheet.flatten(node.props.style as never) as {paddingLeft?: number}).paddingLeft;
/** 줄을 감싼 도착 페이드의 불투명도(가장 가까운 조상의 `opacity`). 보이지 않는 줄은 0이다. */
function opacityOf(node: {props: {style?: unknown}; parent: unknown}): number | undefined {
  for (let current = node as typeof node | null; current; current = current.parent as typeof node | null) {
    const style = StyleSheet.flatten(current.props.style as never) as {opacity?: number} | undefined;
    if (style !== undefined && typeof style.opacity === 'number') return style.opacity;
  }
  return undefined;
}
/** 머리 상태 칩 글자의 색. 에이전트색(`chipWorkingText`)이면 지금 돈다는 표지다. */
const headerChipColor = () =>
  (StyleSheet.flatten(screen.getByTestId('run-ledger-phase').props.style as never) as {color?: string}).color;
const dots = (kind: 'moving' | 'still') =>
  screen.queryAllByTestId(`timeline-dot-${kind}`, {includeHiddenElements: true});

interface DrawNode {
  props: {testID?: unknown};
  children: Array<DrawNode | string> | null;
}
function testIDsInDrawOrder(node: DrawNode | DrawNode[] | string | null): string[] {
  if (node === null || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(child => testIDsInDrawOrder(child));
  const own = typeof node.props.testID === 'string' ? [node.props.testID] : [];
  return [...own, ...(node.children ?? []).flatMap(child => testIDsInDrawOrder(child))];
}

async function settleReduceMotion(reduce: boolean) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduce);
}

// ---- 상태·묶음·계획 ------------------------------------------------------------------

describe('작업 타임라인 시트: 줄', () => {
  it('상태 셋이 한 칸에 서고, 점은 진행 중인 마지막 줄 하나이며, 끝남은 칩이 없다 — 기록 → 에이전트 보고 → oort 기록 순서로 따로 선다', async () => {
    mockFetchEvents.mockResolvedValue(
      ledger(
        [
          queued(),
          {ordinal: 2, kind: 'stage', stage: '문서 읽는 중', createdAtMs: Date.now() - 11 * MIN},
          activity(3, 'w1', {kind: 'web', label: '자료 찾기', status: 'in_progress'}),
          activity(4, 'e1', {kind: 'edit', label: '리포트 고치기'}),
          activity(5, 'f1', {kind: 'run', label: '테스트 돌리기', status: 'failed'}),
          activity(6, 'c1', {kind: 'run', label: '다시 돌리기', status: 'in_progress'}),
        ],
        ANSWERED,
      ),
    );
    mountSheet(running());
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-rows')).toBeTruthy());
    await settleReduceMotion(false);

    expect(rowIds()).toEqual([
      'work-timeline-row-running',
      'work-timeline-row-done',
      'work-timeline-row-failed',
      'work-timeline-row-running',
    ]);
    // 낱말이 있는 것은 진행 중과 실패뿐이다(끝남은 조용하다). 진행 중 둘은 에이전트색, 실패는 실패색.
    expect(agentRows().getAllByTestId('work-timeline-status').map(node => node.props.children)).toEqual([
      '진행 중',
      '실패',
      '진행 중',
    ]);
    expect(agentRows().getAllByTestId('work-timeline-status-live')).toHaveLength(2);
    expect(agentRows().getAllByTestId('work-timeline-status-failed')).toHaveLength(1);
    expect(agentRows().getAllByTestId('work-timeline-status-live').map(chipLeft)).toEqual([space.md, space.md]);
    expect(chipLeft(agentRows().getByTestId('work-timeline-status-failed'))).toBeUndefined();
    // 움직이는 것은 진행 중인 **마지막** 줄의 점 하나다. 앞의 진행 중 줄은 정지.
    const [firstRunning, lastRunning] = screen.getAllByTestId('work-timeline-row-running');
    expect(dots('moving')).toHaveLength(1);
    expect(within(lastRunning!).queryAllByTestId('timeline-dot-moving', {includeHiddenElements: true})).toHaveLength(1);
    expect(within(firstRunning!).queryAllByTestId('timeline-dot-moving', {includeHiddenElements: true})).toHaveLength(0);

    // 두 칸은 출처가 달라 따로 선다: 단계 줄은 「기록」에만, 활동 줄은 「에이전트 보고」에만. 순서는 기록 → 에이전트 보고 → oort 기록.
    // 「기록」에는 수명주기와 단계만 선다 — 활동·계획은 거기 없다.
    expect(
      within(screen.getByTestId('run-ledger-record'))
        .getAllByTestId(/^run-ledger-row-/)
        .map(node => node.props.testID),
    ).toEqual(['run-ledger-row-queued', 'run-ledger-row-stage']);
    expect(within(screen.getByTestId('run-ledger-agent-report')).queryAllByTestId('run-ledger-row-stage')).toHaveLength(0);
    const order = testIDsInDrawOrder(screen.toJSON() as unknown as DrawNode);
    const at = (id: string) => order.indexOf(id);
    expect(at('run-ledger-record')).toBeGreaterThan(-1);
    expect(at('run-ledger-record')).toBeLessThan(at('run-ledger-agent-report'));
    expect(at('run-ledger-agent-report')).toBeLessThan(at('run-ledger-oort-record'));
  });

  it('끝난 run의 진행 중 활동은 「끝 보고 없음」이다 — 진행 중으로도 끝났다고도 그리지 않고, 점도 에이전트색도 없다', async () => {
    mockFetchEvents.mockResolvedValue(
      ledger([queued(), activity(3, 'e1', {kind: 'edit', label: '리포트 고치기', status: 'in_progress'})], ANSWERED),
    );
    mountSheet(finished());
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-rows')).toBeTruthy());

    expect(rowIds()).toEqual(['work-timeline-row-unclosed']);
    expect(within(screen.getByTestId('work-timeline-row-unclosed')).getByTestId('work-timeline-status')).toHaveTextContent(
      '끝 보고 없음',
    );
    expect(agentRows().getAllByTestId('work-timeline-status-muted')).toHaveLength(1);
    expect(agentRows().queryAllByTestId('work-timeline-status-live')).toHaveLength(0);
    expect(screen.queryByText('진행 중')).toBeNull();
    expect(dots('moving')).toHaveLength(0);
    expect(dots('still')).toHaveLength(0);
  });

  it('읽기·검색은 한 줄로 가라앉고, 진행 중·실패 줄이 앞뒤 묶음을 끊는다', async () => {
    mockFetchEvents.mockResolvedValue(
      ledger(
        [
          queued(),
          activity(3, 'r1', {kind: 'read', n: 9}),
          activity(4, 's1', {kind: 'search', n: 3}),
          activity(5, 'e1', {kind: 'edit', label: '리포트 고치기', status: 'in_progress'}),
          activity(6, 'r2', {kind: 'read', n: 2}),
          activity(7, 'f1', {kind: 'run', label: '테스트 돌리기', status: 'failed'}),
          activity(8, 'r3', {kind: 'read', n: 1}),
          activity(9, 'r4', {kind: 'read', n: 4}),
        ],
        ANSWERED,
      ),
    );
    mountSheet(running());
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-rows')).toBeTruthy());

    expect(agentRows().getAllByTestId('work-timeline-label').map(node => node.props.children[0])).toEqual([
      '읽기 9 · 검색 3',
      '리포트 고치기',
      '읽기 2',
      '테스트 돌리기',
      '읽기 5',
    ]);
  });
});

describe('작업 타임라인 시트: 제자리 줄', () => {
  /** 같은 줄이 같은 인스턴스로 남는지: 글 노드의 동일성(`ReactTestInstance`는 같은 파이버면 같은 객체다). */
  async function readLedger(current: {value: unknown}) {
    mockFetchEvents.mockImplementation(async () => current.value);
  }

  it('같은 활동의 상태 변화는 같은 줄에서 일어나고, 앞 줄이 묶음에 가라앉아 자리가 바뀌어도 뒤 줄은 다른 줄로 넘어가지 않는다', async () => {
    await settleReduceMotion(false);
    // 1) 진행 중 편집 한 줄이 실패로 바뀐다.
    const current = {value: ledger([queued(), activity(3, 'e1', {kind: 'edit', label: '리포트 고치기', status: 'in_progress'})], ANSWERED)};
    await readLedger(current);
    mountSheet(running());
    await waitFor(() => expect(screen.getByText('리포트 고치기')).toBeTruthy());
    const edit = screen.getByText('리포트 고치기');
    current.value = ledger([queued(), activity(3, 'e1', {kind: 'edit', label: '리포트 고치기', status: 'failed'})], ANSWERED);
    act(() => notifyRunLedgerFrame(RUN));
    await waitFor(() => expect(agentRows().getAllByTestId('work-timeline-row-failed')).toHaveLength(1));
    expect(screen.getByText('리포트 고치기')).toBe(edit);

    // 2) 읽기 사이에서 진행 중이던 읽기가 끝나면 앞의 두 줄이 한 묶음으로 가라앉아 뒤의 편집 줄의 자리(index)가 하나 당겨진다.
    current.value = ledger(
      [
        queued(),
        activity(3, 'r1', {kind: 'read', n: 2}),
        activity(4, 'x1', {kind: 'read', label: '문서 읽는 중', status: 'in_progress'}),
        activity(5, 'e2', {kind: 'edit', label: '표 정리하기'}),
      ],
      ANSWERED,
    );
    act(() => notifyRunLedgerFrame(RUN));
    await waitFor(() => expect(screen.getByText('표 정리하기')).toBeTruthy());
    expect(rowIds()).toHaveLength(3);
    const later = screen.getByText('표 정리하기');
    current.value = ledger(
      [
        queued(),
        activity(3, 'r1', {kind: 'read', n: 2}),
        activity(4, 'x1', {kind: 'read', label: '문서 읽는 중', n: 1}),
        activity(5, 'e2', {kind: 'edit', label: '표 정리하기'}),
      ],
      ANSWERED,
    );
    act(() => notifyRunLedgerFrame(RUN));
    await waitFor(() => expect(rowIds()).toHaveLength(2));
    expect(agentRows().getAllByTestId('work-timeline-label')[0]).toHaveTextContent('읽기 3');
    expect(screen.getByText('표 정리하기')).toBe(later);
  });
});

describe('작업 타임라인 시트: 계획 진척', () => {
  it('서버가 running이라 할 때만 「지금 단계」가 서고, 아니면 마지막으로 알린 계획이라고 말한다', async () => {
    mockFetchEvents.mockResolvedValue(
      ledger([queued(), plan(['completed', 'completed', 'in_progress', 'pending'])], ANSWERED),
    );
    const live = mountSheet(running());
    await waitFor(() => expect(screen.getByTestId('run-ledger-plan')).toBeTruthy());
    expect(screen.getByTestId('run-ledger-plan-title')).toHaveTextContent('계획 · 4단계 중 2단계 완료');
    expect(screen.getAllByTestId('run-ledger-plan-step-done')).toHaveLength(2);
    expect(screen.getAllByTestId('run-ledger-plan-step-current')).toHaveLength(1);
    expect(screen.getAllByTestId('run-ledger-plan-step-pending')).toHaveLength(1);
    expect(screen.queryByTestId('run-ledger-plan-note')).toBeNull();
    // 단계는 색·모양·낱말로 갈린다: 접근성 이름에 낱말이 있다.
    expect(screen.getAllByTestId('run-ledger-plan-step-current')[0]!.props.accessibilityLabel).toBe('계획 3단계, 지금 단계');
    live.unmount();

    // 승인을 기다리는 run과 끝난 run의 `in_progress`는 지금 하는 일이 아니라 대기다.
    for (const stopped of [
      running({status: 'awaiting_approval', phase: 'awaiting_approval'}),
      finished(),
    ]) {
      mockFetchEvents.mockResolvedValue(
        ledger([queued(), plan(['completed', 'completed', 'in_progress', 'pending'])], ANSWERED),
      );
      const view = mountSheet(stopped);
      await waitFor(() => expect(screen.getByTestId('run-ledger-plan')).toBeTruthy());
      expect(screen.queryAllByTestId('run-ledger-plan-step-current')).toHaveLength(0);
      expect(screen.getAllByTestId('run-ledger-plan-step-pending')).toHaveLength(2);
      expect(screen.getByTestId('run-ledger-plan-note')).toHaveTextContent(
        '지금은 돌고 있지 않아요. 마지막으로 알린 계획이에요.',
      );
      view.unmount();
    }
  });
});

// ---- 건강 신호 · 연결 끊김 ------------------------------------------------------------

describe('작업 타임라인 시트: 건강 줄과 끊긴 연결', () => {
  const quietRun = () => running({lastEventAtMs: Date.now() - 8 * MIN});
  const quietLedger = () =>
    ledger(
      [
        queued(),
        {ordinal: 2, kind: 'stage', stage: '문서 읽는 중', createdAtMs: Date.now() - 12 * MIN},
        activity(3, 'f1', {kind: 'run', label: '테스트 돌리기', status: 'failed'}),
      ],
      ANSWERED,
    );

  it('서버가 적은 사실만 말한다 — 조용함·머문 시간·실패한 활동, 마지막 보고 시각은 머리가 이미 말해서 되풀이하지 않는다', async () => {
    mockFetchEvents.mockResolvedValue(quietLedger());
    mountSheet(quietRun());
    // 원장을 읽기 전에는 서버 진행 읽기의 사실(마지막 보고)만 있어 「조용해요」 하나다. 원장이 오면 단계·활동 사실이 더해진다.
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-rows')).toBeTruthy());
    expect(screen.getByTestId('run-ledger-health')).toHaveTextContent('조용해요 · 같은 단계에 12분째 · 실패한 활동 1');
    expect(screen.getByTestId('run-ledger-health')).not.toHaveTextContent('8분');
    // 머리의 근거 글이 그 시간을 말한다.
    expect(screen.getByTestId('run-ledger-detail')).toHaveTextContent('12분째 · 마지막 보고 8분 전');
    expect(screen.queryByTestId('run-ledger-stale')).toBeNull();
  });

  it('신호가 없으면 줄이 서지 않는다(「문제 없음」을 지어내지 않는다)', async () => {
    mockFetchEvents.mockResolvedValue(
      ledger([queued(), {ordinal: 2, kind: 'stage', stage: '문서 읽는 중', createdAtMs: Date.now() - MIN}], ANSWERED),
    );
    mountSheet(running());
    await waitFor(() => expect(screen.getByTestId('run-ledger-record')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByTestId(/^run-ledger-row-/).length).toBeGreaterThan(0));
    expect(screen.queryByTestId('run-ledger-health')).toBeNull();
  });

  it('연결이 끊기면 마지막으로 확인된 상태라고 말하고, 점·에이전트색을 걷고, 건강 줄은 시간 신호를 빼고 개수만 남긴다. 끝난 run은 말하지 않는다', async () => {
    mockFetchEvents.mockResolvedValue(
      ledger(
        [
          ...quietLedger().events.map((event: {ordinal: number}) => event),
          activity(5, 'c1', {kind: 'run', label: '다시 돌리기', status: 'in_progress'}),
          plan(['completed', 'in_progress']),
        ],
        ANSWERED,
      ),
    );
    const offline = mountSheet(quietRun(), false);
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-rows')).toBeTruthy());
    expect(screen.getByTestId('run-ledger-stale')).toHaveTextContent(TURN_STALE_SENTENCE);
    // 머리 칩의 에이전트색도 「지금 돈다」는 표지라 걷힌다: 끊긴 화면의 칩 글자색은 끝난 run의 중립 칩과 같고, 살아 있을 때와 다르다.
    const offlineChip = headerChipColor();
    expect(screen.getByTestId('run-ledger-health')).toHaveTextContent(/^실패한 활동 1$/);
    expect(agentRows().getAllByTestId('work-timeline-status-muted').length).toBeGreaterThan(0);
    expect(agentRows().queryAllByTestId('work-timeline-status-live')).toHaveLength(0);
    // 에이전트색이 걷혀도 점 자리는 그대로다 — 연결이 오가도 칩 폭이 변하지 않는다.
    expect(agentRows().getAllByTestId('work-timeline-status-muted').map(chipLeft)).toEqual([space.md]);
    expect(dots('moving')).toHaveLength(0);
    expect(dots('still')).toHaveLength(0);
    // 계획은 지우지 않는다: 마지막으로 확인된 모양으로 둔다.
    expect(screen.getByTestId('run-ledger-plan-title')).toHaveTextContent('계획 · 2단계 중 1단계 완료');
    offline.unmount();

    mockFetchEvents.mockResolvedValue(quietLedger());
    const live = mountSheet(quietRun());
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-report')).toBeTruthy());
    const liveChip = headerChipColor();
    expect(liveChip).not.toBe(offlineChip);
    live.unmount();

    mockFetchEvents.mockResolvedValue(quietLedger());
    mountSheet(finished(), false);
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-report')).toBeTruthy());
    expect(screen.queryByTestId('run-ledger-stale')).toBeNull();
    expect(headerChipColor()).toBe(offlineChip);
  });
});

// ---- 구 서버 · 빈 칸 ------------------------------------------------------------------

describe('작업 타임라인 시트: 모름과 없음', () => {
  it('구 서버(합계 없음)는 「서버 업데이트 뒤에 보여요」이고 0을 말하지 않는다 · 물었는데 없으면 열린 일과 끝난 일의 말이 다르다 · 아직 가져가지 않은 요청에는 보고 칸이 서지 않는다', async () => {
    mockFetchEvents.mockResolvedValue(ledger([queued()]));
    const old = mountSheet(running());
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-unsupported')).toBeTruthy());
    expect(screen.getByTestId('run-ledger-agent-unsupported')).toHaveTextContent(
      '에이전트가 알린 활동은 서버 업데이트 뒤에 보여요.',
    );
    expect(screen.getByTestId('run-ledger-oort-unsupported')).toBeTruthy();
    expect(within(screen.getByTestId('run-ledger-agent-report')).queryByText(/0/)).toBeNull();
    old.unmount();

    mockFetchEvents.mockResolvedValue(ledger([queued()], ANSWERED));
    const open = mountSheet(running());
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-empty')).toBeTruthy());
    expect(screen.getByTestId('run-ledger-agent-empty')).toHaveTextContent('아직 에이전트가 알린 활동이 없어요.');
    expect(screen.getByTestId('run-ledger-oort-empty')).toHaveTextContent('아직 oort가 잰 도구 호출이 없어요.');
    open.unmount();

    const ended = mountSheet(finished());
    await waitFor(() => expect(screen.getByTestId('run-ledger-agent-empty')).toBeTruthy());
    expect(screen.getByTestId('run-ledger-agent-empty')).toHaveTextContent('이 일에서 에이전트가 알린 활동은 없었어요.');
    expect(screen.getByTestId('run-ledger-oort-empty')).toHaveTextContent('이 일에서 oort가 잰 도구 호출은 없었어요.');
    ended.unmount();

    const waiting = mountSheet(
      running({status: 'queued', phase: 'queued', leaseState: 'none', claimedAtMs: undefined, startedAtMs: undefined, lastEventAtMs: undefined}),
    );
    await waitFor(() => expect(screen.getByTestId('run-ledger-oort-record')).toBeTruthy());
    expect(screen.queryByTestId('run-ledger-agent-report')).toBeNull();
    waiting.unmount();
  });
});

// ---- 모션 ----------------------------------------------------------------------------

describe('작업 타임라인 시트: 모션', () => {
  const base = () => [
    queued(),
    activity(3, 'r1', {kind: 'read', n: 2}),
    activity(4, 'e1', {kind: 'edit', label: '리포트 고치기', status: 'in_progress'}),
  ];
  const withNewRow = () => [...base(), activity(5, 'c1', {kind: 'run', label: '테스트 돌리기', status: 'in_progress'})];
  const withFailedEdit = () => [
    queued(),
    activity(3, 'r1', {kind: 'read', n: 2}),
    activity(4, 'e1', {kind: 'edit', label: '리포트 고치기', status: 'failed'}),
    activity(5, 'c1', {kind: 'run', label: '테스트 돌리기', status: 'in_progress'}),
  ];

  /** 연 뒤 (1) 새 줄이 붙고 (2) 같은 줄이 진행 중 → 실패로 바뀌는 흐름. 시간 길이별 `Animated.timing` 호출 수를 돌려준다. */
  async function drive(reduce: boolean) {
    await settleReduceMotion(reduce);
    const timing = jest.spyOn(Animated, 'timing');
    const loop = jest.spyOn(Animated, 'loop');
    const calls = (ms: number) =>
      timing.mock.calls.filter(([, config]) => (config as {duration?: number}).duration === ms).length;
    let current = ledger(base(), ANSWERED);
    mockFetchEvents.mockImplementation(async () => current);
    mountSheet(running());
    await waitFor(() => expect(rowIds()).toHaveLength(2));
    await act(async () => {
      await Promise.resolve();
    });
    const opened = {arrive: calls(240), state: calls(120)};

    current = ledger(withNewRow(), ANSWERED);
    act(() => notifyRunLedgerFrame(RUN));
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const arrived = {arrive: calls(240), state: calls(120)};
    const opacities = agentRows().getAllByTestId(/^work-timeline-row-/).map(opacityOf);

    current = ledger(withFailedEdit(), ANSWERED);
    act(() => notifyRunLedgerFrame(RUN));
    await waitFor(() => expect(agentRows().getAllByTestId('work-timeline-row-failed')).toHaveLength(1));
    const changed = {arrive: calls(240), state: calls(120)};
    // 칩 색 전환(JS 구동 120ms)이 끝날 때까지 act 안에서 기다린다 — 밖에서 도는 프레임은 act 경고를 낸다.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
    });
    return {opened, arrived, changed, opacities, loops: loop.mock.calls.length};
  }

  it('처음 열 때의 줄은 움직이지 않고, 새 줄은 불투명도로 한 번(240ms), 같은 줄의 상태 변화는 칩 색으로만 한 번(120ms) — 줄을 다시 끼우지 않는다', async () => {
    const result = await drive(false);
    expect(result.opened).toEqual({arrive: 0, state: 0});
    expect(result.arrived).toEqual({arrive: 1, state: 0});
    // 같은 줄(e1)이 진행 중 → 실패로 바뀔 때: 칩 색 전환만 일어난다. 줄이 다시 끼워졌다면 전환의 출발점(이전 톤)이 없어 전환이 없거나
    // 새 줄처럼 240ms 도착이 한 번 더 일어난다.
    expect(result.changed).toEqual({arrive: 1, state: 1});
    // 점은 진행 중 마지막 줄 하나이고 그 한 점만 루프를 돈다.
    expect(result.loops).toBeGreaterThan(0);
    expect(dots('moving').length).toBeGreaterThan(0);
  });

  it('동작 줄이기: 같은 흐름에서 전환이 0이고 점은 멈춘 채 선다', async () => {
    const result = await drive(true);
    expect(result.opened).toEqual({arrive: 0, state: 0});
    expect(result.arrived).toEqual({arrive: 0, state: 0});
    expect(result.changed).toEqual({arrive: 0, state: 0});
    // 새로 도착한 줄도 처음부터 보인다(페이드가 없는 것이지 숨은 채로 서는 것이 아니다).
    expect(result.opacities).toEqual([1, 1, 1]);
    expect(result.loops).toBe(0);
    expect(dots('moving')).toHaveLength(0);
    expect(dots('still')).toHaveLength(1);
  });
});

// ---- 시계 -----------------------------------------------------------------------------

describe('작업 타임라인 시트: 초 시계가 없다', () => {
  /** 질의 라이브러리의 재조회(30초)와 테스트 도구의 50ms 대기 시계는 시트의 것이 아니다. */
  const fastIntervals = (spy: jest.SpyInstance) =>
    spy.mock.calls.filter(
      ([callback, delay]) =>
        (delay as number) <= 1_000 && (callback as {name?: string}).name !== 'checkRealTimersCallback',
    );

  it('열린 run의 근거 글은 분이 바뀌는 순간에 한 번만 다시 그린다 — 1초 간격 시계 없이 「방금 시작」이 「1분째」가 된다', async () => {
    const interval = jest.spyOn(global, 'setInterval');
    mockFetchEvents.mockResolvedValue(ledger([queued()], ANSWERED));
    const t = Date.now();
    // 작업 시작 후 59.9초 근처: 분 경계까지 1.5초 남았다.
    mountSheet(running({startedAtMs: t - MIN + 1_500, claimedAtMs: t - MIN - 5 * SEC, createdAtMs: t - MIN - 10 * SEC, lastEventAtMs: t - 30 * SEC}));
    expect(screen.getByTestId('run-ledger-detail')).toHaveTextContent('방금 시작 · 마지막 보고 방금');
    expect(screen.getByTestId('run-ledger-durations')).toHaveTextContent('대기 5초 → 작업 중');
    await waitFor(() => expect(screen.getByTestId('run-ledger-detail')).toHaveTextContent('1분째 · 마지막 보고 방금'), {
      timeout: 5_000,
    });
    expect(screen.getByTestId('run-ledger-durations')).toHaveTextContent('대기 5초 → 작업 1분째');
    expect(fastIntervals(interval)).toEqual([]);
  });

  it('아무도 가져가지 않은 요청은 유예 마감에 낱말이 「아직 받지 않았어요」로 바뀐다 — 그때 한 번 다시 그린다', async () => {
    const interval = jest.spyOn(global, 'setInterval');
    mockFetchEvents.mockResolvedValue(ledger([queued()], ANSWERED));
    const t = Date.now();
    // 유예(5분)까지 1.5초 남은 대기.
    mountSheet(
      running({
        status: 'queued',
        phase: 'queued',
        leaseState: 'none',
        queuePosition: 1,
        createdAtMs: t - 5 * MIN + 1_500,
        claimedAtMs: undefined,
        startedAtMs: undefined,
        lastEventAtMs: undefined,
      }),
    );
    expect(screen.getByTestId('run-ledger-phase')).toHaveTextContent('대기 1번째');
    await waitFor(() => expect(screen.getByTestId('run-ledger-phase')).toHaveTextContent(UNCOLLECTED_WORD), {
      timeout: 5_000,
    });
    expect(fastIntervals(interval)).toEqual([]);
  });
});

// ---- 끝난 요청의 요약 칩 --------------------------------------------------------------

describe('끝난 요청의 요약 칩 (폰의 요청 생각 줄)', () => {
  const chipLine = (run: AgentRunProgress) => {
    client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
    return render(
      <QueryClientProvider client={client}>
        <RequestThinkingLine progress={run} directory={directory} nowMs={Date.now()} />
      </QueryClientProvider>,
    );
  };
  const stages = (count: number) =>
    Array.from({length: count}, (_, index) => ({
      ordinal: index + 2,
      kind: 'stage',
      stage: `단계 ${index + 1}`,
      createdAtMs: Date.now() - 15 * MIN + index * SEC,
    }));

  it('13분 일하고 끝난 요청은 「13분 · 단계 6 · 명령 12 · 읽기 9」와 꼬리표 「에이전트 보고」를 말하고, 누르면 이 시트가 열린다', async () => {
    mockFetchEvents.mockResolvedValue(
      ledger([queued(), ...stages(6)], {
        activityTally: [
          {kind: 'run', completed: 11, failed: 1},
          {kind: 'read', completed: 9, failed: 0},
          {kind: 'search', completed: 3, failed: 0},
        ],
        toolTally: [{tool: 'oort_run_event', ok: 40, error: 0}],
      }),
    );
    chipLine(finished());
    await waitFor(() =>
      expect(screen.getByTestId('request-thinking-chip-body')).toHaveTextContent('달무리봇 · 13분 · 단계 6 · 명령 12 · 읽기 9'),
    );
    expect(screen.getByTestId('request-thinking-chip-tail')).toHaveTextContent('· 에이전트 보고');
    // oort가 잰 도구 호출(40번)은 출처가 달라 요약에 섞이지 않는다.
    expect(screen.getByTestId('request-thinking-chip-body')).not.toHaveTextContent('40');
    expect(screen.getByTestId('request-thinking-done')).toBeTruthy();
    expect(screen.getByTestId('request-thinking-line').props.accessibilityLabel).toBe(
      '달무리봇 · 끝 · 13분 · 단계 6 · 명령 12 · 읽기 9 · 에이전트 보고',
    );

    fireEvent.press(screen.getByTestId('request-thinking-line'));
    await waitFor(() => expect(screen.getByTestId('run-ledger-sheet')).toBeTruthy());
    // 줄 안에서 펼치지 않는다 — 과정은 시트에 있다.
    expect(screen.queryByTestId('request-thinking-process')).toBeNull();
  });

  it('펼친 채로 run이 끝나면 인라인 과정은 접히고, 줄은 시트를 여는 입구가 된다 — 접을 길이 없는 펼침이 남지 않는다', async () => {
    mockFetchEvents.mockResolvedValue(ledger([queued()]));
    client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
    const ui = (run: AgentRunProgress) => (
      <QueryClientProvider client={client!}>
        <RequestThinkingLine progress={run} directory={directory} nowMs={Date.now()} />
      </QueryClientProvider>
    );
    const view = render(ui(running()));
    fireEvent.press(screen.getByTestId('request-thinking-line'));
    await waitFor(() => expect(screen.getByTestId('request-thinking-process')).toBeTruthy());
    view.rerender(ui(finished()));
    expect(screen.queryByTestId('request-thinking-process')).toBeNull();
    fireEvent.press(screen.getByTestId('request-thinking-line'));
    await waitFor(() => expect(screen.getByTestId('run-ledger-sheet')).toBeTruthy());
  });

  it('에이전트가 알린 숫자가 없으면 시간만 말하고 꼬리표가 없다 · 끝(done)이 아닌 끝은 낱말이 줄 앞에 남고 확인 표시가 없다', async () => {
    mockFetchEvents.mockResolvedValue(ledger([queued()]));
    const ok = chipLine(finished());
    await waitFor(() => expect(screen.getByTestId('request-thinking-chip-body')).toHaveTextContent('달무리봇 · 13분'));
    expect(screen.getByTestId('request-thinking-chip-body')).not.toHaveTextContent('단계');
    expect(screen.queryByTestId('request-thinking-chip-tail')).toBeNull();
    ok.unmount();

    const failed = chipLine(finished({status: 'failed', phase: 'failed'}));
    await waitFor(() => expect(screen.getByTestId('request-thinking-chip-body')).toHaveTextContent('달무리봇 · 실패 · 13분'));
    expect(screen.queryByTestId('request-thinking-done')).toBeNull();
    failed.unmount();
  });
});

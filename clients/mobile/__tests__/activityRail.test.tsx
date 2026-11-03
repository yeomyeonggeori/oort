// 입력창 레일 — 에이전트 작업 표시 v2의 폰 판 (#4620, #4577 권장 A). 낱말·판정은 코어 `activityRail`이 정하고
// (`packages/momo-core/.../activityRail.test.ts`가 붙든다), 여기서는 폰이 그것을 **어떻게 세우는가**를 붙든다:
// 칸의 예약 높이, 초 단위 갱신 없음, 국면이 바뀔 때만 낭독, 시트(중단·작업 기록·활동 보기).

import {activityRail, RAIL_WORD} from '@momo/core/features/agents/activityRail';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import {TURN_STALE_SENTENCE, UNKNOWN_AGENT_NAME} from '@momo/core/features/agents/turnCopy';
import {IDLE_CUTOFF_MS} from '@momo/core/features/agents/workingSignal';
import type {AgentRunProgress, RosterMember} from '@momo/core/lib/api';
import {makeDirectory, memberNameParts} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React, {Profiler} from 'react';
import {AccessibilityInfo, Dimensions, StyleSheet, Text, View} from 'react-native';

import {
  ActivityRailSlot,
  ConversationActivityRail,
  railPhaseKey,
} from '../src/features/agents/ActivityRail';
import {
  channelHasAgent,
  isRailReserved,
  nextRailDeadlineMs,
  RAIL_HIT_SLOP,
  railSlotHeight,
  useFireAt,
} from '../src/features/agents/railClock';
import {CONV} from '../src/features/conversation/convDesign';
import {TYPING_RESERVE, TypingBar} from '../src/features/conversation/TypingBar';
import {line} from '../src/design/tokens';
import {drainRender} from './testkit';

jest.mock('../src/features/agents/RunLedgerSheet', () => {
  const {Text: MockText} = require('react-native');
  return {
    RunLedgerSheet: ({progress}: {progress: {id: string}}) => (
      <MockText testID="record-sheet">{progress.id}</MockText>
    ),
  };
});

const NOW = 1_760_000_000_000;
const CHANNEL = 'cccccccc-1111-4111-8111-cccccccccccc';
const DAL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const MORAE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const RUN_A = 'A1111111-1111-4111-8111-A11111111111';
const RUN_B = 'B2222222-2222-4222-8222-B22222222222';

const agentMember = (id: string, name: string, channelIds: string[] = [CHANNEL]) =>
  ({
    id,
    workspaceId: 'ws',
    kind: 'agent',
    status: 'active',
    displayName: name,
    handle: name,
    channelCount: channelIds.length,
    channelIds,
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  }) as RosterMember;

const DIRECTORY = makeDirectory([agentMember(DAL, '달무리봇'), agentMember(MORAE, '모래시계봇')]);
const nameFor = (id: string) => memberNameParts(DIRECTORY, id, UNKNOWN_AGENT_NAME);

const working = (over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal => ({
  memberId: DAL,
  channelId: CHANNEL,
  state: 'working',
  source: 'run',
  runId: RUN_A,
  startedAtMs: NOW - 5_000,
  headlines: ['설계 문서 읽는 중'],
  lastActivityAtMs: NOW,
  server: {phase: 'running', leaseState: 'live', queuedAtMs: NOW - 9_000, startedAtMs: NOW - 5_000},
  ...over,
});
const approval = (over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal =>
  working({
    memberId: MORAE,
    runId: RUN_B,
    state: 'awaiting_approval',
    headlines: [],
    server: {phase: 'awaiting_approval', leaseState: 'live', queuedAtMs: NOW - 9_000, startedAtMs: NOW - 5_000},
    ...over,
  });

const railOf = (turns: readonly AgentWorkingSignal[], nowMs = NOW) => activityRail(turns, nameFor, nowMs);

const flat = (id: string) =>
  (StyleSheet.flatten(screen.getByTestId(id).props.style as never) ?? {}) as Record<string, unknown>;

function slot(rail: ReturnType<typeof railOf>, extra: Partial<React.ComponentProps<typeof ActivityRailSlot>> = {}) {
  return (
    <ActivityRailSlot rail={rail} live reserved directory={DIRECTORY} onPress={() => {}} {...extra} />
  );
}

afterEach(async () => {
  await drainRender();
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('입력창 레일 칸 (#4620 A)', () => {
  it('칸의 높이는 비어 있어도·한 에이전트여도·합친 줄이어도·끊긴 줄이어도 같다 — 줄이 서고 질 때 목록이 움직이지 않는 이유', () => {
    const expected = railSlotHeight(Dimensions.get('window').fontScale);
    const heights: number[] = [];
    const cases = [
      slot(null),
      slot(railOf([working()])),
      slot(railOf([working(), approval()])),
      slot(railOf([working()]), {live: false}),
    ];
    for (const element of cases) {
      const {unmount} = render(element);
      heights.push(Number(flat('composer-rail').height));
      unmount();
    }
    expect(heights).toEqual([expected, expected, expected, expected]);
    expect(CONV.agentRailSlot).toBe(line.meta);
    // 칸이 글자 배율을 따라 커지되 상한이 있다(바 단추와 같다).
    expect(railSlotHeight(1)).toBe(line.meta);
    expect(railSlotHeight(10)).toBeLessThan(line.meta * 2);
  });

  it('예약하지 않은 대화(사람만 있는 대화)에서는 줄이 없으면 칸도 없다 — 죽은 세로 띠를 만들지 않는다', () => {
    render(slot(null, {reserved: false}));
    expect(screen.queryByTestId('composer-rail')).toBeNull();
  });

  it('예약은 에이전트가 있는 대화에서만이다: 에이전트 DM이거나 활동 중인 에이전트 멤버가 이 채널에 있을 때', () => {
    const human = makeDirectory([
      {...agentMember(DAL, '달무리봇'), kind: 'human'} as RosterMember,
      agentMember(MORAE, '쉬는봇', ['other-channel']),
    ]);
    expect(isRailReserved({dmAgent: null, directory: human, channelId: CHANNEL})).toBe(false);
    expect(isRailReserved({dmAgent: {kind: 'agent'}, directory: human, channelId: CHANNEL})).toBe(true);
    expect(channelHasAgent(DIRECTORY, CHANNEL.toUpperCase())).toBe(true);
    const inactive = makeDirectory([{...agentMember(DAL, '꺼진봇'), status: 'suspended'} as RosterMember]);
    expect(channelHasAgent(inactive, CHANNEL)).toBe(false);
  });
});

describe('입력창 레일 글 (#4620 A)', () => {
  it('한 에이전트: 「이름 · 낱말 · 단계」 한 줄이고 초 단위·분 단위 숫자가 없다', () => {
    const first = render(slot(railOf([working()])));
    const text = screen.getByTestId('composer-working-text');
    expect(text).toHaveTextContent('달무리봇 · 작업 중 · 설계 문서 읽는 중');
    expect(text.props.numberOfLines).toBe(1);
    expect(screen.getByTestId('composer-working-text')).not.toHaveTextContent(/\d/);
    // 경과(「5초째」)는 줄에 없다: 같은 run이 한참 뒤에도 같은 글이다.
    first.unmount();
    render(slot(railOf([working()], NOW + 42 * 60_000)));
    expect(screen.getByTestId('composer-working-text')).toHaveTextContent('달무리봇 · 작업 중 · 설계 문서 읽는 중');
  });

  it('여럿은 「이름 +N」으로 합치고, 이끄는 쪽이 사람을 기다리면(승인) 그 낱말을 남긴다(색에만 기대지 않는다)', () => {
    const first = render(slot(railOf([working(), approval()])));
    expect(screen.getByTestId('composer-working-text')).toHaveTextContent(`모래시계봇 · ${RAIL_WORD.approval} +1`);
    expect(screen.getByTestId('composer-working-avatars').children).toHaveLength(2);
    first.unmount();
    render(slot(railOf([working(), working({memberId: MORAE, runId: RUN_B})])));
    expect(screen.getByTestId('composer-working-text')).toHaveTextContent(/^달무리봇 \+1$/);
  });

  it('끊긴 레일: 얼굴·점이 걷히고 한정 문장이 서며, 접근성 이름에는 에이전트 상태가 남는다', () => {
    render(slot(railOf([working()]), {live: false}));
    expect(screen.queryByTestId('composer-working-avatars')).toBeNull();
    expect(screen.queryByTestId('responding-dots', {includeHiddenElements: true})).toBeNull();
    expect(screen.getByTestId('composer-working-stale')).toHaveTextContent(TURN_STALE_SENTENCE);
    const label = String(screen.getByTestId('composer-working').props.accessibilityLabel);
    expect(label).toContain('달무리봇');
    expect(label).toContain(TURN_STALE_SENTENCE);
  });

  it('일하는 동안에만 점이 서고, 승인에는 점이 없다', () => {
    const first = render(slot(railOf([working()])));
    expect(screen.getByTestId('responding-dots', {includeHiddenElements: true})).toBeTruthy();
    first.unmount();
    render(slot(railOf([approval()])));
    expect(screen.queryByTestId('responding-dots', {includeHiddenElements: true})).toBeNull();
  });

  it('칸 아래 「작성 중」 줄은 터치를 가로채지 않는다 — 레일의 아래 슬롭이 그 위에 닿는다', () => {
    render(<TypingBar segments={[]} />);
    expect(screen.getByTestId('composer-typing', {includeHiddenElements: true}).props.pointerEvents).toBe('none');
  });

  it('누르는 면: 슬롭은 위로 넓히지 않는다 — 도크가 목록의 뒤 형제라 위로 넓히면 마지막 행의 아랫부분 탭을 레일이 가로챈다', () => {
    render(slot(railOf([working()])));
    const hit = screen.getByTestId('composer-working').props.hitSlop as {
      top: number;
      bottom: number;
      left: number;
      right: number;
    };
    expect(hit).toEqual(RAIL_HIT_SLOP);
    // 위: 0. 목록 마지막 행으로 한 점도 넘지 않는다.
    expect(hit.top).toBe(0);
    // 아래: 「작성 중」 예약 줄까지만(그 아래는 컴포저 루트가 먼저 받아 닿지 않는다) — 컴포저 알약에는 닿지 않는다.
    expect(hit.bottom).toBe(TYPING_RESERVE);
    expect(hit.bottom).toBeLessThanOrEqual(CONV.listPillGap - CONV.conversationTail - CONV.composerTopAir);
    // 옆: 줄의 글 폭이 짧아 넓힌다.
    expect(hit.left).toBeGreaterThan(0);
    expect(hit.right).toBeGreaterThan(0);
    // 알려진 한계의 숫자: 세로 누르는 면은 44보다 작다(글자 배율 1에서 칸 16 + 12).
    expect(railSlotHeight(1) + hit.top + hit.bottom).toBe(28);
  });
});

describe('초 단위 갱신이 없다 (#4620 A, #4613의 뿌리)', () => {
  it('열린 턴이 있는 레일은 120초가 흘러도 다시 그리지 않고 간격 시계(setInterval)가 없다', () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const spy = jest.spyOn(global, 'setInterval');
    let commits = 0;
    const rail = railOf([working()]);
    render(
      <Profiler id="rail" onRender={() => (commits += 1)}>
        <ConversationActivityRail
          rail={rail}
          turns={[working()]}
          runs={[]}
          live
          reserved
          directory={DIRECTORY}
        />
      </Profiler>,
    );
    const first = commits;
    act(() => {
      jest.advanceTimersByTime(120_000);
    });
    expect(spy).not.toHaveBeenCalled();
    expect(commits).toBe(first);
    expect(screen.getByTestId('composer-working-text')).toHaveTextContent('달무리봇 · 작업 중 · 설계 문서 읽는 중');
  });

  it('시간이 사실을 바꾸는 순간은 마감에 **한 번**만 불린다 — 만료(마지막 활동 + 90초 + 1ms)와 유예(5분)', () => {
    const live = working({server: undefined, lastActivityAtMs: NOW});
    const untaken = working({
      memberId: MORAE,
      runId: RUN_B,
      state: 'queued',
      server: {phase: 'queued', leaseState: 'none', queuedAtMs: NOW, queuePosition: 1, aheadTotal: 0},
    });
    expect(nextRailDeadlineMs([live], NOW)).toBe(NOW + IDLE_CUTOFF_MS + 1);
    expect(nextRailDeadlineMs([untaken], NOW)).toBe(NOW + 5 * 60_000);
    expect(nextRailDeadlineMs([live, untaken], NOW)).toBe(NOW + IDLE_CUTOFF_MS + 1);
    // 서버가 답한 일하는 턴은 우리 시계로 만료하지 않는다(ADR-0200 D1) — 마감이 없다.
    expect(nextRailDeadlineMs([working()], NOW)).toBeNull();
    // 대기 승인의 기한도 마감이다: 코어는 `expiresAtMs > now`인 승인만 기다림으로 세므로 기한에 승인 낱말이 걷힌다.
    expect(nextRailDeadlineMs([working()], NOW, undefined, [{expiresAtMs: NOW + 7_000}])).toBe(NOW + 7_000);
    expect(
      nextRailDeadlineMs([live], NOW, undefined, [{expiresAtMs: NOW + 7_000}, {expiresAtMs: NOW + 3_000}, {}]),
    ).toBe(NOW + 3_000);
    // 이미 지난 기한·기한 없는 승인·유한하지 않은 값은 마감이 아니다.
    expect(
      nextRailDeadlineMs([working()], NOW, undefined, [{expiresAtMs: NOW - 1}, {expiresAtMs: NOW}, {}, {expiresAtMs: Number.NaN}]),
    ).toBeNull();
    // 이미 지난 마감은 다시 부르지 않는다(경계 포함).
    expect(nextRailDeadlineMs([untaken], NOW + 5 * 60_000)).toBeNull();
    expect(nextRailDeadlineMs([live], NOW + IDLE_CUTOFF_MS + 1)).toBeNull();
    expect(nextRailDeadlineMs([live], NOW + IDLE_CUTOFF_MS)).toBe(NOW + IDLE_CUTOFF_MS + 1);
  });

  it('useFireAt: 마감에 한 번 불리고, 마감이 바뀌면 이전 시계는 걷히며, 간격 시계를 쓰지 않는다', () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const interval = jest.spyOn(global, 'setInterval');
    const fired = jest.fn();
    function Probe({at}: {at: number | null}) {
      useFireAt(at, fired);
      return <Text>probe</Text>;
    }
    const {rerender} = render(<Probe at={NOW + 10_000} />);
    act(() => {
      jest.advanceTimersByTime(9_999);
    });
    expect(fired).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(fired).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(fired).toHaveBeenCalledTimes(1);
    rerender(<Probe at={NOW + 200_000} />);
    rerender(<Probe at={null} />);
    act(() => {
      jest.advanceTimersByTime(300_000);
    });
    expect(fired).toHaveBeenCalledTimes(1);
    expect(interval).not.toHaveBeenCalled();
  });
});

describe('보조기술: 국면이 바뀔 때만 알린다 (#4620)', () => {
  function host(turns: readonly AgentWorkingSignal[]) {
    return (
      <ConversationActivityRail
        rail={railOf(turns)}
        turns={turns}
        runs={[]}
        live
        reserved
        directory={DIRECTORY}
      />
    );
  }

  it('마운트·단계 글의 바뀜·줄 사라짐은 알리지 않고, 국면이 바뀌면(받음→작업 중→승인 대기) 한 번씩 알린다', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const queued = working({
      state: 'queued',
      headlines: [],
      server: {phase: 'queued', leaseState: 'none', queuedAtMs: NOW, queuePosition: 1, aheadTotal: 0},
    });
    const {rerender} = render(host([queued]));
    expect(announce).not.toHaveBeenCalled();
    rerender(host([working({headlines: ['첫 단계']})]));
    expect(announce).toHaveBeenCalledTimes(1);
    rerender(host([working({headlines: ['둘째 단계']})]));
    rerender(host([working({headlines: ['셋째 단계']})]));
    expect(announce).toHaveBeenCalledTimes(1);
    rerender(host([approval({memberId: DAL, runId: RUN_A})]));
    expect(announce).toHaveBeenCalledTimes(2);
    expect(String(announce.mock.calls[1]?.[0])).toContain('승인');
    rerender(host([]));
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('국면의 서명은 단계 글을 보지 않는다', () => {
    expect(railPhaseKey(null)).toBe('');
    expect(railPhaseKey(railOf([working({headlines: ['가']})]))).toBe(
      railPhaseKey(railOf([working({headlines: ['나']})])),
    );
    expect(railPhaseKey(railOf([working()]))).not.toBe(railPhaseKey(railOf([approval({memberId: DAL, runId: RUN_A})])));
  });
});

describe('레일을 누르면 시트가 열린다 (#4620 A)', () => {
  const runOf = (id: string): AgentRunProgress =>
    ({id, agentMemberId: DAL, phase: 'running'}) as unknown as AgentRunProgress;

  function mount(over: Partial<React.ComponentProps<typeof ConversationActivityRail>> = {}) {
    const turns = [working(), approval()];
    const stop = jest.fn(({memberId}: {memberId: string}) => <View testID={`turn-stop-${memberId}-arm`} />);
    const activity = jest.fn();
    render(
      <ConversationActivityRail
        rail={railOf(turns)}
        turns={turns}
        runs={[runOf(RUN_A)]}
        live
        reserved
        directory={DIRECTORY}
        renderStop={stop}
        onOpenActivity={activity}
        {...over}
      />,
    );
    return {stop, activity};
  }

  it('에이전트마다 한 행(낱말 · 단계)이 서고, 일하는 run마다 중단·취소 컨트롤이 그 행 아래에 선다', () => {
    const {stop} = mount();
    expect(screen.queryByTestId('composer-working-sheet')).toBeNull();
    fireEvent.press(screen.getByTestId('composer-working'));
    expect(screen.getByTestId('composer-working-sheet')).toBeTruthy();
    expect(screen.getByTestId(`composer-working-row-${DAL}`)).toHaveTextContent(/달무리봇.*작업 중 · 설계 문서 읽는 중/);
    expect(screen.getByTestId(`composer-working-row-${MORAE}`)).toHaveTextContent(new RegExp(`모래시계봇.*${RAIL_WORD.approval}`));
    expect(screen.getByTestId(`turn-stop-${DAL}-arm`)).toBeTruthy();
    expect(screen.getByTestId(`turn-stop-${MORAE}-arm`)).toBeTruthy();
    // 이끄는 쪽(사람을 기다리는 승인)이 먼저 선다. 각 행은 자기 run·자기 이름으로 컨트롤을 만든다.
    const mine = stop.mock.calls.map(call => call[0]).find(turn => turn.memberId === DAL);
    expect(mine).toMatchObject({runId: RUN_A, memberId: DAL, name: '달무리봇'});
  });

  it('끊긴 레일에서는 중단을 권하지 않는다(마지막으로 확인된 상태를 보고 있다)', () => {
    mount({live: false});
    fireEvent.press(screen.getByTestId('composer-working'));
    expect(screen.queryByTestId(`turn-stop-${DAL}-arm`)).toBeNull();
    expect(screen.getByTestId(`composer-working-row-${DAL}`)).toBeTruthy();
  });

  it('행을 누르면 시트를 닫은 뒤 그 run의 작업 기록이 열린다 — run을 모르는 행은 눌리지 않는다', async () => {
    mount();
    fireEvent.press(screen.getByTestId('composer-working'));
    expect(screen.getByTestId(`composer-working-row-${MORAE}`).props.accessibilityRole).not.toBe('button');
    fireEvent.press(screen.getByTestId(`composer-working-row-${DAL}`));
    await waitFor(() => expect(screen.getByTestId('record-sheet')).toHaveTextContent(RUN_A));
    expect(screen.queryByTestId('composer-working-sheet')).toBeNull();
  });

  it('「활동 보기」 행이 선다 — 시트를 닫은 뒤에 작업 목록을 연다(그 표면이 없는 서버에는 행이 없다)', () => {
    const {activity} = mount();
    fireEvent.press(screen.getByTestId('composer-working'));
    expect(screen.getByTestId('composer-working-activity')).toBeTruthy();
    expect(screen.getByTestId('composer-working-activity')).toHaveTextContent('활동 보기');
    expect(activity).not.toHaveBeenCalled();
  });

  it('작업 목록이 없는 서버에는 「활동 보기」 행이 없다', () => {
    mount({onOpenActivity: undefined});
    fireEvent.press(screen.getByTestId('composer-working'));
    expect(screen.queryByTestId('composer-working-activity')).toBeNull();
  });

  it('일이 다 끝나 줄이 사라지면 시트도 걷힌다', () => {
    const turns = [working()];
    const view = (rail: ReturnType<typeof railOf>) => (
      <ConversationActivityRail rail={rail} turns={turns} runs={[]} live reserved directory={DIRECTORY} />
    );
    const {rerender} = render(view(railOf(turns)));
    fireEvent.press(screen.getByTestId('composer-working'));
    expect(screen.getByTestId('composer-working-sheet')).toBeTruthy();
    rerender(view(null));
    expect(screen.queryByTestId('composer-working-sheet')).toBeNull();
    // 칸은 남는다(예약).
    expect(screen.getByTestId('composer-rail')).toBeTruthy();
  });
});

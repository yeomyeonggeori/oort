import React from 'react';
import {AccessibilityInfo, Animated, Pressable, Text, View} from 'react-native';
import {act, fireEvent, render} from '@testing-library/react-native';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import type {AgentApprovalCard} from '@momo/core/features/timeline/agentCardModel';
import {
  DecisionStage,
  type DecisionStageEntry,
} from '../src/features/decisionStage/DecisionStage';
import {DecisionStageScope} from '../src/features/decisionStage/DecisionStageScope';
import {useOpenDecisionStage} from '../src/features/decisionStage/openDecisionStage';
import {StageHero} from '../src/features/attachments/StageHero';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {RequestBundleCard} from '../src/features/conversation/RequestBundleCard';
import {SessionProvider} from '../src/session/useSession';
import {
  resetBlurSupportForTests,
  resetLiquidGlassSupportForTests,
} from '../src/design/glass';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';

const mockDecide = jest.fn();
const mockPulse = jest.fn();
jest.mock('@momo/core/features/timeline/approvalDecision', () => ({
  ...jest.requireActual('@momo/core/features/timeline/approvalDecision'),
  decideApproval: (...args: unknown[]) => mockDecide(...args),
}));
jest.mock('../src/lib/haptics', () => ({
  haptics: {event: (...args: unknown[]) => mockPulse(...args)},
}));
jest.mock('../src/push/approvalNotifications', () => ({
  dismissApprovalNotifications: jest.fn(),
}));

const NOW = 1_800_000_000_000;
const directory = makeDirectory([
  {
    id: 'self',
    workspaceId: 'ws',
    kind: 'human',
    role: 'member',
    displayName: '검토자',
    handle: 'reviewer',
  },
  {
    id: 'agent',
    workspaceId: 'ws',
    kind: 'agent',
    displayName: '도우미',
    handle: 'agent',
  },
] as RosterMember[]);
function entry(
  id: string,
  patch: Partial<AgentApprovalCard> = {},
): DecisionStageEntry {
  return {
    id,
    gate: {approvalId: id, reversible: false, expiresAtMs: null},
    card: {
      kind: 'approval',
      approvalId: id,
      title: `${id} 채널 안내 바꾸기`,
      status: 'pending',
      requestedByMemberId: 'agent',
      isResumeOffer: false,
      execution: null,
      action: null,
      detail: {rows: [], withheld: 0},
      bundle: {canDecide: true, decisionMode: 'open'},
      ...patch,
    },
  };
}
const defaults = {
  directory,
  viewerMemberId: 'self',
  nowMs: NOW,
  onSettled: jest.fn(),
  onClose: jest.fn(),
};
function wrap(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  return (
    <QueryClientProvider client={client}>
      <SessionProvider member={{id: 'self', workspaceId: 'ws'} as Member}>
        {children}
      </SessionProvider>
    </QueryClientProvider>
  );
}
async function mount(
  patch: Partial<React.ComponentProps<typeof DecisionStage>> = {},
) {
  const props = {
    ...defaults,
    entries: [entry('첫째'), entry('둘째'), entry('셋째')],
    ...patch,
  };
  const view = render(wrap(<DecisionStage {...props} />));
  await act(async () => {});
  return {...view, props};
}
function drag(view: ReturnType<typeof render>, x: number, y: number) {
  const target = view.getByTestId('decision-stage-drag');
  const history = {
    touchBank: [
      {
        touchActive: true,
        startPageX: 0,
        startPageY: 0,
        currentPageX: x,
        currentPageY: y,
        previousPageX: 0,
        previousPageY: 0,
        startTimeStamp: 1,
        currentTimeStamp: 1001,
        previousTimeStamp: 1,
      },
    ],
    numberActiveTouches: 1,
    indexOfSingleActiveTouch: 0,
    mostRecentTimeStamp: 1001,
  };
  const down = {
    ...history,
    mostRecentTimeStamp: 1,
    touchBank: history.touchBank.map(touch => ({
      ...touch,
      currentPageX: 0,
      currentPageY: 0,
      currentTimeStamp: 1,
    })),
  };
  fireEvent(target, 'responderGrant', {
    nativeEvent: {
      touches: [{pageX: 0, pageY: 0}],
      changedTouches: [{pageX: 0, pageY: 0}],
      timestamp: 1,
    },
    touchHistory: down,
  });
  fireEvent(target, 'responderStart', {
    nativeEvent: {touches: [{pageX: 0, pageY: 0}]},
    touchHistory: down,
  });
  fireEvent(target, 'responderMove', {
    nativeEvent: {touches: [{pageX: x, pageY: y}]},
    touchHistory: {
      ...history,
      numberActiveTouches: 1,
      touchBank: history.touchBank.map(touch => ({
        ...touch,
        touchActive: true,
      })),
    },
  });
  fireEvent(target, 'responderRelease', {
    nativeEvent: {touches: [], changedTouches: [{pageX: x, pageY: y}]},
    touchHistory: {...history, numberActiveTouches: 0},
  });
}

beforeEach(() => {
  jest.useFakeTimers({now: NOW});
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(true);
  jest
    .spyOn(AccessibilityInfo, 'isReduceTransparencyEnabled')
    .mockResolvedValue(true);
  resetBlurSupportForTests(false);
  resetLiquidGlassSupportForTests(false);
  mockDecide.mockReset();
  mockPulse.mockReset();
  defaults.onSettled.mockReset();
  defaults.onClose.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('실제 승인 경로: 두 탭은 한 요청이고 보내는 중 넘김을 막은 뒤 다음 미처리 장으로 가요', async () => {
  let resolve!: (value: unknown) => void;
  mockDecide.mockReturnValue(
    new Promise(done => {
      resolve = done;
    }),
  );
  const view = await mount();
  const button = view.getByTestId('decision-stage-approve');
  fireEvent.press(button);
  fireEvent.press(button);
  await act(async () => fireEvent.press(view.getByLabelText('다음 결정')));
  expect(mockDecide).toHaveBeenCalledTimes(1);
  expect(mockDecide.mock.calls[0].slice(0, 3)).toEqual(['ws', '첫째', true]);
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '3건 중 1번',
  );
  await act(async () => resolve({kind: 'committed', status: 'approved'}));
  await act(async () => jest.advanceTimersByTime(260));
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '3건 중 2번',
  );
  expect(view.getByTestId('decision-stage-approve')).toBeTruthy();
});

test('가로 넘김·짧은 세로 복귀·긴 세로 닫기는 승인 요청을 만들지 않아요', async () => {
  const view = await mount();
  drag(view, -80, 0);
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '3건 중 2번',
  );
  drag(view, 0, 35);
  expect(defaults.onClose).not.toHaveBeenCalled();
  drag(view, 0, -120);
  expect(defaults.onClose).toHaveBeenCalledTimes(1);
  expect(mockDecide).not.toHaveBeenCalled();
});

test('거부도 원장 영수증으로 처리하고 전부 처리하면 완료 문장을 말해요', async () => {
  mockDecide.mockResolvedValue({kind: 'committed', status: 'rejected'});
  const view = await mount({entries: [entry('첫째')]});
  await act(async () =>
    fireEvent.press(view.getByTestId('decision-stage-reject')),
  );
  await act(async () => jest.advanceTimersByTime(260));
  expect(view.getByText('모두 처리했어요')).toBeTruthy();
  expect(view.queryByTestId('decision-stage-approve')).toBeNull();
});

test('1회 값은 자동 넘김으로 잃지 않고 다음 결정 보기를 눌러야 넘어가요', async () => {
  mockDecide.mockResolvedValue({
    kind: 'committed',
    status: 'approved',
    result: {secretOnce: {kind: 'invite', value: 'stage-only-value'}},
  });
  const view = await mount();
  await act(async () =>
    fireEvent.press(view.getByTestId('decision-stage-approve')),
  );
  await act(async () => jest.advanceTimersByTime(1000));
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '3건 중 1번',
  );
  expect(view.getByText('stage-only-value')).toBeTruthy();
  await act(async () => fireEvent.press(view.getByText('다음 결정 보기')));
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '3건 중 2번',
  );
  expect(view.queryByText('stage-only-value')).toBeNull();
});

test('상태 없는 응답은 완료나 다음 장으로 추측하지 않아요', async () => {
  mockDecide.mockResolvedValue({kind: 'committed'});
  const view = await mount();
  await act(async () =>
    fireEvent.press(view.getByTestId('decision-stage-approve')),
  );
  await act(async () => jest.advanceTimersByTime(1000));
  expect(
    view.getByText('결정 상태를 확인하지 못했어요. 닫고 다시 열어 주세요.'),
  ).toBeTruthy();
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '3건 중 1번',
  );
});

test('오프라인·권한 없음·만료는 결정 버튼을 내리며 썸네일과 명명한 VoiceOver 동작은 남아요', async () => {
  const view = await mount({offline: true});
  expect(view.queryByTestId('decision-stage-approve')).toBeNull();
  expect(view.getByTestId('decision-stage-backdrop-opaque')).toBeTruthy();
  expect(
    view.getByTestId('decision-stage-drag').props.accessibilityActions,
  ).toEqual([
    {name: 'increment', label: '다음 결정'},
    {name: 'decrement', label: '이전 결정'},
    {name: 'close', label: '결정 무대 닫기'},
  ]);
  fireEvent(view.getByTestId('decision-stage-drag'), 'accessibilityAction', {
    nativeEvent: {actionName: 'increment'},
  });
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '3건 중 2번',
  );
  await act(async () =>
    view.rerender(
      wrap(
        <DecisionStage
          {...view.props}
          entries={[
            entry('첫째'),
            {...entry('둘째'), gate: null},
            entry('셋째'),
          ]}
        />,
      ),
    ),
  );
  expect(view.queryByTestId('decision-stage-approve')).toBeNull();
  await act(async () =>
    view.rerender(
      wrap(
        <DecisionStage
          {...view.props}
          entries={[
            entry('첫째'),
            entry('둘째', {expiresAtMs: NOW - 1}),
            entry('셋째'),
          ]}
        />,
      ),
    ),
  );
  expect(view.queryByTestId('decision-stage-approve')).toBeNull();
  expect(mockDecide).not.toHaveBeenCalled();
});

test('빈·로딩·오류는 장을 결정할 수 없고 오류에서는 다시 불러올 수 있어요', async () => {
  const retry = jest.fn();
  const view = await mount({entries: [], loading: true});
  expect(view.getByText('결정을 불러오는 중이에요')).toBeTruthy();
  await act(async () =>
    view.rerender(
      wrap(
        <DecisionStage
          {...view.props}
          loading={false}
          error="결정을 불러오지 못했어요"
          onRetry={retry}
        />,
      ),
    ),
  );
  fireEvent.press(view.getByText('다시 불러오기'));
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () =>
    view.rerender(wrap(<DecisionStage {...view.props} loading={false} />)),
  );
  expect(view.getByText('지금 살펴볼 결정이 없어요.')).toBeTruthy();
  expect(view.queryByTestId('decision-stage-approve')).toBeNull();
});

test('열린 목록 순서는 고정되고 늦게 도착한 카드는 끼어들지 않아요', async () => {
  const view = await mount();
  await act(async () => fireEvent.press(view.getByLabelText('다음 결정')));
  await act(async () =>
    view.rerender(
      wrap(
        <DecisionStage
          {...view.props}
          entries={[entry('새것'), entry('셋째'), entry('둘째'), entry('첫째')]}
        />,
      ),
    ),
  );
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '3건 중 2번',
  );
  expect(view.queryByTestId('decision-stage-thumbnail-새것')).toBeNull();
});

function ChipEntry() {
  const open = useOpenDecisionStage();
  return (
    <Pressable onPress={() => open?.('첫째')} testID="test-chip">
      <Text>승인 필요</Text>
    </Pressable>
  );
}
test('카드와 칩은 같은 scope 진입점으로 열고 닫을 수 있어요', async () => {
  const item = entry('첫째');
  const message = {
    id: 'm',
    channelId: 'ch',
    type: 'approval_request',
    state: 'sent',
    props: {
      approval_id: '첫째',
      approval_status: 'pending',
      intent: '채널 안내 바꾸기',
      can_decide: true,
      decision_mode: 'open',
    },
  } as unknown as Message;
  const view = render(
    wrap(
      <DecisionStageScope
        messages={[message]}
        directory={directory}
        viewerMemberId="self"
        gates={new Map([['첫째', item.gate!]])}
        receipts={new Map()}
        nowMs={NOW}
        offline={false}
        onSettled={defaults.onSettled}
      >
        <ChipEntry />
        <RequestBundleCard
          card={item.card}
          directory={directory}
          viewerMemberId="self"
          gate={item.gate}
          nowMs={NOW}
        />
      </DecisionStageScope>,
    ),
  );
  await act(async () => fireEvent.press(view.getByTestId('test-chip')));
  expect(view.getByTestId('decision-stage')).toBeTruthy();
  fireEvent.press(view.getByTestId('decision-stage-close'));
  await act(async () => {});
  expect(view.queryByTestId('decision-stage')).toBeNull();
  const card = view.getByTestId('request-bundle-card');
  await act(async () =>
    fireEvent(card, 'accessibilityAction', {
      nativeEvent: {actionName: 'openDecision'},
    }),
  );
  expect(view.getByTestId('decision-stage')).toBeTruthy();
});

test('S1 hero는 카드에서 열리고 다른 장을 본 뒤에는 잘못된 카드로 돌아가지 않아요', async () => {
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  const callbacks: Array<(result: {finished: boolean}) => void> = [];
  jest.spyOn(Animated, 'spring').mockImplementation(() => ({
    start: callback => {
      if (callback) callbacks.push(callback);
    },
    stop: jest.fn(),
    reset: jest.fn(),
  }));
  const source = {
    current: {
      measureInWindow: (done: (...args: number[]) => void) =>
        done(20, 100, 150, 100),
    } as View,
  };
  const view = await mount({source, selectedId: '첫째'});
  const host = view
    .UNSAFE_getAllByType(Animated.View)
    .find(item => item.props.testID === 'decision-stage-card')!;
  const contentRef = host.props.ref as React.RefObject<View | null>;
  let nativeOffset = 0;
  contentRef.current = {
    measureInWindow: (done: (...args: number[]) => void) =>
      done(16, 200 + nativeOffset, 300, 250),
  } as View;
  await act(async () =>
    fireEvent(
      view.getByTestId('decision-stage-card', {includeHiddenElements: true}),
      'layout',
    ),
  );
  expect(view.UNSAFE_getByType(StageHero).props.from).toMatchObject({
    x: 20,
    y: 100,
  });
  await act(async () =>
    callbacks.splice(0).forEach(callback => callback({finished: true})),
  );
  expect(view.getByTestId('decision-stage-approve')).toBeTruthy();
  await act(async () => fireEvent.press(view.getByLabelText('다음 결정')));
  nativeOffset = 120;
  await act(async () => drag(view, 0, 120));
  const exit = view.UNSAFE_getByType(StageHero).props;
  expect(exit.closing).toBe(true);
  expect(exit.from.y).toBe(320); // native frame already includes the 120pt drag
  expect(exit.to.y).toBeGreaterThan(exit.from.y);
  expect(exit.to.x).toBe(16);
  await act(async () =>
    callbacks.splice(0).forEach(callback => callback({finished: true})),
  );
  expect(defaults.onClose).toHaveBeenCalledTimes(1);
});

test('실제 요청 칩을 누르면 스레드 이동 대신 해당 결정 무대가 열려요', async () => {
  const message = {
    id: 'root',
    channelId: 'ch',
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    type: 'text',
    state: 'sent',
    body: '안내를 바꿔줘',
    authorMemberId: 'self',
    createdAtMs: NOW,
  } as Message;
  const target = {
    ...message,
    id: 'card',
    authorMemberId: 'agent',
    type: 'approval_request',
    props: {
      approval_id: '첫째',
      approval_status: 'pending',
      requested_by_member_id: 'agent',
      intent: '안내 바꾸기',
      can_decide: true,
      decision_mode: 'open',
    },
  } as Message;
  const elsewhere = jest.fn();
  const view = render(
    wrap(
      <DecisionStageScope
        messages={[message, target]}
        directory={directory}
        viewerMemberId="self"
        gates={new Map([['첫째', entry('첫째').gate!]])}
        receipts={new Map()}
        nowMs={NOW}
        offline={false}
        onSettled={defaults.onSettled}
      >
        <MessageRow
          message={message}
          startsGroup
          directory={directory}
          chips={[]}
          nowMs={NOW}
          requestChip={
            {
              kind: 'approval',
              word: '승인 필요',
              label: '도우미 승인 필요',
              mark: 'none',
              tone: 'warn',
            } as never
          }
          requestCardTarget={target}
          actions={{
            myMemberId: 'self',
            onOpenMessage: elsewhere,
            onToggleReaction: async () => {},
            onEdit: async () => {},
            onDelete: async () => {},
          }}
        />
      </DecisionStageScope>,
    ),
  );
  await act(async () =>
    fireEvent.press(view.getByTestId('request-status-chip')),
  );
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '1건 중 1번',
  );
  expect(elsewhere).not.toHaveBeenCalled();
});

test('만료 시각에 버튼을 내려 늦은 승인을 보내지 않아요', async () => {
  const view = await mount({entries: [entry('첫째', {expiresAtMs: NOW + 50})]});
  expect(view.getByTestId('decision-stage-approve')).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(51));
  expect(view.queryByTestId('decision-stage-approve')).toBeNull();
  expect(mockDecide).not.toHaveBeenCalled();
});

test('실패 영수증은 같은 장에서 재시도하고 다음 장으로 넘기지 않아요', async () => {
  mockDecide.mockResolvedValue({
    kind: 'error',
    errorCode: 'network',
    errorCopy: '결정을 보내지 못했어요',
  });
  const view = await mount();
  await act(async () =>
    fireEvent.press(view.getByTestId('decision-stage-approve')),
  );
  expect(view.getByText('결정을 보내지 못했어요')).toBeTruthy();
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '3건 중 1번',
  );
  expect(view.getByTestId('decision-stage-approve')).not.toBeDisabled();
  expect(defaults.onSettled).not.toHaveBeenCalled();
});

test('전환 중 동작 줄이기를 켜면 hero를 걷고 늦은 완료 콜백은 무대를 다시 열지 않아요', async () => {
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  const listen = jest.spyOn(AccessibilityInfo, 'addEventListener');
  listen.mockClear();
  const callbacks: Array<(result: {finished: boolean}) => void> = [];
  jest.spyOn(Animated, 'spring').mockImplementation(() => ({
    start: callback => {
      if (callback) callbacks.push(callback);
    },
    stop: jest.fn(),
    reset: jest.fn(),
  }));
  const source = {
    current: {
      measureInWindow: (done: (...args: number[]) => void) =>
        done(20, 100, 150, 100),
    } as View,
  };
  const view = await mount({source, selectedId: '첫째'});
  const host = view
    .UNSAFE_getAllByType(Animated.View)
    .find(item => item.props.testID === 'decision-stage-card')!;
  (host.props.ref as React.RefObject<View | null>).current = {
    measureInWindow: (done: (...args: number[]) => void) =>
      done(16, 200, 300, 250),
  } as View;
  await act(async () =>
    fireEvent(
      view.getByTestId('decision-stage-card', {includeHiddenElements: true}),
      'layout',
    ),
  );
  expect(view.UNSAFE_getByType(StageHero)).toBeTruthy();
  // Jest infers only AccessibilityInfo's last overload (announcementFinished).
  const subscriptions = listen.mock.calls as unknown as Array<
    [string, (value: boolean) => void]
  >;
  const notify = subscriptions.find(
    ([name]) => name === 'reduceMotionChanged',
  )![1];
  await act(async () => notify(true));
  expect(view.UNSAFE_queryByType(StageHero)).toBeNull();
  expect(view.getByTestId('decision-stage-approve')).toBeTruthy();
  await act(async () =>
    fireEvent.press(view.getByTestId('decision-stage-close')),
  );
  await act(async () =>
    callbacks.forEach(callback => callback({finished: true})),
  );
  expect(defaults.onClose).toHaveBeenCalledTimes(1);
  expect(view.queryByTestId('decision-stage-approve')).toBeNull();
});

test('요청 중 무대를 닫아도 같은 대화는 영수증을 받고, 대화를 떠난 뒤의 응답은 버려요', async () => {
  let resolve!: (value: unknown) => void;
  mockDecide.mockReturnValue(
    new Promise(done => {
      resolve = done;
    }),
  );
  const message = {
    id: 'm',
    channelId: 'ch',
    type: 'approval_request',
    state: 'sent',
    props: {
      approval_id: '첫째',
      approval_status: 'pending',
      intent: '안내 바꾸기',
      can_decide: true,
      decision_mode: 'open',
    },
  } as unknown as Message;
  const content = (
    <DecisionStageScope
      messages={[message]}
      directory={directory}
      viewerMemberId="self"
      gates={new Map([['첫째', entry('첫째').gate!]])}
      receipts={new Map()}
      nowMs={NOW}
      offline={false}
      onSettled={defaults.onSettled}
    >
      <ChipEntry />
    </DecisionStageScope>
  );
  const view = render(wrap(content));
  await act(async () => fireEvent.press(view.getByTestId('test-chip')));
  fireEvent.press(view.getByTestId('decision-stage-approve'));
  await act(async () =>
    fireEvent.press(view.getByTestId('decision-stage-close')),
  );
  await act(async () => resolve({kind: 'committed', status: 'approved'}));
  expect(defaults.onSettled).toHaveBeenCalledTimes(1);
  expect(view.queryByTestId('decision-stage')).toBeNull();
  mockDecide.mockReturnValue(
    new Promise(done => {
      resolve = done;
    }),
  );
  await act(async () => fireEvent.press(view.getByTestId('test-chip')));
  fireEvent.press(view.getByTestId('decision-stage-approve'));
  view.unmount();
  await act(async () => resolve({kind: 'committed', status: 'approved'}));
  expect(defaults.onSettled).toHaveBeenCalledTimes(1);
});

import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {act, fireEvent, render, within} from '@testing-library/react-native';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {
  AgentRunProgress,
  Member,
  Message,
  RosterMember,
} from '@momo/core/lib/api';
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
import {BAR_CONTROL_MAX_SCALE, STACK_PILL_SCALE} from '../src/design/atoms';
import {sweepHangulWord} from './fixtures/hangulWord';
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

// 시험의 기본 창은 글자 배율 2(큰 글씨)다. 기본 크기 시험은 배율 1 로 열고, 큰 글씨 시험이 올린다(#4921).
const BASE_WINDOW = Dimensions.get('window');
const AX3 = 2.643; // iOS 접근성 크기 3 — RN 이 쓰는 글자 배율표의 값
function setFontScale(fontScale: number) {
  const window = {...BASE_WINDOW, fontScale};
  Dimensions.set({window, screen: window});
}

beforeEach(() => {
  setFontScale(1);
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
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
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

// ---- 큰 글씨의 결정 패널 (#4921) ---------------------------------------------------------------
// 렌더 트리의 DFS 순서만으로는 이 결함이 안 잡힌다: 고정 패널은 본문 스크롤의 **형제**라 예전에도 트리에서는 내용 뒤였다.
// 결함은 배치였다 — 고정 패널·썸네일이 화면을 나눠 가지면 본문 창이 제목 한 덩이로 차서 내용이 접힌 아래에 숨었다.
// 그래서 갈리는 것은 「패널이 본문 스크롤 **안**에서 내용 뒤에 흐르는가」이고, 순서 단정은 그 위에서 읽는 내용 앞섬이다.
const RISKY: Partial<AgentApprovalCard> = {
  isReversible: false,
  estimatedMicroUsd: 1_500_000,
  action: {
    id: 'profile.rename',
    rows: [
      {label: '표시 이름', value: '별하늘', before: '하늘', after: '별하늘'},
    ],
    omittedRows: 0,
    rationale: null,
    requiredRole: null,
  },
};
const CHIP_LABEL = '표시 이름: 이전 값 하늘, 이후 값 별하늘';
const APPROVE = 'decision-stage-approve';
const BODY = 'decision-stage-body';
const CUE = 'decision-stage-more-cue';
// 표지는 보조기술에서 숨겨져 있다. 숨은 요소를 포함해 묻지 않으면 「없다」 단정이 언제나 참이 된다.
const cueOf = (view: ReturnType<typeof render>) =>
  view.queryByTestId(CUE, {includeHiddenElements: true});
function bodyLayout(height: number) {
  return {nativeEvent: {layout: {x: 0, y: 100, width: 300, height}}};
}
function bodyScroll(offset: number, viewport: number, content: number) {
  return {
    nativeEvent: {
      contentOffset: {x: 0, y: offset},
      layoutMeasurement: {width: 300, height: viewport},
      contentSize: {width: 300, height: content},
    },
  };
}

test('기본 크기: 결정 패널은 본문 스크롤 밖 고정 칸에 서고 표지는 없어요', async () => {
  const view = await mount({entries: [entry('첫째', RISKY)]});
  const body = view.getByTestId(BODY);
  expect(view.getByTestId(APPROVE)).toBeTruthy();
  expect(within(body).queryByTestId(APPROVE)).toBeNull();
  // 기본 크기는 본문 창이 넘쳐도 표지·측정을 달지 않는다(지금 모양 그대로).
  fireEvent(body, 'layout', bodyLayout(100));
  fireEvent(body, 'contentSizeChange', 300, 900);
  expect(cueOf(view)).toBeNull();
});

test('큰 글씨(AX3): 결정 패널이 본문 끝에서 값·되돌릴 수 없음·비용 뒤에 함께 흘러요', async () => {
  setFontScale(AX3);
  const view = await mount({entries: [entry('첫째', RISKY)]});
  const body = view.getByTestId(BODY);
  // 배치: 패널이 본문 스크롤 안, 카드 다음에 선다 — 접힌 아래의 내용을 지나야 단추에 닿는다.
  const approve = within(body).getByTestId(APPROVE);
  const nodes = view.UNSAFE_root.findAll(() => true);
  const at = (node: (typeof nodes)[number]) => nodes.indexOf(node);
  const card = within(body).getByTestId('decision-stage-card');
  const panel = within(body).getByTestId('decision-stage-actions-glass');
  const chip = within(body).getByLabelText(CHIP_LABEL);
  const risk = within(body).getByText('실행하면 되돌릴 수 없어요');
  const cost = within(body).getByText(/예상 비용/);
  // 순서: 카드 → 패널, 그리고 카드 안에서 값 → 위험·비용 → 단추.
  expect(at(card)).toBeGreaterThan(-1);
  expect(at(card)).toBeLessThan(at(panel));
  expect(at(chip)).toBeGreaterThan(at(card));
  expect(at(chip)).toBeLessThan(at(risk));
  expect(at(risk)).toBeLessThan(at(approve));
  expect(at(cost)).toBeLessThan(at(approve));
  expect(at(chip)).toBeLessThan(at(approve));
  // 고정 칸에는 같은 패널이 두 번 서지 않는다.
  expect(view.getAllByTestId(APPROVE)).toHaveLength(1);
});

test.each([
  [STACK_PILL_SCALE - 0.01, false],
  [STACK_PILL_SCALE, true],
])('흐름의 문턱은 큰 글씨의 문턱이에요: 배율 %d 에서 패널이 본문 안=%s', async (fontScale, flows) => {
  setFontScale(fontScale);
  const view = await mount({entries: [entry('첫째', RISKY)]});
  const inside =
    within(view.getByTestId(BODY)).queryByTestId(APPROVE) !== null;
  expect(inside).toBe(flows);
  expect(view.getAllByTestId(APPROVE)).toHaveLength(1);
});

test('큰 글씨: 본문이 창보다 길고 끝이 아니면 「아래에 더 있다」 표지가 서고 끝에서 사라져요', async () => {
  setFontScale(AX3);
  const view = await mount({entries: [entry('첫째', RISKY)]});
  const body = view.getByTestId(BODY);
  expect(cueOf(view)).toBeNull(); // 아직 재지 않았다
  fireEvent(body, 'layout', bodyLayout(400));
  fireEvent(body, 'contentSizeChange', 300, 900);
  const cue = cueOf(view)!;
  expect(cue).toBeTruthy();
  // 표지는 눌리지 않고 보조기술에도 서지 않으며(스크린리더는 순서대로 읽는다), 본문 창 바닥에 얹힌다.
  expect(cue.props.pointerEvents).toBe('none');
  expect(cue.props.accessibilityElementsHidden).toBe(true);
  expect(cue.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(StyleSheet.flatten(cue.props.style).top).toBeGreaterThan(100);
  fireEvent.scroll(body, bodyScroll(500, 400, 900)); // 끝
  expect(cueOf(view)).toBeNull();
  fireEvent.scroll(body, bodyScroll(120, 400, 900)); // 다시 위로
  expect(cueOf(view)).toBeTruthy();
  // 내용이 창에 다 들어가면 서지 않는다.
  fireEvent(body, 'contentSizeChange', 300, 380);
  fireEvent.scroll(body, bodyScroll(0, 400, 380));
  expect(cueOf(view)).toBeNull();
});

test('큰 글씨: 다른 장으로 넘기면 본문은 그 장의 맨 위에서 시작해요', async () => {
  setFontScale(AX3);
  const scrollTo = ScrollView.prototype.scrollTo as unknown as jest.Mock;
  const view = await mount({
    entries: [entry('첫째', RISKY), entry('둘째', RISKY)],
  });
  scrollTo.mockClear();
  await act(async () => fireEvent.press(view.getByLabelText('다음 결정')));
  expect(view.getByTestId('decision-stage-position')).toHaveTextContent(
    '2건 중 2번',
  );
  expect(scrollTo).toHaveBeenCalledWith({y: 0, animated: false});
});

// ---- 끌기 손잡이와 본문 스크롤 (#4921) ------------------------------------------------------------
// 흐르는 본문에서는 제목·안내 줄(= 끌기 손잡이)이 첫 화면을 거의 다 덮는다. 터치 시작에서 가로채는 손잡이는 본문을 내리려는
// 세로 끌기를 스크롤 대신 「무대 닫기」로 읽는다(시뮬레이터에서 확인: Maestro 의 세로 스크롤이 무대를 닫았다). 그래서 이
// 크기에서는 끌기 응답자를 달지 않고, 넘기기·닫기는 단추와 VoiceOver 동작이 맡는다. (RNTL 의 fireEvent 는 응답자가 없으면
// 끌기 이벤트를 흘려보내므로 끌기를 흉내 내지 않고 응답자의 유무를 묻는다.)
const handleProps = (view: ReturnType<typeof render>) =>
  view.getByTestId('decision-stage-drag').props;

test('기본 크기: 손잡이는 터치 시작에서 가져가는 끌기 응답자를 달고 있어요', async () => {
  const view = await mount();
  const handle = handleProps(view);
  expect(handle.onStartShouldSetResponder({})).toBe(true);
  expect(typeof handle.onResponderGrant).toBe('function');
  expect(typeof handle.onResponderRelease).toBe('function');
  // 끌기를 말하는 안내 문장도 서 있다(낭독 힌트·「끌어 넘겨 보기」 줄).
  expect(handle.accessibilityHint).toMatch(/끌어/);
  expect(view.getByText(/끌어 넘겨 보기/)).toBeTruthy();
});

test('큰 글씨: 손잡이에 끌기 응답자가 없어 본문 스크롤을 가로채지 않아요', async () => {
  setFontScale(AX3);
  const view = await mount();
  const handle = handleProps(view);
  expect(handle.onStartShouldSetResponder).toBeUndefined();
  expect(handle.onMoveShouldSetResponder).toBeUndefined();
  expect(handle.onResponderGrant).toBeUndefined();
  expect(handle.onResponderRelease).toBeUndefined();
  // 없는 끌기를 말하는 안내 문장도 서지 않는다(낭독 힌트·「끌어 넘겨 보기」 줄).
  expect(handle.accessibilityHint).toBeUndefined();
  expect(view.queryByText(/끌어 넘겨 보기/)).toBeNull();
  // 손잡이의 접근성 동작은 그대로다.
  expect(handle.accessibilityRole).toBe('adjustable');
  expect(handle.accessibilityActions).toEqual([
    {name: 'increment', label: '다음 결정'},
    {name: 'decrement', label: '이전 결정'},
    {name: 'close', label: '결정 무대 닫기'},
  ]);
});

test('큰 글씨: 넘기기·닫기는 이전/다음 단추와 VoiceOver 동작으로 해요', async () => {
  setFontScale(AX3);
  const view = await mount();
  const position = () => view.getByTestId('decision-stage-position');
  await act(async () => fireEvent.press(view.getByLabelText('다음 결정')));
  expect(position()).toHaveTextContent('3건 중 2번');
  await act(async () =>
    fireEvent(view.getByTestId('decision-stage-drag'), 'accessibilityAction', {
      nativeEvent: {actionName: 'increment'},
    }),
  );
  expect(position()).toHaveTextContent('3건 중 3번');
  await act(async () =>
    fireEvent(view.getByTestId('decision-stage-drag'), 'accessibilityAction', {
      nativeEvent: {actionName: 'close'},
    }),
  );
  expect(defaults.onClose).toHaveBeenCalledTimes(1);
});

// ---- S3 화면 다듬기 (#4982) ----------------------------------------------------------------------
// 아래 시험은 렌더 트리를 읽는다. JS 렌더러에는 레이아웃이 없으므로 「본문 창을 덜 차지한다」·「눌린다」는 선언된 구조·속성으로 잰다.

const HOSTS = {
  kind: 'work_session_spawn',
  candidates: [
    {hostId: 'mine', displayName: '내 맥', tier: 'local', online: true, selectable: true},
    {
      hostId: 'old',
      displayName: '낡은 맥',
      tier: 'remote',
      online: false,
      selectable: false,
      unavailableReason: 'offline',
    },
  ],
} as unknown as AgentApprovalCard['execution'];

test.each([
  ['기본 크기', 1],
  ['큰 글씨(AX3)', AX3],
])('%s: 결정 무대의 한글 글자는 모두 어절 우선 줄바꿈이에요 - 값·비용·호스트·자세히·오프라인까지', async (_name, scale) => {
  setFontScale(scale);
  const view = await mount({
    entries: [entry('첫째', {...RISKY, execution: HOSTS}), entry('둘째', RISKY)],
  });
  const sweep = () => sweepHangulWord(view.getByTestId('decision-stage'));
  // 헛도는 훑기가 아니어야 한다: 머리말·값·위험·비용·「자세히」·결정 패널·호스트 선택·이전/다음·썸네일이 다 센 글자다.
  const first = sweep();
  expect(first.checked).toBeGreaterThan(14);
  expect(first.missing).toEqual([]);
  fireEvent.press(view.getByTestId('decision-stage-details-toggle'));
  expect(within(view.getByTestId('decision-stage-card')).getByText('표시 이름 · 별하늘')).toBeTruthy();
  const opened = sweep();
  expect(opened.checked).toBeGreaterThan(first.checked);
  expect(opened.missing).toEqual([]);
  await act(async () =>
    view.rerender(wrap(<DecisionStage {...view.props} offline />)),
  );
  const offline = sweep();
  expect(offline.checked).toBeGreaterThan(10);
  expect(offline.missing).toEqual([]);
  expect(view.getByText(/연결이 없어요/)).toBeTruthy();
});

test('한글 글자 훑기: 영수증·한 번만 보이는 값·완료·불러오는 중·오류·빈 상태도 어절 우선이에요', async () => {
  mockDecide
    .mockResolvedValueOnce({
      kind: 'committed',
      status: 'approved',
      result: {secretOnce: {kind: 'invite', value: 'stage-only-value'}},
    })
    .mockResolvedValueOnce({kind: 'committed', status: 'approved'});
  const view = await mount({entries: [entry('첫째'), entry('둘째')]});
  const sweep = () => sweepHangulWord(view.getByTestId('decision-stage'));
  await act(async () => fireEvent.press(view.getByTestId('decision-stage-approve')));
  // 영수증 + 한 번만 보이는 값(LinkOnce) + 「다음 결정 보기」
  expect(view.getByText('복사하기')).toBeTruthy();
  const receipt = sweep();
  expect(receipt.checked).toBeGreaterThan(8);
  expect(receipt.missing).toEqual([]);
  await act(async () => fireEvent.press(view.getByText('다음 결정 보기')));
  await act(async () => fireEvent.press(view.getByTestId('decision-stage-approve')));
  await act(async () => jest.advanceTimersByTime(260));
  expect(view.getByText('모두 처리했어요')).toBeTruthy();
  const done = sweep();
  expect(done.checked).toBeGreaterThan(3);
  expect(done.missing).toEqual([]);
  view.unmount();

  const loading = await mount({entries: [], loading: true});
  expect(sweepHangulWord(loading.getByTestId('decision-stage')).missing).toEqual([]);
  expect(sweepHangulWord(loading.getByTestId('decision-stage')).checked).toBeGreaterThan(1);
  loading.unmount();
  const failed = await mount({entries: [], error: '결정을 불러오지 못했어요', onRetry: jest.fn()});
  expect(failed.getByText('다시 불러오기')).toBeTruthy();
  expect(sweepHangulWord(failed.getByTestId('decision-stage')).missing).toEqual([]);
  expect(sweepHangulWord(failed.getByTestId('decision-stage')).checked).toBeGreaterThan(2);
  failed.unmount();
  const empty = await mount({entries: []});
  expect(empty.getByText('지금 살펴볼 결정이 없어요.')).toBeTruthy();
  expect(sweepHangulWord(empty.getByTestId('decision-stage')).missing).toEqual([]);
  expect(sweepHangulWord(empty.getByTestId('decision-stage')).checked).toBeGreaterThan(1);
});

test.each([
  ['기본 크기', 1],
  ['큰 글씨(AX3)', AX3],
])('%s: 「자세히」는 한 번만 서고, 서 있는 것은 눌려요', async (_name, scale) => {
  setFontScale(scale);
  const view = await mount({entries: [entry('첫째', RISKY)]});
  // 코어의 조용한 줄이 「… · 자세히」로 끝난다: 그 줄이 곧 단추이고, 같은 낱말의 두 번째 글자는 없다.
  const mentions = view.getAllByText(/자세히/);
  expect(mentions).toHaveLength(1);
  const toggle = view.getByTestId('decision-stage-details-toggle');
  expect(within(toggle).getAllByText(/자세히/)).toHaveLength(1);
  expect(toggle.props.accessibilityRole).toBe('button');
  expect(toggle.props.accessibilityState).toMatchObject({expanded: false});
  expect(view.queryByText('표시 이름 · 별하늘')).toBeNull();
  fireEvent.press(mentions[0]); // 글자를 눌러도 단추가 받는다
  expect(view.getByTestId('decision-stage-details-toggle').props.accessibilityState).toMatchObject({expanded: true});
  expect(view.getByTestId('decision-stage-details-toggle').props.accessibilityLabel).toBe('자세히 접기');
  expect(view.getByText('표시 이름 · 별하늘')).toBeTruthy();
  fireEvent.press(view.getByTestId('decision-stage-details-toggle'));
  expect(view.queryByText('표시 이름 · 별하늘')).toBeNull();
  // 낭독 이름은 보이는 글(남은 시간)을 잃지 않는다.
  view.rerender(wrap(<DecisionStage {...view.props} entries={[entry('첫째', {...RISKY, expiresAtMs: NOW + 23 * 3_600_000})]} />));
  expect(view.getByTestId('decision-stage-details-toggle').props.accessibilityLabel).toBe('23시간 남음 · 자세히');
});

test('첫 장의 「이전」과 마지막 장의 「다음」은 눌리는 단추와 다르게 보이고, 넘길 수 없는 순간에는 썸네일도 같아요', async () => {
  const look = (view: ReturnType<typeof render>, id: string) =>
    StyleSheet.flatten(view.getByTestId(id).props.style) as {opacity?: number};
  const dim = (view: ReturnType<typeof render>, id: string) => (look(view, id).opacity ?? 1) < 1;
  const view = await mount();
  // 첫 장: 이전만 흐리고(+ 비활성), 다음은 그대로다.
  expect(dim(view, 'decision-stage-previous')).toBe(true);
  expect(view.getByTestId('decision-stage-previous').props.accessibilityState).toMatchObject({disabled: true});
  expect(dim(view, 'decision-stage-next')).toBe(false);
  expect(view.getByTestId('decision-stage-next').props.accessibilityState).toMatchObject({disabled: false});
  // 가운데 장: 둘 다 눌린다.
  await act(async () => fireEvent.press(view.getByTestId('decision-stage-next')));
  expect(dim(view, 'decision-stage-previous')).toBe(false);
  expect(dim(view, 'decision-stage-next')).toBe(false);
  // 마지막 장: 다음만 흐리다.
  await act(async () => fireEvent.press(view.getByTestId('decision-stage-next')));
  expect(dim(view, 'decision-stage-next')).toBe(true);
  expect(dim(view, 'decision-stage-previous')).toBe(false);
  // 보내는 중에는 넘길 수 없다: 이전/다음/썸네일이 함께 흐려진다(눌러도 일이 없는데 같은 모양이면 거짓말이다).
  await act(async () => fireEvent.press(view.getByTestId('decision-stage-previous')));
  expect(dim(view, 'decision-stage-thumbnail-첫째')).toBe(false);
  mockDecide.mockReturnValue(new Promise(() => {}));
  await act(async () => fireEvent.press(view.getByTestId('decision-stage-approve')));
  for (const id of ['decision-stage-previous', 'decision-stage-next', 'decision-stage-thumbnail-첫째']) {
    expect(dim(view, id)).toBe(true);
  }
});

test.each([
  ['기본 크기', 1, 2, true],
  ['큰 글씨(AX3)', AX3, 1, false],
])('%s: 이전/다음 줄과 썸네일이 본문 창에서 갖는 몫 - 썸네일은 큰 글씨에서 한 줄, 글자 상한은 바 컨트롤과 같아요', async (_name, scale, headlineLines, hasWord) => {
  setFontScale(scale);
  const view = await mount();
  const texts = (id: string) =>
    view.getByTestId(id).findAll((node: {type: unknown}) => node.type === 'Text');
  const thumb = texts('decision-stage-thumbnail-첫째');
  expect(thumb[0].props.numberOfLines).toBe(headlineLines);
  expect(thumb).toHaveLength(hasWord ? 2 : 1);
  // 넘기기 줄은 크롬이다: 본문이 아니라 단추라서 글자 배율 상한(바 컨트롤)을 진다. 이 상한이 큰 글씨에서 이 줄의 높이를 막는다.
  const chrome = [
    ...texts('decision-stage-previous'),
    ...texts('decision-stage-position'),
    ...texts('decision-stage-next'),
    ...thumb,
  ];
  expect(chrome.length).toBeGreaterThanOrEqual(4);
  for (const node of chrome) {
    expect(node.props.maxFontSizeMultiplier).toBe(BAR_CONTROL_MAX_SCALE);
  }
});

test.each([
  ['기본 크기', 1, 2],
  ['큰 글씨(AX3)', AX3, undefined],
])('%s: 묶음 카드 머리 문장은 큰 글씨에서 두 줄에서 자르지 않아요', (_name, scale, lines) => {
  setFontScale(scale);
  const item = entry('첫째');
  const view = render(
    wrap(
      <RequestBundleCard
        card={item.card}
        directory={directory}
        viewerMemberId="self"
        gate={item.gate}
        nowMs={NOW}
      />,
    ),
  );
  expect(view.getByTestId('request-bundle-headline').props.numberOfLines).toBe(lines);
});

// #4960. 서버가 run 진행 bundle로 「이 사람은 지금 못 한다」고 말하면(보는 사람 기준 `canDecide:false`) 폰의 묶음
// 카드는 결정 단추를 거두고 기다리는 줄을 말한다. 카드 props·대기 목록은 아무 말이 없어도(여기서는 둘 다 열려 있다)
// 서버 값이 이긴다. 「한다」는 단추를 더 세우지 않는다: 대기 목록(gate)이 없으면 서버가 해도 단추가 없다.
function runWithBundle(canDecide: boolean, approvalId = '첫째'): AgentRunProgress {
  return {
    id: 'run-1',
    channelId: 'channel',
    agentMemberId: 'agent',
    status: 'awaiting_approval',
    phase: 'awaiting_approval',
    leaseState: 'live',
    stepCount: 1,
    ahead: [],
    createdAtMs: NOW,
    updatedAtMs: NOW,
    bundle: {
      approvalId,
      status: 'pending',
      decisionMode: 'inline',
      canDecide,
      actionType: 'tool_call',
    },
  };
}
// 행 길이를 맞춘다: jest.each는 행보다 인자가 많으면 남는 자리에 done 콜백을 넣는다.
test.each([
  ['서버가 못 한다고 하면 결정 단추를 거둔다', false, false, '첫째'],
  ['서버가 한다고 하면 결정 단추가 선다', true, true, '첫째'],
  ['다른 승인의 bundle은 이 카드의 일이 아니라 단추가 그대로 선다', false, true, '예전-승인'],
])(
  'run bundle canDecide: %s',
  async (_name, serverCanDecide, buttons, bundleApprovalId) => {
    const item = entry('첫째', {bundle: {decisionMode: 'inline'}});
    const view = render(
      wrap(
        <RequestBundleCard
          card={item.card}
          directory={directory}
          viewerMemberId="self"
          gate={item.gate}
          nowMs={NOW}
          run={runWithBundle(serverCanDecide, bundleApprovalId)}
        />,
      ),
    );
    await act(async () => {});
    expect(view.queryByTestId('card-approval-첫째-approve') !== null).toBe(
      buttons,
    );
    expect(view.queryByTestId('request-bundle-waiting') !== null).toBe(
      !buttons,
    );
  },
);
test('run bundle이 한다고 말해도 대기 목록(gate)에 없으면 결정 단추는 서지 않아요', async () => {
  const item = entry('첫째', {bundle: {decisionMode: 'inline'}});
  const view = render(
    wrap(
      <RequestBundleCard
        card={item.card}
        directory={directory}
        viewerMemberId="self"
        gate={null}
        nowMs={NOW}
        run={runWithBundle(true)}
      />,
    ),
  );
  await act(async () => {});
  expect(view.queryByTestId('card-approval-첫째-approve')).toBeNull();
});

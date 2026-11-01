import type {Message} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React, {useContext, useEffect} from 'react';
import {Text, View, type FlatList} from 'react-native';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';

import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {createDockFollow, DockFollowContext} from '../src/features/conversation/dockFollow';
import {DRAG_REST_FOLLOW_HOLD_MS} from '../src/features/conversation/dragRest';
import {Timeline} from '../src/features/conversation/Timeline';
import {installAppClock} from './fixtures/fakeClock';
import {member} from './testkit';

// =============================================================================
// 입력창이 자라는 프레임에 목록이 같이 바닥을 따라가는 길 (#4518, design-review R2 B1)
//
// 입력창을 누르는 순간 펼치기 시작하면 펼침이 키보드 준비(메인 스레드가 막히는 구간)와 겹치고, 도크는 앞서가는데 목록이 도크를 따라가는 길(`onLayout` → `scrollToEnd`)은
// 네이티브 → JS → 네이티브를 한 바퀴 돌아서 2~3프레임 늦었다 — 그 사이 마지막 말풍선의 아랫줄이 가려졌다 돌아왔다(시뮬레이터 짧은 탭: 틈 편차 −22pt·3프레임).
// 이 파일은 그 길의 **구조**를 못 박는다: ① 다리(`dockFollow`)의 약속 ② `ConversationLayout` 이 목록 자리와 도크 자리 양쪽에 같은 다리를 준다 ③ `Timeline` 이 바닥을
// 따라가는 중일 때만 네이티브 `scrollToEnd` 로 답한다. 컴포저가 자라는 프레임마다 알리는 쪽은 `composerTwoState.test.tsx` 의 「도크가 자라는 프레임」 절이 잠근다.
// 실제 프레임에서 가려짐이 없어지는 것은 시뮬레이터 녹화로 확인한다(PR 본문의 프레임 시트).
// =============================================================================

describe('다리 (dockFollow)', () => {
  it('처리기가 없으면 알려도 아무 일이 없다', () => {
    const bridge = createDockFollow();
    expect(() => bridge.notify()).not.toThrow();
  });

  it('건 처리기를 알림마다 부른다', () => {
    const bridge = createDockFollow();
    const follow = jest.fn();
    bridge.register(follow);
    bridge.notify();
    bridge.notify();
    expect(follow).toHaveBeenCalledTimes(2);
  });

  it('푸는 함수를 부르면 더는 안 불린다', () => {
    const bridge = createDockFollow();
    const follow = jest.fn();
    const release = bridge.register(follow);
    release();
    bridge.notify();
    expect(follow).not.toHaveBeenCalled();
  });

  it('새 처리기가 앞의 처리기를 대신하고, 앞의 푸는 함수가 뒤늦게 와도 새 처리기를 지우지 않는다', () => {
    const bridge = createDockFollow();
    const first = jest.fn();
    const second = jest.fn();
    const releaseFirst = bridge.register(first);
    bridge.register(second);
    bridge.notify();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    releaseFirst(); // 앞 목록이 늦게 정리된다(방이 바뀌는 순간)
    bridge.notify();
    expect(second).toHaveBeenCalledTimes(2);
  });
});

describe('ConversationLayout 이 다리를 놓는다', () => {
  it('목록 자리와 도크 자리의 후손이 **같은** 다리를 받는다 — 도크 쪽 알림이 목록 쪽 처리기에 닿는다', () => {
    const follow = jest.fn();
    let notify: (() => void) | undefined;
    function ListProbe() {
      const bridge = useContext(DockFollowContext);
      useEffect(() => bridge?.register(follow), [bridge]);
      return <Text testID="list-probe">목록</Text>;
    }
    function DockProbe() {
      const bridge = useContext(DockFollowContext);
      notify = () => bridge?.notify();
      return <View testID="dock-probe" />;
    }
    render(<ConversationLayout list={<ListProbe />} composer={<DockProbe />} />);
    expect(screen.getByTestId('list-probe')).toBeTruthy();
    expect(notify).toBeDefined();
    act(() => notify?.());
    expect(follow).toHaveBeenCalledTimes(1);
  });

  it('다리가 없는 곳(레이아웃 밖)에서는 컨텍스트가 비어 있다 — 알릴 곳이 없으니 아무 일도 안 한다', () => {
    let seen: unknown = 'unset';
    function Probe() {
      seen = useContext(DockFollowContext);
      return null;
    }
    render(<Probe />);
    expect(seen).toBeNull();
  });
});

// ---- Timeline -----------------------------------------------------------------
const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '이도현', handle: 'dohyun'}),
  member({id: OTHER, displayName: '박서연', handle: 'seoyeon'}),
]);
const BASE_MS = 1_700_000_000_000;
function message(seq: number): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}
const HISTORY = Array.from({length: 12}, (_, i) => message(i + 1));

function mountTimeline(bridge: ReturnType<typeof createDockFollow>) {
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as React.MutableRefObject<
    FlatList<TimelineStreamItem> | null
  >;
  const view = render(
    <DockFollowContext.Provider value={bridge}>
      <Timeline
        messages={HISTORY}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS}
        listRef={listRef}
      />
    </DockFollowContext.Provider>,
  );
  return {view, listRef};
}

async function wait(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** 열린 방이 바닥에 앉는다(진입 수렴이 손을 놓을 때까지) — `timelineFollow.test.tsx` 의 `settleInitialLayout` 과 같다. */
async function settleAtBottom() {
  fireEvent(screen.getByTestId('timeline-list'), 'contentSizeChange', 390, 4000);
  fireEvent.scroll(screen.getByTestId('timeline-list'), {
    nativeEvent: {
      contentOffset: {y: 3200},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
  await wait(0);
  await wait(1000);
}

function scrollAwayFromBottom() {
  fireEvent.scroll(screen.getByTestId('timeline-list'), {
    nativeEvent: {
      contentOffset: {y: 0},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
}

/** 목록이 네이티브 `scrollToEnd`(ScrollView 의 명령)를 부르는지 보려고 스크롤 응답자를 가짜로 갈아 끼운다. */
function spyNativeScrollToEnd(listRef: ReturnType<typeof mountTimeline>['listRef']) {
  const scrollToEnd = jest.fn();
  jest.spyOn(listRef.current!, 'getScrollResponder').mockReturnValue({scrollToEnd} as never);
  return scrollToEnd;
}

describe('Timeline 이 도크 알림에 답한다', () => {
  beforeEach(() => {
    installAppClock();
  });
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it('바닥을 따라가는 중이면 알림마다 네이티브 scrollToEnd 를 부른다(애니메이션 없이)', async () => {
    const bridge = createDockFollow();
    const {listRef} = mountTimeline(bridge);
    await settleAtBottom();
    const scrollToEnd = spyNativeScrollToEnd(listRef);
    act(() => bridge.notify());
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).toHaveBeenCalledWith({animated: false});
    act(() => bridge.notify());
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });

  it('과거를 읽는 중이면 안 부른다 — 읽던 자리를 뺏지 않는다', async () => {
    const bridge = createDockFollow();
    const {listRef} = mountTimeline(bridge);
    await settleAtBottom();
    scrollAwayFromBottom();
    const scrollToEnd = spyNativeScrollToEnd(listRef);
    act(() => bridge.notify());
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  // 아래로 끌다가 입력창이 쉬면(#4665, `dragRest.ts`) 목록은 바닥에서 아직 120pt 안이라 「따라가는 중」으로 남아 있다. 그때 입력창이 줄어드는 프레임마다(도크 알림) 또는 창이 늘어나는 순간(`onLayout`)
  // 네이티브 `scrollToEnd` 를 부르면 손가락 밑에서 목록이 끝으로 튄다 — 손가락이 먼저다. 손을 떼면(`onScrollEndDrag`) 다시 따라간다.
  const LIFT = {nativeEvent: {velocity: {x: 0, y: 0}}};

  it('손가락이 목록을 끄는 동안은 도크 알림에도 바닥으로 끌어가지 않는다 — 손을 떼면 다시 따라간다 (#4665)', async () => {
    const bridge = createDockFollow();
    const {listRef} = mountTimeline(bridge);
    await settleAtBottom();
    const scrollToEnd = spyNativeScrollToEnd(listRef);
    act(() => bridge.notify());
    expect(scrollToEnd).toHaveBeenCalledTimes(1); // 대조: 손가락이 없으면 따라간다

    fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag');
    act(() => bridge.notify());
    act(() => bridge.notify());
    expect(scrollToEnd).toHaveBeenCalledTimes(1); // 끄는 동안은 늘지 않는다

    fireEvent(screen.getByTestId('timeline-list'), 'scrollEndDrag', LIFT);
    act(() => bridge.notify());
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });

  it('손가락이 목록을 끄는 동안 창이 늘어나도(입력창이 쉼) 바닥으로 끌어가지 않는다 — 손을 떼면 다시 따라간다 (#4665)', async () => {
    const bridge = createDockFollow();
    const {listRef} = mountTimeline(bridge);
    await settleAtBottom();
    const scrollToEnd = jest.spyOn(listRef.current!, 'scrollToEnd').mockImplementation(() => {});
    const layout = (height: number) =>
      fireEvent(screen.getByTestId('timeline-list'), 'layout', {
        nativeEvent: {layout: {x: 0, y: 0, width: 390, height}},
      });
    layout(780);
    expect(scrollToEnd).toHaveBeenCalledTimes(1); // 대조: 손가락이 없으면 창이 바뀔 때 바닥을 따라간다

    fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag');
    layout(800);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    fireEvent(screen.getByTestId('timeline-list'), 'scrollEndDrag', LIFT);
    layout(820);
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });

  // 끌어서 입력창이 쉬기 시작한 뒤에는 **손을 뗀 뒤에도** 접힘 스프링의 꼬리(몇 프레임) 동안 막는다 — 그 프레임이 방금 위로 읽으러 간 목록을 끝으로 되돌리지 않게(`DRAG_REST_FOLLOW_HOLD_MS`).
  // 탭으로 쉴 때는 손가락이 없으니 막이 없다(꼬리가 입력창을 따라 내려간다).
  const touch = (y: number, at: number, touches: number) => ({
    nativeEvent: {
      pageX: 100,
      pageY: y,
      locationX: 100,
      locationY: y,
      timestamp: at,
      touches: Array.from({length: touches}, () => ({pageX: 100, pageY: y})),
      changedTouches: [{pageX: 100, pageY: y}],
    },
  });

  it('끌어서 입력창이 쉬기 시작하면 손을 뗀 뒤에도 접힘 꼬리 동안은 바닥으로 끌어가지 않는다 — 시한이 지나면 다시 따라간다 (#4665)', async () => {
    const bridge = createDockFollow();
    const {listRef} = mountTimeline(bridge);
    await settleAtBottom();
    const scrollToEnd = spyNativeScrollToEnd(listRef);
    const list = screen.getByTestId('timeline-list');
    fireEvent(list, 'scrollBeginDrag');
    fireEvent(list, 'touchStart', touch(300, 1000, 1));
    fireEvent(list, 'touchMove', touch(348, 1050, 1)); // 아래로 48pt — 입력창이 쉬기 시작한다
    fireEvent(list, 'touchEnd', touch(348, 1100, 0)); // 손을 뗀다(관성 없음)
    fireEvent(list, 'scrollEndDrag', LIFT);
    act(() => bridge.notify());
    expect(scrollToEnd).not.toHaveBeenCalled(); // 손은 떠났지만 접힘 스프링의 꼬리다

    await wait(DRAG_REST_FOLLOW_HOLD_MS - 1);
    act(() => bridge.notify());
    expect(scrollToEnd).not.toHaveBeenCalled(); // 시한 바로 안

    await wait(2);
    act(() => bridge.notify());
    expect(scrollToEnd).toHaveBeenCalledTimes(1); // 시한이 지났다 — 다시 따라간다
  });

  it('손을 뗀 직후 접힘 꼬리에 창이 늘어나도(onLayout) 바닥으로 끌어가지 않는다 — 시한이 지나면 다시 따라간다 (#4665)', async () => {
    const bridge = createDockFollow();
    const {listRef} = mountTimeline(bridge);
    await settleAtBottom();
    const scrollToEnd = jest.spyOn(listRef.current!, 'scrollToEnd').mockImplementation(() => {});
    const list = screen.getByTestId('timeline-list');
    const layout = (height: number) => fireEvent(list, 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height}}});
    fireEvent(list, 'scrollBeginDrag');
    fireEvent(list, 'touchStart', touch(300, 1000, 1));
    fireEvent(list, 'touchMove', touch(348, 1050, 1)); // 아래로 48pt — 입력창이 쉬기 시작한다
    fireEvent(list, 'touchEnd', touch(348, 1100, 0));
    fireEvent(list, 'scrollEndDrag', LIFT);
    layout(800);
    expect(scrollToEnd).not.toHaveBeenCalled(); // 손은 떠났지만 접힘 스프링의 꼬리다

    await wait(DRAG_REST_FOLLOW_HOLD_MS + 1);
    layout(820);
    expect(scrollToEnd).toHaveBeenCalledTimes(1); // 시한이 지났다 — 다시 따라간다
  });

  it('탭으로 쉴 때는 막이 없다 — 손가락이 없으니 꼬리가 입력창을 따라 내려간다 (#4614·#4518)', async () => {
    const bridge = createDockFollow();
    const {listRef} = mountTimeline(bridge);
    await settleAtBottom();
    const scrollToEnd = spyNativeScrollToEnd(listRef);
    const list = screen.getByTestId('timeline-list');
    fireEvent(list, 'touchStart', touch(300, 1000, 1));
    fireEvent(list, 'touchEnd', touch(300, 1080, 0)); // 탭
    act(() => bridge.notify());
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('언마운트하면 걸었던 처리기를 푼다 — 사라진 목록에 처리기가 남지 않는다', async () => {
    // 풀었는지는 다리가 본 것으로 잰다: 목록이 사라지면 그 처리기가 불려도 `listRef` 가 비어 있어 **겉으로는** 아무 일도 안 일어나서, 부른 결과로는 풀었는지 못 가린다.
    const release = jest.fn();
    const register = jest.fn(() => release);
    const bridge = {register, notify: jest.fn(), registerRest: jest.fn(() => jest.fn()), rest: jest.fn()};
    const {view} = mountTimeline(bridge);
    await settleAtBottom();
    expect(register).toHaveBeenCalledTimes(1); // 전제: 실제로 걸었다
    expect(release).not.toHaveBeenCalled();
    view.unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import type {FlatList} from 'react-native';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';

import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// 끝을 따라가는 규칙은 **둘**이다.
//
// 성재, iPhone 17: "채팅을 입력하면 채팅창 아래로 떠서 스크롤을 해야 내가 친
// 채팅이 나와."
//
// 원인은 두 경우를 하나로 묶어 둔 것이었다. `following` 하나만 보고 판단하면
// 「남이 말했다」와 「내가 말했다」가 같은 취급을 받는데, 이 둘은 정반대의 답을
// 가진다:
//
//   남이 말했다 → 읽던 자리를 지킨다. 뺏으면 그게 뒤집힌 리스트가 냈던 바로 그
//                 불만이고, 이 제품은 그것을 0px 로 만들려고 리스트를 정방향으로
//                 골랐다.
//   내가 말했다 → 무조건 데려간다. 보낸 사람이 그다음에 볼 것은 자기가 쓴 것이다.
//
// 키보드가 올라오면 리스트가 짧아지면서 `following` 이 깨지고, 그 순간부터 내가
// 보낸 메시지가 접힌 아래로 숨었다. 그래서 두 성질을 **함께** 못 박는다 — 한쪽만
// 재면 다른 쪽을 부수는 수정이 초록으로 통과한다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

const BASE_MS = 1_700_000_000_000;

function message(seq: number, over: Partial<Message> = {}): Message {
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
    ...over,
  };
}

const HISTORY = Array.from({length: 12}, (_, i) => message(i + 1));

function mount(selfSendToken = 0, messages: Message[] = HISTORY) {
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as React.MutableRefObject<
    FlatList<TimelineStreamItem> | null
  >;
  const view = render(
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS}
      selfSendToken={selfSendToken}
      listRef={listRef}
    />,
  );
  return {view, listRef};
}

/**
 * The list's FIRST content-size report, which is what puts a freshly opened
 * channel at its newest message. Every test below does this first, because
 * without it the initial positioning scroll is still pending and would be
 * mistaken for a follow.
 */
function settleInitialLayout() {
  fireEvent(screen.getByTestId('timeline-list'), 'contentSizeChange', 390, 4000);
}

/** Put the reader up in the history: far from the end, so `following` is false. */
function scrollAwayFromBottom() {
  fireEvent.scroll(screen.getByTestId('timeline-list'), {
    nativeEvent: {
      contentOffset: {y: 0},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
}

/**
 * Let the queued frame run. The self-send scroll is deliberately deferred one
 * frame so the inserted row has a height before the offset is computed — see
 * `Timeline`. A test that asserted synchronously would be asserting on the bug.
 */
async function flushFrame() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

afterEach(cleanup);

describe('내가 보내면 따라간다', () => {
  it('읽던 자리가 끝이 아니어도 내 메시지로 데려간다', async () => {
    const {view, listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');

    settleInitialLayout();
    scrollAwayFromBottom();
    spy.mockClear();

    // 보내기 = 토큰이 오른다. 서버 확인이 아니라 낙관적 삽입 시점이다.
    act(() => {
      view.rerender(
        <Timeline
          messages={[...HISTORY, message(13, {authorMemberId: SELF})]}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={BASE_MS}
          selfSendToken={1}
          listRef={listRef}
        />,
      );
    });
    await flushFrame();

    expect(spy).toHaveBeenCalled();
  });

  it('연달아 두 번 보내면 두 번 다 따라간다', async () => {
    // 불리언이었다면 두 번째 전송은 아무 일도 일으키지 않는다. 그래서 재는 것은
    // 「총 몇 번」이 아니라 「매 토큰마다 한 번이라도」다 — 한 번의 전송이 몇 번의
    // 보정을 낳는지는 리스트가 얼마나 멀리 있었느냐에 달렸고(RN-P3), 그 숫자를
    // 못 박으면 보정을 고칠 때마다 이 테스트가 애먼 곳에서 깨진다.
    const {view, listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');
    settleInitialLayout();
    scrollAwayFromBottom();

    for (const token of [1, 2]) {
      spy.mockClear();
      act(() => {
        view.rerender(
          <Timeline
            messages={HISTORY}
            directory={DIRECTORY}
            status="ready"
            myMemberId={SELF}
            nowMs={BASE_MS}
            selfSendToken={token}
            listRef={listRef}
          />,
        );
      });
      await flushFrame();
      expect(spy).toHaveBeenCalled();
    }
  });

  // ===========================================================================
  // 성재가 계속 본 그 결함. 꼬리 근처에서는 성립하고 **중간에서만** 깨진다는 것이
  // 단서였고, 원인은 이 컴포넌트가 아니라 `VirtualizedList` 에 있다:
  //
  //   * `scrollToEnd` 는 마지막 행의 위치를 `getCellMetricsApprox` 로 **추정**한다.
  //     방금 보낸 행은 한 번도 레이아웃된 적이 없으므로 평균 셀 높이로 계산된다.
  //   * 그보다 큰 것 — 리스트는 `getItemLayout` 이 없으면 tail spacer 를
  //     `_highestMeasuredFrameIndex` 까지로 **일부러 자른다**. 즉 콘텐츠의 끝이
  //     데이터의 끝보다 위에 있고, 네이티브 스크롤뷰는 거기서 clamp 한다.
  //
  // 리스트는 두 번째 기회를 주면 스스로 푼다(착지 → 셀 측정 → spacer 신장 →
  // contentSizeChange). 그 두 번째 기회를 죽이고 있던 것이 `onScroll` 이었다:
  // **끝으로 가는 여행의 중간 지점은 전부 끝에서 멀다.** 그래서 이 컴포넌트가
  // 스스로 낸 이동을 「읽던 자리로 간 사람」으로 읽고 `following` 을 껐다.
  // ===========================================================================
  describe('한 번에 닿지 못하는 거리에서', () => {
    /** 전송 = 토큰 + 낙관적 삽입. 두 테스트가 같은 시작점을 쓴다. */
    async function sendFromMidHistory(
      view: ReturnType<typeof mount>['view'],
      listRef: ReturnType<typeof mount>['listRef'],
    ) {
      act(() => {
        view.rerender(
          <Timeline
            messages={[...HISTORY, message(13, {authorMemberId: SELF})]}
            directory={DIRECTORY}
            status="ready"
            myMemberId={SELF}
            nowMs={BASE_MS}
            selfSendToken={1}
            listRef={listRef}
          />,
        );
      });
      await flushFrame();
    }

    /** 리스트가 스스로 만든 여행의 중간 지점. 끝에서 멀지만 남의 스크롤이 아니다. */
    function passThroughTheMiddle() {
      fireEvent.scroll(screen.getByTestId('timeline-list'), {
        nativeEvent: {
          contentOffset: {y: 1500},
          contentSize: {height: 4000, width: 390},
          layoutMeasurement: {height: 800, width: 390},
        },
      });
    }

    /** 착지한 자리에서 셀이 측정되며 잘려 있던 진짜 끝이 드러난다. */
    function tailSpacerGrows() {
      fireEvent(
        screen.getByTestId('timeline-list'),
        'contentSizeChange',
        390,
        4600,
      );
    }

    it('끝이 뒤늦게 드러나면 한 번 더 데려간다', async () => {
      const {view, listRef} = mount(0);
      const spy = jest.spyOn(listRef.current!, 'scrollToEnd');
      settleInitialLayout();
      scrollAwayFromBottom();
      spy.mockClear();

      await sendFromMidHistory(view, listRef);
      expect(spy).toHaveBeenCalled(); // 첫 hop
      spy.mockClear();

      passThroughTheMiddle();
      tailSpacerGrows();

      // 이 한 줄이 결함 그 자체다. 이것이 없으면 리스트는 잘린 끝에 멈춰 서고,
      // 방금 쓴 문장은 접힌 아래에 남는다.
      expect(spy).toHaveBeenCalled();
    });

    it('손가락이 리스트를 잡으면 전송은 자리를 내준다', async () => {
      // 마감시각은 의도에 대한 추측이지만 이것은 아니다. 끄는 사람은 자기가 어디
      // 있고 싶은지 말하고 있고, 1초 전의 전송에게 반박권은 없다.
      const {view, listRef} = mount(0);
      const spy = jest.spyOn(listRef.current!, 'scrollToEnd');
      settleInitialLayout();
      scrollAwayFromBottom();
      spy.mockClear();

      await sendFromMidHistory(view, listRef);
      spy.mockClear();

      fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag', {
        nativeEvent: {
          contentOffset: {y: 1500},
          contentSize: {height: 4000, width: 390},
          layoutMeasurement: {height: 800, width: 390},
        },
      });
      passThroughTheMiddle();
      tailSpacerGrows();

      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('채널을 여는 것만으로는 따라가지 않는다', () => {
    // 첫 렌더에서 토큰 0 이 「방금 보냈다」로 읽히면, 열자마자 스크롤이 한 번 더
    // 일어나 최초 위치 잡기와 다툰다.
    const {listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('남이 보내면 읽던 자리를 지킨다', () => {
  it('끝에서 떨어져 있으면 새 메시지가 와도 데려가지 않는다', () => {
    const {view, listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');

    settleInitialLayout();
    scrollAwayFromBottom();
    spy.mockClear();

    // 남의 메시지가 도착한다: 토큰은 그대로다.
    act(() => {
      view.rerender(
        <Timeline
          messages={[...HISTORY, message(13, {authorMemberId: OTHER})]}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={BASE_MS}
          selfSendToken={0}
          listRef={listRef}
        />,
      );
    });
    fireEvent(screen.getByTestId('timeline-list'), 'contentSizeChange', 390, 4300);

    expect(spy).not.toHaveBeenCalled();
  });

  it('끝에 있을 때는 새 메시지를 따라간다', () => {
    const {listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');

    settleInitialLayout();
    // 바닥 근처: distanceFromEnd 0.
    fireEvent.scroll(screen.getByTestId('timeline-list'), {
      nativeEvent: {
        contentOffset: {y: 3200},
        contentSize: {height: 4000, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    spy.mockClear();

    fireEvent(screen.getByTestId('timeline-list'), 'contentSizeChange', 390, 4300);
    expect(spy).toHaveBeenCalled();
  });
});

describe('키보드가 올라와 리스트가 짧아질 때', () => {
  it('바닥에 있던 사람은 바닥에 남는다', () => {
    // 내용이 바뀐 게 아니라 뷰포트가 바뀐 경우다. `onContentSizeChange` 는 이
    // 사건을 볼 수 없어서, 이것이 없으면 키보드가 올라오는 순간 마지막 메시지가
    // 접힌 아래로 사라진다 — 성재가 본 증상의 나머지 절반.
    const {listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');
    settleInitialLayout();

    fireEvent.scroll(screen.getByTestId('timeline-list'), {
      nativeEvent: {
        contentOffset: {y: 3200},
        contentSize: {height: 4000, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    spy.mockClear();

    fireEvent(screen.getByTestId('timeline-list'), 'layout', {
      nativeEvent: {layout: {width: 390, height: 464}},
    });
    expect(spy).toHaveBeenCalled();
  });

  // ===========================================================================
  // 그리고 그 줄어듦이 **스크롤로 먼저 도착하면** 위 규칙이 죽는다 (goal RN-P2b)
  //
  // 성재, iPhone 17: *"채팅치면 채팅바에 내 최근 채팅이 가려진다."*
  //
  // 컴포저는 고정 높이가 아니다. 두 줄째로 넘어가는 한글 한 글자, `@` 하나가 여는
  // 멘션 목록(최대 180pt), 턴이 열리며 서는 활동 줄 — 전부 **아래에서 위로** 자라고,
  // 리스트는 `flex: 1` 이라 그만큼 짧아진다. 짧아지는 것 자체는 위 테스트가 이미
  // 지키고 있다.
  //
  // 지켜지지 않던 것은 **그 사건이 도착하는 순서**다. 뷰포트가 ΔH 만큼 줄면
  // `distanceFromEnd = contentHeight − (offsetY + viewportHeight)` 가 ΔH 만큼
  // 커지고, 그 값을 실은 스크롤 이벤트가 `layout` 보다 먼저 오면 `onScroll` 은
  // 그것을 **읽던 사람이 위로 올라갔다**로 읽는다. 임계값은 120pt 이므로 멘션
  // 목록 하나로 이미 넘는다. 그 뒤에 도착한 `layout` 은 `following` 이 거짓이라
  // 아무것도 하지 않고, 마지막 메시지는 컴포저 뒤에 남는다.
  //
  // 손가락은 유리에 닿은 적이 없다. 움직인 것은 사람이 아니라 창이다.
  // ===========================================================================
  it('창이 좁아진 것을 사람이 올라간 것으로 읽지 않는다 — 멘션 목록이 열려도', () => {
    const {listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');
    settleInitialLayout();

    // 바닥에 있다: 4000 − (3200 + 800) = 0.
    fireEvent.scroll(screen.getByTestId('timeline-list'), {
      nativeEvent: {
        contentOffset: {y: 3200},
        contentSize: {height: 4000, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    spy.mockClear();

    // `@` 를 쳤다. 멘션 목록이 180pt 를 가져가고, 그 사실이 **스크롤 이벤트로 먼저**
    // 도착한다 — 오프셋은 그대로인데 뷰포트만 620 이다. 여기서 계산되는
    // 「끝까지의 거리」 180 은 임계값 120 을 넘는다.
    fireEvent.scroll(screen.getByTestId('timeline-list'), {
      nativeEvent: {
        contentOffset: {y: 3200},
        contentSize: {height: 4000, width: 390},
        layoutMeasurement: {height: 620, width: 390},
      },
    });
    // 그 다음에 레이아웃이 온다.
    fireEvent(screen.getByTestId('timeline-list'), 'layout', {
      nativeEvent: {layout: {width: 390, height: 620}},
    });

    // 끝에 있던 사람은 끝에 남아야 한다. 이 단정이 깨지면 방금 쓴 메시지가
    // 컴포저 뒤로 180pt 내려앉는다.
    expect(spy).toHaveBeenCalled();
  });

  it('그래도 진짜로 올라가 읽던 사람은 컴포저가 자라도 끌려가지 않는다', () => {
    // 위 수정이 "줄어들면 무조건 따라간다"가 되면 이 배치가 고치려는 것과 정반대의
    // 결함이 생긴다 — 과거를 읽는 중에 입력창을 건드렸다는 이유로 바닥으로 끌려가는
    // 것. 창이 좁아지기 **전에** 이미 끝에서 멀었다면 아무 일도 일어나지 않는다.
    const {listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');
    settleInitialLayout();
    scrollAwayFromBottom();
    spy.mockClear();

    fireEvent.scroll(screen.getByTestId('timeline-list'), {
      nativeEvent: {
        contentOffset: {y: 0},
        contentSize: {height: 4000, width: 390},
        layoutMeasurement: {height: 620, width: 390},
      },
    });
    fireEvent(screen.getByTestId('timeline-list'), 'layout', {
      nativeEvent: {layout: {width: 390, height: 620}},
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('history 를 읽던 사람은 키보드가 올라와도 끌려가지 않는다', () => {
    const {listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');

    settleInitialLayout();
    scrollAwayFromBottom();
    spy.mockClear();

    fireEvent(screen.getByTestId('timeline-list'), 'layout', {
      nativeEvent: {layout: {width: 390, height: 464}},
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

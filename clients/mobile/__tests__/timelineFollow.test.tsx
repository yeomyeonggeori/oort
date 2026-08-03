import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import type {FlatList} from 'react-native';
import type {TimelineItem} from '@momo/core/features/timeline/model';

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
  const listRef = React.createRef<FlatList<TimelineItem>>() as React.MutableRefObject<
    FlatList<TimelineItem> | null
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
    // 불리언이었다면 두 번째 전송은 아무 일도 일으키지 않는다.
    const {view, listRef} = mount(0);
    const spy = jest.spyOn(listRef.current!, 'scrollToEnd');
    settleInitialLayout();
    scrollAwayFromBottom();
    spy.mockClear();

    for (const token of [1, 2]) {
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
    }

    expect(spy).toHaveBeenCalledTimes(2);
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

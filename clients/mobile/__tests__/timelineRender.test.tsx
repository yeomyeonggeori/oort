import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// What the list renders, and how it is configured.
//
// The scroll-preservation numbers are NOT here — they cannot be: the correction
// lives in the native scroll view and a JS renderer has no layout. They are
// measured on the simulator by `measure/`, and reported in the PR. What this
// file pins is the configuration those measurements depend on, so a later edit
// cannot quietly remove the prop that made them true and leave the numbers in
// the PR describing a list that no longer exists.
// =============================================================================

const SELF_ID = '11111111-1111-4111-8111-111111111111';
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
  member({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
  member({
    id: 'cccccccc-1111-4111-8111-cccccccccccc',
    displayName: '헤르메스',
    handle: 'hermes',
    kind: 'agent',
    ownerHumanId: SELF_ID,
  }),
]);

const DAY = 86_400_000;
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
    body: `메시지 ${seq}`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}

function renderTimeline(props: Partial<React.ComponentProps<typeof Timeline>> = {}) {
  return render(
    <Timeline
      messages={[message(1), message(2)]}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF_ID}
      nowMs={BASE_MS + 60_000}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe('리스트 구성 — 정방향과 프리펜드 보정', () => {
  it('maintainVisibleContentPosition 으로 위쪽 삽입을 보정한다', () => {
    renderTimeline();
    const list = screen.getByTestId('timeline-list');
    // This testID lands on the underlying ScrollView, which is the useful place
    // to assert: React Native adds the ListHeaderComponent offset on the way
    // down (`minIndexForVisible + (ListHeaderComponent ? 1 : 0)`), so the value
    // the native side receives is one more than the value passed in.
    //
    // 1 here means 0 was passed — the OLDEST data row. Passing 1 to "skip the
    // header" would arrive as 2 and pin the second row, leaving the first one
    // uncorrected on every prepend. This test caught exactly that.
    expect(list.props.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 1,
    });
  });

  it('최신이 아래다 — 배열 순서 그대로 그린다', () => {
    renderTimeline({messages: [message(1), message(2), message(3)]});
    const list = screen.getByTestId('timeline-list');
    const seqs = list.props.data
      .filter((item: {kind: string}) => item.kind === 'message')
      .map((item: {message: Message}) => item.message.seq);
    // Ascending: the newest is last, which on a forward list is the bottom.
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('대화의 시작에 닿으면 더 요청하지 않는다', () => {
    renderTimeline({reachedStart: true, onStartReached: () => {}});
    expect(screen.getByTestId('timeline-list').props.onStartReached).toBeUndefined();
    expect(screen.getByText('대화의 시작입니다.')).toBeTruthy();
  });
});

describe('네 가지 상태', () => {
  it('불러오는 중', () => {
    renderTimeline({messages: [], status: 'loading'});
    expect(screen.getByTestId('timeline-loading')).toBeTruthy();
  });

  it('빈 채널은 코어의 문구로 다음 할 일을 말한다', () => {
    renderTimeline({messages: [], status: 'ready', channelKind: 'public'});
    expect(screen.getByTestId('timeline-empty')).toBeTruthy();
    expect(screen.getByText('이 채널을 함께 시작하세요.')).toBeTruthy();
  });

  it('빈 DM 은 채널과 다른 말을 한다 — 참여자를 더할 수 없으므로', () => {
    renderTimeline({
      messages: [],
      status: 'ready',
      channelKind: 'dm',
      peer: member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
    });
    expect(screen.getByText('김인턴님과의 대화를 시작하세요.')).toBeTruthy();
  });

  it('오류는 다시 시도를 준다', () => {
    renderTimeline({status: 'error', onRetry: () => {}});
    expect(screen.getByTestId('timeline-error')).toBeTruthy();
    expect(screen.getByText('다시 시도')).toBeTruthy();
  });

  it('보낸 메시지가 있으면 빈 상태가 아니다', () => {
    // A local echo is content: the first message in an empty channel must show
    // the moment it is sent, not after the round trip.
    const pending: PendingMessage[] = [
      {
        clientMsgId: 'c1',
        channelId: 'ch',
        authorMemberId: SELF_ID,
        body: '첫 마디',
        createdAtMs: BASE_MS,
        sinceSeq: null,
        status: 'sending',
      },
    ];
    renderTimeline({messages: [], status: 'ready', pending});
    expect(screen.queryByTestId('timeline-empty')).toBeNull();
    expect(screen.getByTestId('pending-row')).toBeTruthy();
    expect(screen.getByText('전송 중')).toBeTruthy();
  });
});

describe('행이 말하는 것', () => {
  it('날짜가 바뀌면 구분선이 선다', () => {
    renderTimeline({
      messages: [message(1), message(2, {createdAtMs: BASE_MS + DAY})],
    });
    expect(screen.getAllByTestId('day-divider')).toHaveLength(2);
  });

  it('안 읽은 경계를 서버가 준 수로 그린다', () => {
    renderTimeline({
      messages: [message(1), message(2), message(3)],
      lastReadSeq: 1,
      unreadCount: 2,
    });
    expect(screen.getByTestId('unread-divider')).toBeTruthy();
    expect(screen.getByText('새 메시지 2개, 여기까지 읽음')).toBeTruthy();
  });

  it('재연결 표시는 어디까지 복구됐는지 말한다', () => {
    renderTimeline({
      messages: [message(1), message(2)],
      recoveryMarkers: [{id: 'r1', seq: 2, source: 'replay'}],
    });
    expect(screen.getByText('재연결됨, seq 2까지 복구')).toBeTruthy();
  });

  it('삭제된 메시지는 자리를 지키고 본문을 지운다', () => {
    renderTimeline({
      messages: [message(1, {state: 'deleted', body: undefined}), message(2)],
    });
    expect(screen.getByTestId('tombstone')).toBeTruthy();
    expect(screen.queryByText('메시지 1')).toBeNull();
    // The row is still there — its seq is the recovery cursor.
    expect(screen.getAllByTestId('message-row')).toHaveLength(2);
  });

  it('수정된 메시지에 수정됨을 붙인다', () => {
    renderTimeline({messages: [message(1, {state: 'edited'})]});
    expect(screen.getByTestId('edited-mark')).toBeTruthy();
  });

  it('스레드가 있으면 몇 개인지 말한다', () => {
    renderTimeline({
      messages: [
        message(1, {
          thread: {reply_count: 3, last_reply_seq: 9, last_reply_at: BASE_MS},
        }),
      ],
    });
    expect(screen.getByTestId('thread-rollup')).toBeTruthy();
    expect(screen.getByText(/답글 3개/)).toBeTruthy();
  });

  it('반응 칩은 서버가 센 수를 보여준다', () => {
    renderTimeline({
      messages: [message(1)],
      reactions: {'msg-1': {'👍': [SELF_ID, OTHER]}},
    });
    expect(screen.getByTestId('reaction-chips')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('에이전트는 이름으로 구별되고 책임자를 밝힌다', () => {
    renderTimeline({
      messages: [
        message(1, {authorMemberId: 'cccccccc-1111-4111-8111-cccccccccccc'}),
      ],
    });
    expect(screen.getByText('에이전트')).toBeTruthy();
    // ADR-0131: an agent has a human who is accountable for it.
    expect(screen.getByText('곽성재님이 관리')).toBeTruthy();
  });

  it('실패한 서버 행은 그 자리에서 다시 보내기를 준다', () => {
    renderTimeline({
      messages: [message(1, {state: 'failed', authorMemberId: SELF_ID})],
      onResend: () => {},
    });
    expect(screen.getByTestId('message-resend')).toBeTruthy();
  });
});

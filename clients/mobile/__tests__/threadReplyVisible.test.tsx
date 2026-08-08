import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {Timeline} from '../src/features/conversation/Timeline';
import {
  buildThreadContext,
  parentOf,
  rollupFor,
} from '../src/features/conversation/threadContext';

// =============================================================================
// 답글을 달면 **답글로 보이는가.**
//
// 성재, iPhone 17: "답글쪽은 아직 뭔가 부족한 거 같아. 답글을 달았는데, 답글
// 모양 아이콘과 함께 별도로 안 보이는 거 같아."
//
// 고치기 전의 화면을 정확히 적어 두면 이 파일이 무엇을 지키는지가 분명해진다.
// 답글이 없던 메시지에 첫 답글을 달고 스레드를 닫으면:
//
//   * 루트 밑의 「답글 N개」는 **나타나지 않는다.** 그 줄은 서버가 페이지에
//     실어 준 `message.thread` 에서만 오고, 내 답글은 그 페이지보다 나중이다.
//   * 답글 자체는 채널에 **나타나긴 한다** — 답글이라는 표시가 없는, 다른
//     메시지와 구별되지 않는 평범한 행으로.
//
// 즉 내가 한 행동의 결과가 화면 어디에도 없다. 아래의 두 describe 가 그 두
// 가지를 각각 못박는다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

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

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '배포는 금요일에 합니다.',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

const ROOT = message({id: ROOT_ID, seq: 10, authorMemberId: OTHER});
const MY_REPLY = message({
  id: 'reply-1',
  seq: 11,
  rootId: ROOT_ID,
  authorMemberId: SELF,
  body: '금요일 좋습니다.',
  createdAtMs: BASE_MS + 60_000,
});

afterEach(cleanup);

// -----------------------------------------------------------------------------

describe('루트는 내가 방금 단 답글을 센다', () => {
  it('서버 롤업이 아직 없어도 「답글 1개」가 나온다', () => {
    // 결함 그 자체. `ROOT` 에는 `thread` 필드가 없다 — 답글이 달리기 전에 받은
    // 페이지의 객체이기 때문이고, 아무것도 그 루트를 다시 배달하지 않는다.
    const context = buildThreadContext([ROOT, MY_REPLY]);
    const rollup = rollupFor(ROOT, context);
    expect(rollup).not.toBeNull();
    expect(rollup?.replyCount).toBe(1);
    expect(rollup?.lastReplyAtMs).toBe(MY_REPLY.createdAtMs);
  });

  it('서버가 앞서 있으면 서버가 이긴다 — 안 열어 본 스레드가 0개가 되지 않는다', () => {
    // 로컬은 **불러온** 답글만 센다. 스레드를 열기 전에는 0이고, 그 0이 서버의
    // 5를 이기면 있던 답글이 사라진 것처럼 보인다.
    const busy = message({
      ...ROOT,
      thread: {reply_count: 5, last_reply_seq: 40, last_reply_at: BASE_MS + 1},
    });
    const rollup = rollupFor(busy, buildThreadContext([busy]));
    expect(rollup?.replyCount).toBe(5);
  });

  it('로컬이 앞서면 로컬이 이긴다 — 방금 단 답글이 세어진다', () => {
    const busy = message({
      ...ROOT,
      thread: {reply_count: 1, last_reply_seq: 11, last_reply_at: BASE_MS},
    });
    const mine = message({
      id: 'reply-2',
      seq: 12,
      rootId: ROOT_ID,
      authorMemberId: SELF,
      createdAtMs: BASE_MS + 120_000,
    });
    const rollup = rollupFor(
      busy,
      buildThreadContext([busy, MY_REPLY, mine]),
    );
    expect(rollup?.replyCount).toBe(2);
  });

  it('지워진 답글은 세지 않는다', () => {
    const tombstone = {...MY_REPLY, state: 'deleted' as const};
    const rollup = rollupFor(ROOT, buildThreadContext([ROOT, tombstone]));
    expect(rollup).toBeNull();
  });

  it('답글은 롤업을 갖지 않는다 — 스레드는 한 단계다', () => {
    // 서버의 투영도 `AND m.root_id IS NULL` 로 같은 것을 보장한다. 두 곳에서
    // 같은 규칙을 지키는 이유는, 여기서 어기면 답글 밑에 답글이 있다고 말하는
    // 화면이 되기 때문이다.
    const context = buildThreadContext([ROOT, MY_REPLY]);
    expect(rollupFor(MY_REPLY, context)).toBeNull();
  });
});

describe('답글은 자기가 무엇에 대한 답인지 안다', () => {
  it('루트를 들고 있으면 그 메시지를 가리킨다', () => {
    const context = buildThreadContext([ROOT, MY_REPLY]);
    expect(parentOf(MY_REPLY, context)?.id).toBe(ROOT_ID);
  });

  it('루트가 안 불려 있으면 null 이다 — 모르면 모른다고 말한다', () => {
    // 레일로 답글이 먼저 도착하고 루트는 아직 안 불러온 페이지에 있는 경우.
    const context = buildThreadContext([MY_REPLY]);
    expect(parentOf(MY_REPLY, context)).toBeNull();
  });

  it('답글이 아닌 메시지는 부모가 없다', () => {
    expect(parentOf(ROOT, buildThreadContext([ROOT]))).toBeNull();
  });
});

// -----------------------------------------------------------------------------

/** What a channel surface hands its rows. A thread panel omits `onOpenThread`. */
function actions() {
  return {
    myMemberId: SELF,
    onToggleReaction: jest.fn().mockResolvedValue(undefined),
    onEdit: jest.fn().mockResolvedValue(undefined),
    onDelete: jest.fn().mockResolvedValue(undefined),
    onOpenThread: jest.fn(),
  };
}

function renderTimeline(over: {markReplies?: boolean} = {}) {
  return render(
    <Timeline
      messages={[ROOT, MY_REPLY]}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS + 120_000}
      actions={actions()}
      {...over}
    />,
  );
}

describe('채널 타임라인에서', () => {
  it('답글 행이 답글이라고 말하고, 누구에게인지도 말한다', () => {
    renderTimeline();
    // 「↳ 김인턴님에게 답글」 — 글리프와 이름이 한 줄에.
    expect(screen.getAllByTestId('reply-marker')).toHaveLength(1);
    expect(screen.getByText('↳ 김인턴님에게 답글')).toBeTruthy();
  });

  it('루트를 아직 안 불렀으면 답글이라고만 한다 — 없는 이름을 지어내지 않는다', () => {
    render(
      <Timeline
        messages={[MY_REPLY]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS + 120_000}
        actions={actions()}
      />,
    );
    expect(screen.getByText('↳ 답글')).toBeTruthy();
  });

  it('루트에는 롤업이 붙는다 — 답글을 단 결과가 화면에 남는다', () => {
    renderTimeline();
    expect(screen.getByTestId('thread-rollup')).toBeTruthy();
    expect(screen.getByText(/답글 1개/)).toBeTruthy();
  });

  it('루트에는 표식이 없다 — 표식은 답글만의 것이다', () => {
    render(
      <Timeline
        messages={[ROOT]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    expect(screen.queryByTestId('reply-marker')).toBeNull();
  });
});

describe('스레드 패널에서는 표식을 끄는 것이 맞다', () => {
  it('markReplies={false} 면 아무 행에도 안 붙는다', () => {
    // 전부 답글인 목록에서 행마다 「답글」이라고 적는 것은 정보가 아니라 소음이다.
    renderTimeline({markReplies: false});
    expect(screen.queryByTestId('reply-marker')).toBeNull();
  });
});

describe('한 단계 스레드 규칙은 그대로다', () => {
  it('답글에는 「답글 달기」가 없다 — 표식이 진입점을 새로 만들지 않는다', () => {
    // 표식은 자기가 속한 스레드를 여는 **이동**이지 「답글 달기」가 아니다.
    // 그 둘을 헷갈리면 서버가 "thread root must be a top-level message" 로
    // 거절하는 동작을 화면이 제안하게 된다.
    renderTimeline();
    const rows = screen.getAllByTestId('message-row');
    // 두 번째 행이 답글이다(seq 11).
    const replyRow = rows[1];
    fireEvent(replyRow, 'touchStart', {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    });
    fireEvent(screen.getAllByTestId('message-press')[1], 'longPress');

    // 시트는 열린다(반응·고치기·지우기는 답글에도 있다) — 답글 달기만 없다.
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    expect(screen.queryByTestId('sheet-reply')).toBeNull();
  });

  it('루트에는 여전히 있다', () => {
    renderTimeline();
    fireEvent(screen.getAllByTestId('message-row')[0], 'touchStart', {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    });
    fireEvent(screen.getAllByTestId('message-press')[0], 'longPress');
    expect(screen.getByTestId('sheet-reply')).toBeTruthy();
  });
});

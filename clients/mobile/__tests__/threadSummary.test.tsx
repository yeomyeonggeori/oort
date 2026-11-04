import type {Message, RosterMember, ThreadRollup} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {emptyTimeline, reconcileMessages} from '@momo/core/features/timeline/model';
import {
  THREAD_FACE_OVERLAP,
  THREAD_FACE_RING,
  THREAD_FACE_SIZE,
  liveThreadRollup,
} from '@momo/core/features/timeline/threadSummary';
import {cleanup, fireEvent, render, screen, within} from './fixtures/darkWorld';
import React from 'react';
import {StyleSheet} from 'react-native';

import {color} from '../src/design/tokens';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {buildThreadContext, rollupFor} from '../src/features/conversation/threadContext';

// =============================================================================
// 폰의 스레드 요약 줄 (#4878, owner 10-31): 겹친 얼굴(≤3, 22pt) + 「답글 N개」 + 안 읽은 답글이 있으면 신호색과
// 「새 답글 M」 칩. 「마지막 답글 X 전」은 없다. 줄 전체가 「스레드 열기」 버튼 하나다.
// 규칙(얼굴 상한·칩 조건·문구)은 코어 `threadSummary`가 정하고 웹이 같은 값을 받는다 — 여기서는 폰이 그것을 그대로
// 그리는지, 그리고 `rollupFor`가 서버의 얼굴·안 읽은 수를 버리지 않는지(버리면 얼굴이 영영 안 선다)를 잰다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const ids = {
  a: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1',
  b: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa2',
  c: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa3',
  d: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa4',
  e: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa5',
  agent: 'cccccccc-1111-4111-8111-cccccccccccc',
  gone: 'dddddddd-1111-4111-8111-dddddddddddd',
};
const ROOT_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
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
  member({id: ids.a, displayName: '가영', handle: 'a'}),
  member({id: ids.b, displayName: '나래', handle: 'b'}),
  member({id: ids.c, displayName: '다온', handle: 'c'}),
  member({id: ids.d, displayName: '라온', handle: 'd'}),
  member({id: ids.e, displayName: '마루', handle: 'e'}),
  member({id: ids.agent, displayName: '달무리봇', handle: 'dalmuri', kind: 'agent'}),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: ROOT_ID,
    channelId: 'ch',
    seq: 10,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: SELF,
    type: 'text',
    body: '배포는 금요일에 합니다.',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

function rollup(over: Partial<ThreadRollup> = {}): ThreadRollup {
  return {
    replyCount: 3,
    lastReplySeq: 13,
    lastReplyAtMs: BASE_MS + 60_000,
    participantIds: [ids.a, ids.b],
    participantCount: 2,
    ...over,
  };
}

function row(value: ThreadRollup, options: {onOpenThread?: jest.Mock | null} = {}) {
  const onOpenThread = options.onOpenThread === undefined ? jest.fn() : options.onOpenThread;
  return {
    onOpenThread,
    ...render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS + 120_000}
        rollup={value}
        actions={{
          myMemberId: SELF,
          onToggleReaction: async () => {},
          onEdit: async () => {},
          onDelete: async () => {},
          ...(onOpenThread === null ? {} : {onOpenThread}),
        }}
      />,
    ),
  };
}

// 얼굴은 보조기술에서 숨겨 둔 것이라(`accessibilityElementsHidden`) 조회가 숨은 요소를 포함해야 한다.
const HIDDEN = {includeHiddenElements: true} as const;
const faces = () => screen.queryAllByTestId('thread-face', HIDDEN);

// memo 비교자를 시험하는 다시 그리기용: 비교자가 보는 prop(`message`·`actions`·`chips`·`directory`)은 렌더 사이에 같은 참조다.
const STABLE_MESSAGE = message();
const STABLE_CHIPS: never[] = [];
const STABLE_ACTIONS = {
  myMemberId: SELF,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
  onOpenThread: jest.fn(),
};
function stableRow(value: ThreadRollup) {
  return (
    <MessageRow
      message={STABLE_MESSAGE}
      startsGroup
      directory={DIRECTORY}
      chips={STABLE_CHIPS}
      nowMs={BASE_MS + 120_000}
      rollup={value}
      actions={STABLE_ACTIONS}
    />
  );
}
const TIME_WORDS = /마지막|분 전|시간 전|일 전|방금|ago|last|just now/i;

afterEach(cleanup);

describe('겹친 얼굴', () => {
  it('참여자가 다섯이어도 얼굴은 셋이고 서버가 준 순서(최근 먼저) 그대로다', () => {
    row(rollup({participantIds: [ids.e, ids.d, ids.c, ids.b, ids.a], participantCount: 5}));
    const initials = faces().map(face => within(face).getByText(/^[가-힣]$/, HIDDEN).props.children);
    expect(initials).toEqual(['마', '라', '다']);
  });

  it('4명 이상이어도 얼굴 뒤에 숫자(+N)를 붙이지 않는다', () => {
    row(rollup({participantIds: [ids.e, ids.d, ids.c], participantCount: 9, replyCount: 12}));
    expect(screen.getByTestId('thread-count').props.children).toBe('답글 12개');
    expect(screen.queryByText(/\+\d/)).toBeNull();
  });

  it('에이전트는 기존 아바타 규칙(둥근 사각), 사람은 원, 명부에서 못 푸는 id는 「모른다」 표지다', () => {
    row(rollup({participantIds: [ids.agent, ids.a, ids.gone]}));
    const [agent, human, unknown] = faces();
    expect(within(agent).getByTestId('avatar-agent', HIDDEN)).toBeTruthy();
    expect(within(human).getByTestId('avatar-human', HIDDEN)).toBeTruthy();
    expect(within(unknown).getByTestId('avatar-unknown', HIDDEN)).toBeTruthy();
  });

  it('규격은 코어 숫자다: 얼굴 22 · 둘째부터 −6 겹침(링 두 겹 포함 −10) · 링 2는 래퍼가 맡는다', () => {
    row(rollup({participantIds: [ids.a, ids.b, ids.agent]}));
    const [first, second, third] = faces().map(face => StyleSheet.flatten(face.props.style));
    const box = THREAD_FACE_SIZE.phone + 2 * THREAD_FACE_RING;
    for (const style of [first, second, third]) {
      expect(style.width).toBe(box);
      expect(style.height).toBe(box);
      expect(style.padding).toBe(THREAD_FACE_RING);
      expect(style.backgroundColor).toBe(color.bg);
    }
    expect(first.marginLeft).toBeUndefined();
    expect(second.marginLeft).toBe(-(THREAD_FACE_OVERLAP + 2 * THREAD_FACE_RING));
    expect(third.marginLeft).toBe(-(THREAD_FACE_OVERLAP + 2 * THREAD_FACE_RING));
    // 링은 얼굴의 모양을 따른다: 사람은 원, 에이전트는 둥근 사각.
    expect(first.borderRadius).toBe(box / 2);
    expect(third.borderRadius).toBeLessThan(box / 2);
    // 안쪽 얼굴의 크기는 22다.
    const inner = StyleSheet.flatten(within(faces()[0]).getByTestId('avatar-human', HIDDEN).props.style);
    expect(inner.width).toBe(THREAD_FACE_SIZE.phone);
  });

  it('얼굴은 보조기술에 나가지 않는다', () => {
    row(rollup());
    const group = screen.getByTestId('thread-faces', HIDDEN);
    expect(group.props.accessibilityElementsHidden).toBe(true);
    expect(group.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('옛 서버(참여자 없음)는 얼굴 없이 지금 모양 그대로다', () => {
    row(rollup({participantIds: undefined, participantCount: undefined}));
    expect(screen.queryByTestId('thread-faces', HIDDEN)).toBeNull();
    expect(screen.getByTestId('thread-count').props.children).toBe('답글 3개');
  });
});

describe('글, 칩, 시간 문구', () => {
  it('「마지막 답글 X 전」은 어떤 값에서도 없다 — 그리는 글도 접근성 라벨도', () => {
    for (const lastReplyAtMs of [BASE_MS + 119_000, BASE_MS - 90 * 60_000, BASE_MS - 4 * 86_400_000]) {
      for (const unreadReplyCount of [undefined, 0, 3]) {
        const view = row(rollup({lastReplyAtMs, unreadReplyCount}));
        const drawn = JSON.stringify(view.toJSON());
        expect(drawn).not.toMatch(TIME_WORDS);
        view.unmount();
      }
    }
  });

  it('양수면 글이 신호색이 되고 「새 답글 M」 칩이 붙는다', () => {
    row(rollup({unreadReplyCount: 2}));
    expect(StyleSheet.flatten(screen.getByTestId('thread-count').props.style).color).toBe(color.accentText);
    const chip = screen.getByTestId('thread-unread-chip');
    expect(within(chip).getByText('새 답글 2')).toBeTruthy();
    expect(StyleSheet.flatten(chip.props.style).backgroundColor).toBe(color.accent);
  });

  it.each([undefined, 0])('값이 %s 이면 지금 모양 — 칩도 강조도 없다', unreadReplyCount => {
    row(rollup({unreadReplyCount}));
    expect(screen.queryByTestId('thread-unread-chip')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('thread-count').props.style).color).toBe(color.text);
  });

  it('행을 한 번에 읽어 주는 낭독의 꼬리에 「답글 N개, 새 답글 M」이 든다', () => {
    row(rollup({unreadReplyCount: 2}));
    // 행 라벨의 꼬리다(끝이 「2」). 줄 버튼의 라벨(「…새 답글 2개」)과 구별한다.
    expect(screen.getByLabelText(/, 답글 3개, 새 답글 2$/)).toBeTruthy();
  });

  it('칩이 사라지면(0) 행이 다시 그려진다 — memo 비교자가 안 읽은 수를 본다', () => {
    // 비교자가 보는 다른 prop은 **같은 참조**로 둔다: 매번 새 `actions`를 넘기면 비교자와 상관없이 다시 그려져서 이 시험이
    // 아무것도 지키지 못한다(비교자에서 `unreadReplyCount` 줄을 지워도 초록이었다).
    const view = render(stableRow(rollup({unreadReplyCount: 2})));
    expect(screen.getByTestId('thread-unread-chip')).toBeTruthy();
    view.rerender(stableRow(rollup({unreadReplyCount: 0})));
    expect(screen.queryByTestId('thread-unread-chip')).toBeNull();
  });

  it('얼굴이 바뀌어도 다시 그려진다 — 비교자가 참여자를 본다', () => {
    const view = render(stableRow(rollup({participantIds: [ids.a]})));
    expect(faces()).toHaveLength(1);
    view.rerender(stableRow(rollup({participantIds: [ids.a, ids.b]})));
    expect(faces()).toHaveLength(2);
  });
});

describe('줄 전체가 하나의 버튼', () => {
  it('접근성 라벨은 「스레드 열기, 답글 N개(, 새 답글 M개)」이고 얼굴·글·칩 어디를 눌러도 한 번의 열기다', () => {
    const {onOpenThread} = row(rollup({unreadReplyCount: 2}));
    const button = screen.getByTestId('thread-rollup');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('스레드 열기, 답글 3개, 새 답글 2개');
    fireEvent.press(screen.getByTestId('thread-unread-chip'));
    fireEvent.press(screen.getByTestId('thread-count'));
    expect(onOpenThread).toHaveBeenCalledTimes(2);
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({id: ROOT_ID}));
  });

  it('안 읽은 답글이 없으면 라벨에 새 답글이 없다', () => {
    row(rollup());
    expect(screen.getByTestId('thread-rollup').props.accessibilityLabel).toBe('스레드 열기, 답글 3개');
  });

  it('열 곳이 없으면 버튼 대신 같은 모양의 글이다 — 죽은 문을 만들지 않는다', () => {
    row(rollup({unreadReplyCount: 1}), {onOpenThread: null});
    const label = screen.getByTestId('thread-rollup');
    expect(label.props.accessibilityRole).toBeUndefined();
    expect(within(label).getByText('답글 3개')).toBeTruthy();
    expect(within(label).getByText('새 답글 1')).toBeTruthy();
  });
});

describe('rollupFor — 서버의 얼굴과 안 읽은 수가 폰까지 오고, 폰도 웹과 같은 코어 함수다', () => {
  const root = message({
    thread: {
      reply_count: 3,
      last_reply_seq: 13,
      last_reply_at: BASE_MS,
      participant_ids: [ids.a, ids.b],
      participant_count: 2,
      unread_reply_count: 1,
    },
  });
  const reply = (seq: number, over: Partial<Message> = {}) =>
    message({id: `reply-${seq}`, seq, rootId: ROOT_ID, authorMemberId: ids.a, ...over});

  it('서버가 준 참여자·안 읽은 수를 버리지 않는다(버리면 폰에 얼굴이 영영 안 선다)', () => {
    const merged = rollupFor(root, buildThreadContext([root]));
    expect(merged?.participantIds).toEqual([ids.a, ids.b]);
    expect(merged?.participantCount).toBe(2);
    expect(merged?.unreadReplyCount).toBe(1);
  });

  it('값이 없으면 없는 채로 둔다 — 따라가지 않는 스레드는 칩이 없다', () => {
    const silent = message({thread: {reply_count: 3, last_reply_seq: 13, last_reply_at: BASE_MS}});
    const merged = rollupFor(silent, buildThreadContext([silent, reply(14)]), SELF);
    expect(merged).not.toHaveProperty('unreadReplyCount');
    expect(merged?.participantIds).toEqual([]);
  });

  it('페이지를 읽은 뒤 들어온 남의 답글을 든 배열로 세어 얹고, 내 것·지운 것·머리 이전은 세지 않는다', () => {
    const held = [
      root,
      reply(13), // 머리와 같다 — 서버 값에 들어 있다
      reply(14), // 센다
      reply(15, {authorMemberId: SELF}), // 내 것
      reply(16, {state: 'deleted', body: undefined}), // 지운 것
      reply(17), // 센다
    ];
    expect(rollupFor(root, buildThreadContext(held), SELF)?.unreadReplyCount).toBe(3);
    // 내가 누군지 모르면 서버 값 그대로다.
    expect(rollupFor(root, buildThreadContext(held))?.unreadReplyCount).toBe(1);
  });

  it('같은 답글이 되쏘기로 두 번 배달되어도 안 읽은 수가 두 번 오르지 않는다 — 센 것은 프레임이 아니라 든 배열이다', () => {
    const once = reconcileMessages(emptyTimeline(), [root, reply(14)]);
    const twice = reconcileMessages(once, [reply(14)]);
    expect(twice.messages).toHaveLength(once.messages.length);
    expect(rollupFor(root, buildThreadContext(twice.messages), SELF)?.unreadReplyCount).toBe(2);
    expect(rollupFor(root, buildThreadContext(twice.messages), SELF)?.unreadReplyCount).toBe(
      rollupFor(root, buildThreadContext(once.messages), SELF)?.unreadReplyCount,
    );
  });

  it('서버 롤업이 없는 루트(방금 단 첫 답글)는 「답글 1개」와 얼굴이 서고 칩은 없다 — 웹과 같다', () => {
    const bare = message();
    const merged = rollupFor(bare, buildThreadContext([bare, reply(14)]), SELF);
    expect(merged).toMatchObject({replyCount: 1, participantIds: [ids.a], lastReplySeq: 14});
    expect(merged).not.toHaveProperty('unreadReplyCount');
  });

  it('열어 보지 않은 스레드에서도 수·얼굴이 오르고, 승인 카드는 수에만 들고, 열린 스레드는 칩만 0이다 — 코어 함수 그대로 (#5032)', () => {
    // 서버 3(머리 13) + 머리 뒤 새 답글 1. 예전 폰의 max(서버, 로컬)은 3이었고 얼굴은 그대로였다.
    const fresh = reply(14, {authorMemberId: ids.c});
    const phone = rollupFor(root, buildThreadContext([root, fresh]), SELF);
    expect(phone).toMatchObject({
      replyCount: 4,
      unreadReplyCount: 2,
      participantIds: [ids.c, ids.a, ids.b],
    });
    // 같은 입력을 코어가 직접 풀어도 같은 값이다: 폰에는 요약 산수가 하나도 남지 않았다.
    expect(phone).toEqual(liveThreadRollup(root, [fresh], SELF));
    // 요청 묶음의 승인 카드 답글은 서버 reply_count가 세므로 수·얼굴에 들고, 안 읽은 수(text만)에는 안 든다.
    // 작업 세션의 system 줄은 서버가 안 세므로 어느 쪽에도 안 든다.
    const card = reply(15, {type: 'approval_request', authorMemberId: ids.d});
    const note = reply(16, {type: 'system', authorMemberId: ids.e});
    expect(rollupFor(root, buildThreadContext([root, card, note]), SELF)).toMatchObject({
      replyCount: 4,
      unreadReplyCount: 1,
      participantIds: [ids.d, ids.a, ids.b],
    });
    // 스레드 화면이 열려 앱이 앞이면(viewing) 안 읽은 수만 0이다. 수·얼굴은 그대로 오른다.
    expect(rollupFor(root, buildThreadContext([root, fresh]), SELF, true)).toMatchObject({
      replyCount: 4,
      unreadReplyCount: 0,
      participantIds: [ids.c, ids.a, ids.b],
    });
  });
});

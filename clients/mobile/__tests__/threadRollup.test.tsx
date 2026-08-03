import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import {Timeline} from '../src/features/conversation/Timeline';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';

// =============================================================================
// 「답글 N개」는 **목록의 장치**다 (goal RN-U2).
//
// 성재, iPhone 17: "답글에서 개수 업데이트는 굳이 왜 해? 목록에 나오면 몇 개의
// reply가 있는지는 자연스러운데, 답글에서 '답글 1개' 이런 식으로 보이는 건
// 자연스럽지 않은 거 같아."
//
// 맞는 지적이고, 이유는 그 줄이 무엇을 위한 것인지에 있다. 롤업은 채널을 훑는 사람에게
// **"여기 스레드가 있다"** 를 알린다 — 그것이 없으면 답글이 달렸다는 사실이 목록
// 어디에도 남지 않는다. 이미 그 스레드를 열어 둔 사람에게 같은 문장은 자기가 서 있는
// 곳의 이름을 다시 읽어 주는 것이고, 답글을 달 때마다 숫자가 오르는 것은 산만하다.
//
// 그래서 이 파일은 **같은 컴포넌트가 표면에 따라 다르게 말한다**를 양쪽으로 못 박는다.
// 한쪽만 검사하면 고치는 김에 반대쪽까지 지워도 아무도 모른다 — 그리고 채널에서
// 지워지면 스레드로 들어가는 유일한 시각적 단서가 사라진다.
//
// 조건은 **핸들러 유무가 아니다.** 패널은 이미 `onOpenThread` 를 주지 않았고, 그래서
// 롤업이 버튼 대신 글로 그려지고 있었을 뿐 여전히 그려졌다. 그리는 조건이 `rollup`
// 하나였기 때문이다. 끊은 것은 그 조건이다.
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

const ROOT = message({id: ROOT_ID, seq: 10});
const REPLY = message({
  id: 'reply-1',
  seq: 11,
  rootId: ROOT_ID,
  authorMemberId: SELF,
  body: '금요일 좋습니다.',
  createdAtMs: BASE_MS + 60_000,
});

/** 서버가 이미 롤업을 실어 준 루트 — 목록에서 오는 그 객체. */
const SERVED_ROOT = message({
  id: ROOT_ID,
  seq: 10,
  thread: {reply_count: 3, last_reply_seq: 13, last_reply_at: BASE_MS + 60_000},
});

function actions(openThread?: jest.Mock) {
  return {
    myMemberId: SELF,
    onToggleReaction: jest.fn().mockResolvedValue(undefined),
    onEdit: jest.fn().mockResolvedValue(undefined),
    onDelete: jest.fn().mockResolvedValue(undefined),
    onOpenThread: openThread,
  };
}

afterEach(cleanup);

// -----------------------------------------------------------------------------

describe('채널 목록에서는 그대로 남는다', () => {
  it('루트에 「답글 N개」가 붙는다 — 스레드가 있다는 유일한 단서다', () => {
    render(
      <Timeline
        messages={[ROOT, REPLY]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS + 120_000}
        actions={actions(jest.fn())}
      />,
    );
    expect(screen.getByTestId('thread-rollup')).toBeTruthy();
    expect(screen.getByText(/답글 1개/)).toBeTruthy();
  });

  it('서버가 실어 준 롤업도 그대로 그린다', () => {
    render(
      <Timeline
        messages={[SERVED_ROOT]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS + 120_000}
        actions={actions(jest.fn())}
      />,
    );
    expect(screen.getByText(/답글 3개/)).toBeTruthy();
  });
});

describe('스레드 안에서는 그리지 않는다', () => {
  it('showRollup={false} 면 루트 행에 「답글 N개」가 없다', () => {
    render(
      <Timeline
        messages={[ROOT, REPLY]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS + 120_000}
        actions={actions(undefined)}
        markReplies={false}
        showRollup={false}
      />,
    );
    expect(screen.queryByTestId('thread-rollup')).toBeNull();
    expect(screen.queryByText(/답글 \d+개/)).toBeNull();
  });

  it('서버가 롤업을 실어 준 루트여도 그리지 않는다', () => {
    // 이것이 핵심 경계다. 화면이 내려받은 객체에 `thread` 가 붙어 있으면 행은
    // 아무 지시 없이도 그것을 그린다 — 끄는 쪽이 `null` 을 **명시**해야 한다.
    render(
      <Timeline
        messages={[SERVED_ROOT]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS + 120_000}
        actions={actions(undefined)}
        markReplies={false}
        showRollup={false}
      />,
    );
    expect(screen.queryByTestId('thread-rollup')).toBeNull();
  });

  it('↳ 표식과 한 단계 규칙은 건드리지 않는다', () => {
    // 롤업을 끄는 것이 "이게 답글이다"를 말하는 다른 장치까지 끄면 안 된다.
    // 채널에서는 표식이 그대로 붙는다.
    render(
      <Timeline
        messages={[ROOT, REPLY]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS + 120_000}
        actions={actions(jest.fn())}
        showRollup={false}
      />,
    );
    expect(screen.getAllByTestId('reply-marker')).toHaveLength(1);
    expect(screen.getByText('↳ 김인턴님에게 답글')).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------

/** `ThreadPanel` 이 쓰는 만큼의 `useTimeline`. */
function panelTimeline(messages: Message[]): UseTimelineResult {
  return {
    state: {messages, oldestSeq: ROOT.seq, newestSeq: 30},
    status: 'ready',
    resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
    recoveryMarkers: [],
    pending: [],
    send: async () => {},
    resend: async () => {},
    toggleReaction: async () => {},
    editBody: async () => {},
    removeMessage: async () => {},
    loadReplies: async () => {},
    sendReply: async () => {},
    repliesPending: () => [],
    loadOlder: async () => {},
    reload: () => {},
    loadingOlder: false,
    reachedStart: true,
    reactions: {},
  } as unknown as UseTimelineResult;
}

async function renderPanel(messages: Message[]) {
  render(
    <ThreadPanel
      root={SERVED_ROOT}
      timeline={panelTimeline(messages)}
      directory={DIRECTORY}
      myMemberId={SELF}
      nowMs={BASE_MS + 120_000}
      onClose={() => {}}
    />,
  );
  // `loadReplies` 가 풀리고 status 가 'ready' 가 되는 프레임.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('스레드 화면 전체에서 개수가 사라진다', () => {
  it('루트 행에도, 헤더 부제에도 「답글 N개」가 없다', async () => {
    // 부제는 롤업과 **같은 결함이고 더 눈에 띄는 쪽**이었다: 답글을 하나 달 때마다
    // 화면 맨 위의 숫자가 올랐다. 성재가 인용한 문장("답글 1개")은 글자 그대로
    // 이 부제다.
    await renderPanel([SERVED_ROOT, REPLY]);
    expect(screen.queryByTestId('thread-rollup')).toBeNull();
    expect(screen.queryByText(/답글 \d+개/)).toBeNull();
  });

  it('화면 제목은 그대로 「스레드」다 — 여기가 어디인지는 계속 말한다', async () => {
    await renderPanel([SERVED_ROOT, REPLY]);
    expect(screen.getByTestId('thread-title').props.children).toBe('스레드');
  });

  it('답글이 없는 스레드는 여전히 첫 답글을 청한다', async () => {
    await renderPanel([SERVED_ROOT]);
    expect(screen.getByTestId('thread-empty')).toBeTruthy();
  });
});

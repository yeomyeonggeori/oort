import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen, within} from '@testing-library/react-native';
import React from 'react';

import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';

// =============================================================================
// 스레드 안에서 root 를 가리키는 인용은 그리지 않는다 (#5381, 요청 고리 §4.2).
//
// 판정은 코어 `isQuoteRedundant` 의 `threadRootId` 한 곳이고(`quote.test.ts` 가 표를 든다) 웹과 폰이 같은 함수를 쓴다. 이 파일은 그 판정이 **폰의 스레드
// 화면에 걸렸는지**만 본다: `ThreadPanel` 이 자기 목록(`Timeline`)에 root id 를 넘기고, 목록이 행마다 그 값으로 판정한다. 둘 중 하나가 빠지면 스레드의 모든
// 답이 맨 위에 서 있는 root 를 한 번 더 인용한다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
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
  member({id: AGENT, kind: 'agent', displayName: '코메토', handle: 'kometto'}),
]);

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `${seq}번째`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}

function quoted(target: Message) {
  return {
    id: target.id,
    seq: target.seq,
    authorMemberId: target.authorMemberId,
    type: 'text' as const,
    body: target.body,
    state: 'sent' as const,
  };
}

const ROOT = message(10, {id: 'root-1', body: '배포 되돌리기 절차 정리해 줄래요?'});
/** 서버가 풀어 준 인용이 root 를 가리키는 에이전트의 첫 답. */
const ANSWER_TO_ROOT = message(11, {
  id: 'reply-1',
  rootId: ROOT.id,
  authorMemberId: AGENT,
  body: '세 단계예요.',
  replyToId: ROOT.id,
  replyTo: quoted(ROOT),
});
/** 실시간 프레임으로 온 두 번째 답: `replyTo` 없이 `replyToId` 만 있고, 사이에 사람의 말이 끼었다. */
const LIVE_TO_ROOT = message(13, {
  id: 'reply-3',
  rootId: ROOT.id,
  authorMemberId: AGENT,
  body: '하나 더 있어요.',
  replyToId: ROOT.id,
});
const HUMAN_BETWEEN = message(12, {id: 'reply-2', rootId: ROOT.id, authorMemberId: SELF, body: '고마워요.'});
/** 스레드의 다른 답(사람의 말)을 가리키는 답 — 사이에 말이 끼어 있고 root 가 아니므로 그린다. */
const ANSWER_TO_REPLY = message(14, {
  id: 'reply-4',
  rootId: ROOT.id,
  authorMemberId: AGENT,
  body: '확인했어요.',
  replyToId: HUMAN_BETWEEN.id,
  replyTo: quoted(HUMAN_BETWEEN),
});

function renderThread(replies: Message[]) {
  const all = [ROOT, ...replies];
  const timeline = {
    state: {messages: all, oldestSeq: ROOT.seq, newestSeq: all[all.length - 1].seq},
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
    pins: {},
    pinsStatus: 'ready',
    reloadPins: () => {},
    togglePin: async () => {},
  } as unknown as UseTimelineResult;
  render(
    <ThreadPanel
      root={ROOT}
      timeline={timeline}
      directory={DIRECTORY}
      myMemberId={SELF}
      nowMs={BASE_MS + 120_000}
      onClose={() => {}}
    />,
  );
}


afterEach(cleanup);

describe('폰 스레드 화면: root 를 가리키는 인용', () => {
  it('root 를 가리키는 답에는 머리도 낭독 문장도 없다 — 서버가 풀어 준 인용과 실시간으로 온 인용 모두', () => {
    renderThread([ANSWER_TO_ROOT, HUMAN_BETWEEN, LIVE_TO_ROOT]);
    // 본문은 그대로 서 있다.
    expect(screen.getByText('세 단계예요.')).toBeTruthy();
    expect(screen.getByText('하나 더 있어요.')).toBeTruthy();
    // 인용 머리가 하나도 없고, 못 푼 인용(「원본을 아직 불러오지 않았습니다」)도 없다 — root 는 맨 위 행으로 이미 서 있다.
    expect(screen.queryAllByTestId('quote-block')).toHaveLength(0);
    expect(screen.queryByTestId('quote-unresolved')).toBeNull();
    // 행의 낭독 문장에도 「에게 답장」이 없다(그리지 않는 머리를 읽어 주지 않는다).
    for (const row of screen.getAllByTestId('message-row')) {
      expect(String(row.props.accessibilityLabel)).not.toContain('에게 답장');
    }
  });

  it('스레드의 다른 답을 가리키면(사이에 말이 끼었다) 그대로 그린다', () => {
    // 목록: root · 에이전트의 답 · 사람의 말(12) · 에이전트의 다른 답(13, root 를 가리켜 가려진다) · 12 를 가리키는 답(14). 13 이 12 와 14 사이에 끼어 있어
    // 14 의 인용 대상은 바로 위가 아니다.
    renderThread([ANSWER_TO_ROOT, HUMAN_BETWEEN, LIVE_TO_ROOT, ANSWER_TO_REPLY]);
    const heads = screen.getAllByTestId('quote-block');
    expect(heads).toHaveLength(1);
    expect(within(heads[0]).getByTestId('quote-head-label').props.children).toBe('곽성재에게 답장');
    expect(within(heads[0]).getByTestId('quote-body').props.children).toEqual(['고마워요.', '']);
  });
});

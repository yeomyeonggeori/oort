import type {TimelineItem} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Message, RosterMember} from '@momo/core/lib/api';
import {cleanup, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import {Timeline} from '../src/features/conversation/Timeline';
import {
  isSystemLineMessage,
  startGroupAfterSystemLine,
} from '../src/features/conversation/systemLineRows';

// =============================================================================
// 실행 중단 시스템 줄 (#5067, design-review M3).
//
// 서버는 사람이 에이전트 실행을 멈추면 `type: system`·`props.kind = agent_run_cancelled` 줄을 **멈춘 사람의 이름으로** 남긴다(`routes/agent_runs.rs`). 폰은 그 줄을
// 일반 행으로 그려서 멈춘 사람이 쓴 글처럼 붙였다. 이 파일은 **진짜 `Timeline`** 을 그려 그 줄이 시스템 줄 부품으로 서는지, 그 둘레(다음 행의 이름 머리·다른 시스템 줄)가
// 그대로인지 잰다. 하네스에 가짜는 없다 — 실제 서버가 보내는 props 모양을 그대로 쓴다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
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
  member({id: AGENT, displayName: '헤르메스', handle: 'hermes', kind: 'agent', ownerHumanId: SELF}),
]);

/** 서버가 중단 때 쓰는 문장 그대로(`CANCEL_SYSTEM_LINE`). 이 시험은 문장을 지어내지 않는다. */
const SERVER_LINE = '사람이 실행을 중지했어요.';

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: SELF,
    type: 'text',
    body: `메시지 ${seq}`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}

/** `agent_runs.rs` 가 싣는 props 모양 그대로. 작성자는 멈춘 사람이다. */
function cancelLine(seq: number, over: Partial<Message> = {}): Message {
  return message(seq, {
    type: 'system',
    body: SERVER_LINE,
    props: {
      kind: 'agent_run_cancelled',
      run_id: 'run-1',
      agent_member_id: AGENT,
      cancelled_by: SELF,
      linked_work_session_ids: [],
      work_sessions_terminated: false,
    },
    ...over,
  });
}

function renderTimeline(messages: Message[]) {
  return render(
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS + 60_000}
    />,
  );
}

const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | string | undefined>;

afterEach(cleanup);

describe('중단 시스템 줄이 서는 모양', () => {
  it('말풍선(행)이 아니라 시스템 줄 부품으로 서고, 서버 문장을 그대로 가운데에 말한다', () => {
    renderTimeline([message(1, {body: '이 일을 맡아 줘'}), cancelLine(2)]);

    expect(screen.getAllByTestId('system-line')).toHaveLength(1);
    const text = within(screen.getByTestId('system-line')).getByTestId('system-line-text');
    expect(text.props.children).toBe(SERVER_LINE); // 서버 문장 그대로 — 부품은 낱말을 고쳐 쓰지 않는다
    // 행은 사람 글 하나뿐이다 — 중단 줄은 행이 아니다(옛 판은 두 행이었다).
    expect(screen.getAllByTestId('message-row')).toHaveLength(1);
    // 문장은 화면에 정확히 한 번, 시스템 줄 안에만 있다.
    expect(screen.getAllByText(SERVER_LINE)).toHaveLength(1);
    // 가운데의 조용한 줄: 가운데 정렬이고, 본문 글씨(16)보다 작은 보조 글씨다.
    expect(flat(screen.getByTestId('system-line').props.style).alignItems).toBe('center');
    expect(flat(text.props.style).textAlign).toBe('center');
    expect(Number(flat(text.props.style).fontSize)).toBeLessThan(16);
  });

  it('작성자(멈춘 사람)의 아바타·이름 머리를 달지 않는다', () => {
    renderTimeline([cancelLine(1)]);
    expect(screen.getByTestId('system-line')).toBeTruthy();
    expect(screen.queryByTestId('message-row')).toBeNull();
    expect(screen.queryByTestId('message-avatar-slot')).toBeNull();
    expect(screen.queryByText('곽성재')).toBeNull();
  });

  it('멈춘 사람의 다음 글은 이름 머리를 다시 단다 — 위에 가운데 줄이 있어 이어진 행이 되면 누구 글인지 읽을 근거가 없다', () => {
    // 대조: 중단 줄이 없으면 같은 사람이 5분 안에 이어 쓴 글은 머리 없는 이어진 행이다(아바타 칸이 하나).
    const control = renderTimeline([message(1), message(3)]);
    expect(screen.getAllByTestId('message-avatar-slot')).toHaveLength(1);
    control.unmount();

    // 중단 줄이 사이에 서면 두 글 모두 묶음의 머리다.
    renderTimeline([message(1), cancelLine(2), message(3)]);
    expect(screen.getAllByTestId('message-row')).toHaveLength(2);
    expect(screen.getAllByTestId('message-avatar-slot')).toHaveLength(2);
  });

  it('다른 시스템 줄과 사람이 흉내 낸 글은 그대로 행이다', () => {
    renderTimeline([
      message(1, {type: 'system', body: '헤르메스는 이 대화에서 답하도록 승인되지 않았어요.', props: {kind: 'agent_paused', agent_member_id: AGENT}}),
      // 사람 글이 표식만 흉내 낸 것 — type 이 system 이 아니다.
      message(2, {body: '표식만 흉내', props: {kind: 'agent_run_cancelled'}}),
    ]);
    expect(screen.queryByTestId('system-line')).toBeNull();
    expect(screen.getAllByTestId('message-row')).toHaveLength(2);
  });

  it('서버가 문장을 안 준 중단 줄은 숨기지 않고 행으로 남는다', () => {
    renderTimeline([message(1), cancelLine(2, {body: undefined})]);
    expect(screen.queryByTestId('system-line')).toBeNull();
    expect(screen.getAllByTestId('message-row')).toHaveLength(2);
  });
});

describe('판정과 묶음 규칙', () => {
  it('isSystemLineMessage — 표식이 맞고 말이 있을 때만 참이다', () => {
    expect(isSystemLineMessage(cancelLine(1))).toBe(true);
    expect(isSystemLineMessage(cancelLine(1, {body: undefined}))).toBe(false);
    expect(isSystemLineMessage(cancelLine(1, {body: '   '}))).toBe(false);
    expect(isSystemLineMessage(cancelLine(1, {type: 'text'}))).toBe(false);
    expect(isSystemLineMessage(message(1))).toBe(false);
  });

  it('startGroupAfterSystemLine — 줄 바로 다음 행(글·보내는 중)만 새 묶음이고, 바꿀 것이 없으면 같은 배열이다', () => {
    const head: TimelineItem = {kind: 'message', key: 'm-1', message: message(1), startsGroup: true};
    const line: TimelineItem = {kind: 'message', key: 'm-2', message: cancelLine(2), startsGroup: false};
    const after: TimelineItem = {kind: 'message', key: 'm-3', message: message(3), startsGroup: false};
    const later: TimelineItem = {kind: 'message', key: 'm-4', message: message(4), startsGroup: false};
    const echo: TimelineItem = {
      kind: 'pending',
      key: 'p-1',
      pending: {clientMsgId: 'c1', body: '곧 보내요', status: 'sending', createdAtMs: BASE_MS} as never,
      startsGroup: false,
    };

    const folded = startGroupAfterSystemLine([head, line, after, later]);
    expect(folded.map(item => ('startsGroup' in item ? item.startsGroup : null))).toEqual([true, false, true, false]);
    // 보내는 중인 메아리도 줄 다음이면 머리다.
    expect(startGroupAfterSystemLine([line, echo]).map(item => ('startsGroup' in item ? item.startsGroup : null))).toEqual([false, true]);
    // 입력 배열은 건드리지 않고, 바꿀 것이 없으면 같은 배열이다.
    expect(after.startsGroup).toBe(false);
    const untouched = [head, after, later];
    expect(startGroupAfterSystemLine(untouched)).toBe(untouched);
    expect(startGroupAfterSystemLine([])).toEqual([]);
  });
});

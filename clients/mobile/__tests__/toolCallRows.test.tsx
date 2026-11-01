import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen, within} from '@testing-library/react-native';
import React from 'react';

import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// #4995. 서버는 `tool_call` 행을 한 번 쓰고 고치지 않는다(`{name, arguments, call_id}` 가 전부, `tools.rs`
// `ToolCall::message_props`). 끝은 같은 `call_id` 의 `tool_result` 행으로 **따로** 온다. 그래서 코어 카드 모델은
// 상태 없는 호출 행을 「생각 중」으로 읽고, 결과가 이미 와 있어도 폰의 칩이 계속 돌았다.
//
// 수리의 판단은 코어 한 함수(`presentableRows`)가 하고, 이 시험은 폰 타임라인이 그 함수를 **실제로 불러서**
// 호출 행이 닫힌 모양으로 그려지는지를 잰다 — 가짜 행이 아니라 진짜 `Timeline` → `MessageRow` 단계 줄이다.
// 짝짓기 규칙 자체(채널·삭제·상태 보존·접기 전 목록)는 코어 시험(`toolCallSettle.test.ts`)이 잰다.
//
// 호출 행과 결과 행은 **각자 단계 카드**를 그린다(목록은 오래된 것부터). 그래서 단정은 호출 행의 카드 하나로 좁혀서 한다.
// =============================================================================

afterEach(cleanup);

const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
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
  member({id: SELF_ID, displayName: '이도현', handle: 'dohyun'}),
  member({id: AGENT_ID, displayName: '헤르메스', handle: 'hermes', kind: 'agent', ownerHumanId: SELF_ID}),
]);

function row(
  type: 'tool_call' | 'tool_result',
  seq: number,
  props: Record<string, unknown>,
  body: string,
): Message {
  return {
    id: `${type}-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: AGENT_ID,
    type,
    body,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    props,
  } as Message;
}

// 서버가 쓰는 모양 그대로다: 호출은 `{name, arguments, call_id}`(본문은 서버의 영어 폴백), 결과는
// `{call_id, output, is_error}`(+ 거부·만료로 닫히면 `status`·`approval_id`).
const started = () =>
  row('tool_call', 1, {name: 'work.session.end', arguments: {}, call_id: 'c1'}, 'Tool call: work.session.end');
const finished = (props: Record<string, unknown> = {}) =>
  row('tool_result', 2, {call_id: 'c1', output: '끝냈어요', is_error: false, ...props}, '끝냈어요');

function renderTimeline(messages: Message[]) {
  return render(
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF_ID}
      nowMs={BASE_MS + 60_000}
    />,
  );
}

/** 호출 행(seq 1)의 단계 카드. 목록이 오래된 것부터 서는 것은 첫 시험이 결과 행의 글로 확인한다. */
function callCard() {
  return within(screen.getAllByTestId('agent-card-steps')[0]);
}

describe('끝난 도구 호출 카드는 폰 타임라인에서 닫힌 모양으로 그려진다 (#4995)', () => {
  it('결과가 목록에 있으면 호출 카드는 완료로 닫히고, 제목은 서버의 이름으로 선다', () => {
    renderTimeline([started(), finished()]);
    // 호출 카드 하나와 결과 카드 하나, 둘 다 단계 카드다. 첫째가 호출 행이고 둘째가 결과 행이다.
    const cards = screen.getAllByTestId('agent-card-steps');
    expect(cards).toHaveLength(2);
    expect(within(cards[1]).getByText(/끝냈어요/)).toBeTruthy();
    const call = callCard();
    expect(call.getByText('완료')).toBeTruthy();
    expect(call.getByTestId('step-mark-ok')).toBeTruthy();
    // 돌고 있는 표지·「생각 중」이 어디에도 남지 않는다.
    expect(call.queryByTestId('step-mark-run')).toBeNull();
    expect(call.queryByText('생각 중')).toBeNull();
    expect(screen.queryByTestId('step-mark-run')).toBeNull();
    // 이름 없는 「도구 실행」이 아니라 서버가 보낸 `name` 으로 말한다.
    expect(call.getByText(/work\.session\.end 실행/)).toBeTruthy();
  });

  it('결과가 오류면 실패로 닫힌다', () => {
    renderTimeline([started(), finished({is_error: true, output: '권한이 없어요'})]);
    const call = callCard();
    expect(call.getByText('실패')).toBeTruthy();
    expect(call.getByTestId('step-mark-fail')).toBeTruthy();
    expect(call.queryByText('생각 중')).toBeNull();
  });

  it.each(['rejected', 'expired'])(
    '%s 로 닫힌 결과면 실패가 아니라 중단으로 닫힌다 (사람이 한 일은 오류가 아니다)',
    status => {
      renderTimeline([started(), finished({is_error: true, status, approval_id: 'ap-1', output: '닫혔어요'})]);
      const call = callCard();
      expect(call.getByText('중단됨')).toBeTruthy();
      expect(call.getByTestId('step-mark-idle')).toBeTruthy();
      expect(call.queryByTestId('step-mark-fail')).toBeNull();
      expect(call.queryByText('생각 중')).toBeNull();
    },
  );

  it('결과가 아직 없으면 「생각 중」이 맞는 말이라 그대로 돈다', () => {
    renderTimeline([started()]);
    const call = callCard();
    expect(call.getByText('생각 중')).toBeTruthy();
    expect(call.getByTestId('step-mark-run')).toBeTruthy();
    expect(call.queryByText('완료')).toBeNull();
  });

  it('호출 뒤에 결과가 도착하면 같은 카드가 닫힌다', () => {
    const view = renderTimeline([started()]);
    expect(callCard().getByText('생각 중')).toBeTruthy();
    view.rerender(
      <Timeline
        messages={[started(), finished()]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF_ID}
        nowMs={BASE_MS + 60_000}
      />,
    );
    const call = callCard();
    expect(call.getByText('완료')).toBeTruthy();
    expect(call.queryByText('생각 중')).toBeNull();
    expect(screen.queryByTestId('step-mark-run')).toBeNull();
  });
});

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
  type: Message['type'],
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

// #5066 (검증 줄 1회차 H2). 승인이 걸린 호출은 호출 카드가 따로 말하지 않는다: 같은 목록에 짝 승인 카드가 있으면 코어
// (`presentableRows`)가 그 호출 행을 접어서 승인 카드 한 장이 말한다. 옛 #5009 는 거부·만료·취소로 끝난 승인이 호출 카드를
// 「중단됨」으로 닫았는데, 그 낱말은 바로 아래 승인 카드의 「만료」·「거부」와 다른 사실을 말했고, 결정을 기다리는 동안과 기한이
// 지난 직후에는 닫지도 못해 「생각 중」으로 돌았다. 이 시험은 진짜 `Timeline` → `MessageRow` 가 그린 화면에서 한 번의 도구 승인이
// 상태 낱말을 하나만 말하고, 그 낱말이 승인 카드의 것(사전: 승인 필요 · 만료 · 거부 · 취소)임을 잰다. 카드는 서버가 새 카드에
// 싣는 모양(`decision_mode`·`intent`)이라 묶음 카드 문법으로 그려진다.
describe('승인이 걸린 도구 호출은 폰 타임라인에서 승인 카드 한 장이 말한다 (#5066)', () => {
  const DEADLINE = BASE_MS + 10 * 60_000;
  const bundleApproval = (status: string, extra: Record<string, unknown> = {}) =>
    row(
      'approval_request',
      3,
      {
        approval_id: 'ap-1',
        call_id: 'c1',
        tool_name: 'work.session.end',
        action_type: 'tool_call',
        approval_status: status,
        status,
        decision_mode: 'inline',
        intent: '작업 세션을 끝내요',
        expires_at_ms: DEADLINE,
        ...extra,
      },
      '승인 요청',
    );
  const STALE_WORDS = ['생각 중', '중단됨'];
  /** 화면에 선 상태 낱말은 승인 카드의 것 하나뿐이다: 상태 표지 하나, 호출 단계 카드와 도는 표지는 없다. */
  function expectOneSpeaker(state: string, word: string) {
    expect(screen.getAllByTestId(/^request-state-/)).toHaveLength(1);
    expect(within(screen.getByTestId(`request-state-${state}`)).getByText(word)).toBeTruthy();
    expect(screen.queryAllByTestId('agent-card-steps')).toHaveLength(0);
    expect(screen.queryByTestId('step-mark-run')).toBeNull();
    for (const stale of STALE_WORDS) expect(screen.queryByText(stale)).toBeNull();
    expect(screen.queryByText(/Tool call/)).toBeNull();
  }

  it('결정을 기다리는 동안: 호출 카드는 「생각 중」으로 돌지 않고 승인 카드가 「승인 필요」를 말한다', () => {
    renderTimeline([started(), bundleApproval('pending')]);
    expectOneSpeaker('approval', '승인 필요');
  });

  it('기한이 지나면 서버가 카드를 고치기 전에도 시계로 「만료」다: 같은 카드가 낱말을 바꾸고 호출 카드는 여전히 없다', () => {
    const view = renderTimeline([started(), bundleApproval('pending')]);
    expectOneSpeaker('approval', '승인 필요');
    view.rerender(
      <Timeline
        messages={[started(), bundleApproval('pending')]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF_ID}
        nowMs={DEADLINE + 1_000}
      />,
    );
    expectOneSpeaker('expired', '만료');
  });

  it('서버가 카드를 고친 뒤에도 「만료」이고 「중단됨」으로 닫히지 않는다', () => {
    renderTimeline([started(), bundleApproval('expired', {code: 'approval_expired', summary: '승인을 기다리다 만료됐어요'})]);
    expectOneSpeaker('expired', '만료');
  });

  it('거부는 「거부」, 취소는 「취소」다', () => {
    const view = renderTimeline([started(), bundleApproval('rejected', {code: 'approval_rejected', summary: '거부됐어요'})]);
    expectOneSpeaker('declined', '거부');
    view.unmount();
    renderTimeline([started(), bundleApproval('cancelled', {code: 'human_cancelled', summary: '요청을 멈췄어요'})]);
    expectOneSpeaker('cancelled', '취소');
  });

  it('승인됨 카드도 호출 카드를 따로 세우지 않는다: 승인 카드가 말한다', () => {
    renderTimeline([started(), bundleApproval('approved')]);
    expect(screen.getAllByTestId(/^request-state-/)).toHaveLength(1);
    expect(screen.queryAllByTestId('agent-card-steps')).toHaveLength(0);
  });

  it('승인 카드가 없는 호출은 지금 그대로다: 호출 카드가 서고 「생각 중」이 맞는 말이다', () => {
    renderTimeline([started()]);
    expect(screen.getAllByTestId('agent-card-steps')).toHaveLength(1);
    expect(callCard().getByText('생각 중')).toBeTruthy();
  });
});

describe('도구 카드의 결과 문장과 제목 (#5009)', () => {
  it('호출 카드는 서버의 영어 폴백 없이 이름만 말하고, 결과 카드는 호출 행의 이름으로 제목을 말한다', () => {
    renderTimeline([started(), finished()]);
    const cards = screen.getAllByTestId('agent-card-steps');
    expect(cards).toHaveLength(2);
    // 정확히 같은 글자여야 한다: 뒤에 「→ Tool call: …」 가 붙으면 이 단정이 깨진다.
    expect(within(cards[0]).getByText('work.session.end 실행')).toBeTruthy();
    expect(within(cards[0]).getByText('완료')).toBeTruthy();
    expect(within(cards[1]).getByText('work.session.end 실행 → 끝냈어요')).toBeTruthy();
    expect(screen.queryByText(/Tool call/)).toBeNull();
  });

  it('짝이 되는 호출 행이 목록에 없으면 결과 카드 제목은 지금 문구 그대로다', () => {
    renderTimeline([finished()]);
    expect(within(screen.getAllByTestId('agent-card-steps')[0]).getByText('도구 실행 → 끝냈어요')).toBeTruthy();
  });
});

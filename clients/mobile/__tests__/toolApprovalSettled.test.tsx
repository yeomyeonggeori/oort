import type {AgentRunProgress, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import * as progressStore from '../src/features/agents/agentRunProgressStore';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// #5168 (검증 줄 3회차, #5066 의 다음 국면). 승인한 도구 호출은 결정 뒤 워커에서 실행되고, 끝은 같은 `call_id` 의
// `tool_result` 행으로 따로 온다. 서버는 도구 승인 카드를 그때 다시 고치지 않는다(「실행 중 → 끝」은 run 이 말한다). 카드가
// run 을 못 받는 동안(진행 읽기가 늦거나 채널의 최근 run 30개 밖) 승인 카드는 「실행 중 · 승인됐어요 · 이어서 하는 중」에
// 머물고 결과 행은 도구 카드로 「완료」를 한 장 더 말했다 — 한 호출에 카드가 둘, 서로 다른 말.
//
// 수리의 판단은 코어 한 함수(`presentableRows`)가 하고, 이 시험은 폰 타임라인이 그 함수를 **실제로 불러서** 한 호출이
// 한 장으로 그려지는지를 잰다(가짜 행이 아니라 진짜 `Timeline` → `MessageRow` → `RequestBundleCard`). 짝짓기 규칙 자체(채널 ·
// 삭제 · 순서 · 승인 종류)는 코어 시험(`toolCallSettle.test.ts`)이 재고, 웹 짝은 `toolApprovalSettled.test.tsx`(clients/web)다.
//
// 픽스처는 서버가 쓰는 모양 그대로다: 호출은 `{name, arguments, call_id}`, 승인 카드는 처음부터 `call_id` · `tool_name` ·
// `action_type` 을 싣고 결정하면 `status` · `approval_status` 를 한 패치로 함께 고치며(`decided_props_patch`), 결과는
// `{call_id, output, is_error}` 가 전부다(`ToolResult::message_props`).
// =============================================================================

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

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
  member({id: AGENT_ID, displayName: '김인턴', handle: 'kim-intern', kind: 'agent', ownerHumanId: SELF_ID}),
]);

function row(
  type: Message['type'],
  seq: number,
  props: Record<string, unknown>,
  body: string,
  over: Partial<Message> = {},
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
    ...over,
  } as Message;
}

const request = () => row('text', 1, {}, '@kim-intern 작업 세션을 끝내 줘', {authorMemberId: SELF_ID});
const started = () =>
  row('tool_call', 2, {name: 'work.session.end', arguments: {}, call_id: 'c1'}, 'Tool call: work.session.end');
const card = (status: string) =>
  row(
    'approval_request',
    3,
    {
      approval_id: 'ap-1',
      run_id: 'run-1',
      channel_id: 'ch',
      call_id: 'c1',
      tool_name: 'work.session.end',
      action_type: 'tool_call',
      title: '도구 「work.session.end」 실행',
      summary: '실행할 도구를 확인하고 결정해 주세요.',
      decision_mode: 'inline',
      approval_status: status,
      status,
      expires_at_ms: BASE_MS + 600_000,
      ...(status === 'pending' ? {} : {decided_by: SELF_ID, decided_at_ms: BASE_MS + 5_000}),
    },
    '승인 요청',
  );
const finished = (callId = 'c1', props: Record<string, unknown> = {}) =>
  row('tool_result', 4, {call_id: callId, output: '끝냈어요', is_error: false, ...props}, '끝냈어요');

function renderTimeline(messages: Message[]) {
  return render(
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF_ID}
      nowMs={BASE_MS + 60_000}
      showRollup={false}
    />,
  );
}

const rerender = (view: ReturnType<typeof renderTimeline>, messages: Message[]) =>
  view.rerender(
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF_ID}
      nowMs={BASE_MS + 60_000}
      showRollup={false}
    />,
  );

/** 화면의 묶음 카드 수와 도구 단계 카드 수. 한 번의 도구 승인은 어느 국면에서나 `[1, 0]` 이다. */
const counts = () => [
  screen.queryAllByTestId('request-bundle-card').length,
  screen.queryAllByTestId('agent-card-steps').length,
];
/** 묶음 카드가 말하는 상태(`request-state-<state>`). 카드가 한 장이므로 한 개다. */
const states = () => screen.queryAllByTestId(/^request-state-/).map(node => node.props.testID);

describe('승인한 도구 호출은 폰에서 끝난 뒤 카드 한 장이 닫힌 상태를 말한다 (#5168)', () => {
  it('승인 → 실행 → 성공: 한 마운트에서 「승인 필요」 → 「실행 중」 → 「끝」으로 바뀌고 어느 때에도 카드는 한 장이다', () => {
    const view = renderTimeline([request(), started(), card('pending')]);
    expect(states()).toEqual(['request-state-approval']);
    expect(counts()).toEqual([1, 0]);

    rerender(view, [request(), started(), card('approved')]);
    expect(states()).toEqual(['request-state-executing']);
    expect(counts()).toEqual([1, 0]);

    rerender(view, [request(), started(), card('approved'), finished()]);
    expect(states()).toEqual(['request-state-done']);
    expect(counts()).toEqual([1, 0]);
    // 닫힌 말을 하고, 「실행 중」의 옛 문장이 남지 않으며, 결과 줄(「완료」 단계 카드)이 따로 서지 않는다.
    expect(screen.getByTestId('request-bundle-sentence')).toHaveTextContent('실행을 마쳤어요');
    expect(screen.queryByText(/이어서 하는 중/)).toBeNull();
    expect(screen.queryByText('완료')).toBeNull();
  });

  it('결과가 오류면 「실패」로 닫히고 결과 줄은 따로 서지 않는다', () => {
    renderTimeline([request(), started(), card('approved'), finished('c1', {is_error: true, output: '권한이 없어요'})]);
    expect(states()).toEqual(['request-state-failed']);
    expect(counts()).toEqual([1, 0]);
    expect(screen.getByTestId('request-bundle-sentence')).toHaveTextContent(/실행을 끝내지 못했어요/);
  });

  it('다른 call_id 의 결과는 이 카드를 닫지 않는다: 카드는 「실행 중」 그대로이고 그 결과는 도구 카드로 따로 선다', () => {
    renderTimeline([request(), started(), card('approved'), finished('c2')]);
    expect(states()).toEqual(['request-state-executing']);
    expect(counts()).toEqual([1, 1]);
  });

  it('run 이 이어져 있고 끝났으면 결과 행이 아직 없어도 「끝」이다: run 이 말하는 길은 그대로 선다', () => {
    const run = {
      id: 'run-1',
      channelId: 'ch',
      agentMemberId: AGENT_ID,
      triggerMessageId: request().id,
      status: 'succeeded',
      phase: 'succeeded',
      leaseState: 'none',
      stepCount: 3,
      ahead: [],
      createdAtMs: BASE_MS,
      updatedAtMs: BASE_MS,
      bundle: {
        approvalId: 'ap-1',
        status: 'approved',
        decisionMode: 'inline',
        canDecide: false,
        actionType: 'tool_call',
      },
    } as AgentRunProgress;
    jest.spyOn(progressStore, 'useChannelRuns').mockReturnValue([run]);
    renderTimeline([request(), started(), card('approved')]);
    expect(states()).toEqual(['request-state-done']);
    expect(counts()).toEqual([1, 0]);
  });
});

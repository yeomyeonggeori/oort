// 칩과 예외 줄은 **같은 순간**에 같은 낱말로 바뀐다 (#4620 B·D). 같은 행에 함께 서는 두 자리가 다른 말을 하면 사람이 둘을 다른 상태로 읽는다.
// 예외 줄(`MessageRunStatus`)은 유예 마감에 서고, 칩은 `Timeline`이 분 단위 시계(`nowMs`)로 계산한다 — 그대로면 칩이 최대 1분 늦는다.
// 여기서는 예외 줄을 비우고(그 쪽 타이밍은 `runLedgerSheet.test`가 붙든다) 칩만 본다. 그리고 행의 접근성 묶음 규칙을 함께 붙든다.

import type {AgentRunProgress, Message, RosterMember} from '@momo/core/lib/api';
import {UNCOLLECTED_WORD} from '@momo/core/features/agents/runWaiting';
import {RAIL_WORD} from '@momo/core/features/agents/activityRail';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import * as progressStore from '../src/features/agents/agentRunProgressStore';
import {MessageRow, type MessageRowActions} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';
import {drainRender} from './testkit';

jest.mock('../src/features/agents/MessageRunStatus', () => ({
  ...jest.requireActual('../src/features/agents/MessageRunStatus'),
  MessageRunStatus: () => null,
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const BOT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const MSG = '22222222-2222-4222-8222-222222222222';
const DIRECTORY = makeDirectory(
  [
    {id: SELF, kind: 'human', displayName: '이도현', handle: 'dohyun'},
    {id: BOT, kind: 'agent', displayName: '달무리봇', handle: 'dalmuri'},
  ].map(
    entry =>
      ({
        workspaceId: 'ws',
        status: 'active',
        channelCount: 1,
        channelIds: [],
        capabilities: [],
        createdAtMs: 0,
        updatedAtMs: 0,
        ...entry,
      }) as RosterMember,
  ),
);

const request = (): Message =>
  ({
    id: MSG,
    channelId: 'ch',
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: SELF,
    type: 'text',
    body: '이번 주 일정 정리해 줘',
    state: 'sent',
    createdAtMs: Date.now() - 6 * 60_000,
  }) as Message;

const queuedRun = (waitedMs: number, extra: Partial<AgentRunProgress> = {}): AgentRunProgress =>
  ({
    id: 'run-1',
    channelId: 'ch',
    agentMemberId: BOT,
    triggerMessageId: MSG,
    status: 'queued',
    phase: 'queued',
    leaseState: 'none',
    stepCount: 0,
    ahead: [],
    createdAtMs: Date.now() - waitedMs,
    updatedAtMs: Date.now() - waitedMs,
    ...extra,
  }) as unknown as AgentRunProgress;

afterEach(async () => {
  await drainRender();
  cleanup();
  jest.restoreAllMocks();
});

function mountTimeline(run: AgentRunProgress) {
  jest.spyOn(progressStore, 'useChannelRuns').mockReturnValue([run]);
  // `nowMs`는 한 번 읽어 못 박는다 — 분 단위 시계가 아직 안 돈 화면이다.
  return render(
    <Timeline
      messages={[request()]}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={Date.now()}
      showRollup={false}
      actions={{myMemberId: SELF} as unknown as MessageRowActions}
    />,
  );
}

describe('칩은 유예 마감에 바뀐다 (#4620)', () => {
  it('마감(5분)까지 0.5초 남은 대기: 처음엔 「받음」, 분 단위 시계가 돌지 않아도 마감에 「아직 받지 않았어요」로 바뀐다', async () => {
    mountTimeline(queuedRun(5 * 60_000 - 500));
    expect(screen.getByTestId('request-status-chip')).toHaveTextContent(RAIL_WORD.received);
    await waitFor(
      () => expect(screen.getByTestId('request-status-chip')).toHaveTextContent(UNCOLLECTED_WORD),
      {timeout: 2_500},
    );
  });

  it('대조: 마감이 멀면 같은 시간이 흘러도 바뀌지 않는다 — 가짜로 바꾸는 시계가 아니다', async () => {
    mountTimeline(queuedRun(60_000));
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(screen.getByTestId('request-status-chip')).toHaveTextContent(RAIL_WORD.received);
    expect(screen.getByTestId('request-status-chip')).not.toHaveTextContent(UNCOLLECTED_WORD);
  });
});

describe('행의 접근성 묶음 (#4620)', () => {
  const row = (runStatus: AgentRunProgress[], startsGroup: boolean, chip = true) =>
    render(
      <MessageRow
        message={request()}
        startsGroup={startsGroup}
        directory={DIRECTORY}
        chips={[]}
        nowMs={Date.now()}
        runStatus={runStatus}
        requestChip={
          chip
            ? {kind: 'working', word: '작업 중', mark: 'dot', tone: 'working', label: '달무리봇이 작업 중이에요.', runIds: ['run-1']}
            : undefined
        }
        actions={{myMemberId: SELF} as unknown as MessageRowActions}
      />,
    );
  const grouped = () => screen.getByTestId('message-row').props.accessible;

  it('칩이 서는 머리 행은 한 덩이로 합치지 않는다 — 칩이 따로 보조기술의 원소여야 한다', () => {
    row([queuedRun(1_000, {status: 'running', phase: 'running'})], true);
    expect(grouped()).toBe(false);
  });

  it('이어지는 행은 칩이 그려지지 않으니 칩만으로는 합침을 풀지 않는다 — 아무 단추도 없는 행이 쪼개지지 않는다', () => {
    row([queuedRun(1_000, {status: 'running', phase: 'running'})], false);
    expect(grouped()).toBe(true);
  });

  it('이어지는 행이라도 예외 줄이 설 수 있으면(대기·실패·시간 초과·취소) 합치지 않는다 — 줄 안의 설정·취소 단추가 보조기술에서 사라지지 않게', () => {
    for (const extra of [
      {status: 'queued', phase: 'queued'},
      {status: 'failed', phase: 'failed'},
      {status: 'timed_out', phase: 'timed_out'},
      {status: 'cancelled', phase: 'cancelled'},
    ] as Partial<AgentRunProgress>[]) {
      const view = row([queuedRun(1_000, extra)], false);
      expect(grouped()).toBe(false);
      view.unmount();
    }
  });
});

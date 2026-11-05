// 트리거 메시지의 상태 칩 — 에이전트 작업 표시 v2의 폰 판 (#4620 B). 낱말·표지·급한 순서는 코어 `triggerChip`이 정하고
// (`packages/momo-core/.../triggerChip.test.ts`가 붙든다), 여기서는 폰이 그 칩을 **어떻게 세우는가**를 붙든다:
// 어떤 낱말이 서도 같은 크기, 머리 줄이 이미 있는 행에만 서고 줄바꿈이 없다, 성공으로 끝나면 칩이 없고(#5382) 칩 자리가 비어도
// 머리 줄의 모양이 그대로다.

import {
  TRIGGER_CHIP_FACES,
  triggerChip,
  type TriggerChip,
} from '@momo/core/features/agents/triggerChip';
import type {AgentRunProgress, Message, RosterMember, ThreadRollup} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Dimensions, StyleSheet} from 'react-native';

import {RequestStatusChip} from '../src/features/agents/RequestStatusChip';
import {BAR_CONTROL_MAX_SCALE} from '../src/design/atoms';
import {font, line, space} from '../src/design/tokens';
import {MessageRow, type MessageRowActions} from '../src/features/conversation/MessageRow';
import {drainRender} from './testkit';

const NOW = 1_760_000_000_000;
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

const run = (extra: Partial<AgentRunProgress> = {}): AgentRunProgress =>
  ({
    id: 'run-1',
    channelId: 'ch',
    agentMemberId: BOT,
    triggerMessageId: MSG,
    status: 'running',
    phase: 'running',
    leaseState: 'live',
    stepCount: 1,
    ahead: [],
    createdAtMs: NOW - 30_000,
    updatedAtMs: NOW - 1_000,
    ...extra,
  }) as unknown as AgentRunProgress;

const nameFor = () => ({name: '달무리봇'});
const chipOf = (extra: Partial<AgentRunProgress>): TriggerChip => {
  const chip = triggerChip([run(extra)], nameFor, NOW);
  if (chip === null) throw new Error('chip');
  return chip;
};

const message = (): Message =>
  ({
    id: MSG,
    channelId: 'ch',
    seq: 4,
    hlcTs: 4,
    hlcCount: 0,
    authorMemberId: SELF,
    type: 'text',
    body: '이번 주 일정 정리해 줘',
    state: 'sent',
    createdAtMs: NOW - 60_000,
  }) as Message;

afterEach(async () => {
  await drainRender();
  cleanup();
});

// 시각 글자는 보조기술에 숨겨져(행 라벨이 이미 말한다) 기본 질의에 잡히지 않는다.
const HIDDEN = {includeHiddenElements: true} as const;

const box = (testID = 'request-status-chip') =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style) as {width: number; height: number};

describe('칩의 크기는 고정이다 (#4620 B)', () => {
  it('받음 · 가져감 · 작업 중 · 승인 · 아직 받지 않았어요 · 시간 초과 · 실패 — 어떤 낱말이 서도 상자 폭·높이가 같다', () => {
    const phases: [string, Partial<AgentRunProgress>][] = [
      ['received', {status: 'queued', phase: 'queued', leaseState: 'none', createdAtMs: NOW - 1_000}],
      ['claimed', {status: 'running', phase: 'claimed'}],
      ['working', {}],
      ['approval', {status: 'awaiting_approval', phase: 'awaiting_approval'}],
      ['uncollected', {status: 'queued', phase: 'queued', leaseState: 'none', createdAtMs: NOW - 10 * 60_000}],
      ['timed_out', {status: 'timed_out', phase: 'timed_out', endReason: 'lease_abandoned'}],
      ['failed', {status: 'failed', phase: 'failed'}],
    ];
    const first = render(<RequestStatusChip chip={chipOf(phases[0]![1])} />);
    const reference = box();
    const seen = new Set<string>([phases[0]![0]]);
    for (const [kind, extra] of phases.slice(1)) {
      const chip = chipOf(extra);
      first.rerender(<RequestStatusChip chip={chip} />);
      expect(chip.kind).toBe(kind);
      seen.add(chip.kind);
      expect(box()).toEqual(reference);
    }
    expect(seen.size).toBe(phases.length);
    // 폭은 코어가 말하는 **가장 긴 낱말**에서 온다(리터럴이 아니다): 낱말이 길어지면 상자가 따라간다.
    const longest = Math.max(...TRIGGER_CHIP_FACES.map(face => face.word.length));
    const scale = Math.min(Dimensions.get('window').fontScale, BAR_CONTROL_MAX_SCALE);
    expect(reference.width).toBe(font.meta * scale * longest + line.meta + space.sm);
    expect(reference.height).toBe(line.meta * scale);
  });
});

describe('성공으로 끝나면 칩이 없다 (#5382)', () => {
  const mount = (runs: AgentRunProgress[], chip: TriggerChip | null, startsGroup = true) =>
    render(
      <MessageRow
        message={message()}
        startsGroup={startsGroup}
        directory={DIRECTORY}
        chips={[]}
        nowMs={NOW}
        requestChip={chip}
        runStatus={runs}
        actions={{myMemberId: SELF, onOpenThread: jest.fn()} as unknown as MessageRowActions}
      />,
    );
  const succeeded = () => run({status: 'succeeded', phase: 'succeeded'});
  const failed = () => run({id: 'run-2', status: 'failed', phase: 'failed'});
  /** 시각에서 올라가며 처음 만나는 「줄바꿈을 정하는」 상자 = 머리 줄의 모양. */
  const headShape = () => {
    let node: ReturnType<typeof screen.getByTestId> | null = screen.getByTestId('row-time', HIDDEN).parent;
    while (node !== null) {
      const style = StyleSheet.flatten(node.props.style) as {flexWrap?: string; alignItems?: string} | undefined;
      if (style?.flexWrap !== undefined) return {flexWrap: style.flexWrap, alignItems: style.alignItems};
      node = node.parent;
    }
    throw new Error('머리 줄을 찾지 못했다');
  };
  const nameShrinks = () =>
    (StyleSheet.flatten(screen.getByText('이도현').props.style) as {flexShrink?: number}).flexShrink === 1;

  it('모든 run이 성공이면 코어가 칩을 주지 않고, 행에도 칩이 서지 않는다', () => {
    expect(triggerChip([succeeded()], nameFor, NOW)).toBeNull();
    mount([succeeded()], triggerChip([succeeded()], nameFor, NOW));
    expect(screen.queryByTestId('request-status-chip')).toBeNull();
    expect(screen.getByTestId('row-time', HIDDEN)).toBeTruthy();
  });

  it('성공한 run 곁에 다른 상태의 run이 하나라도 있으면 그 상태의 칩이 선다', () => {
    const chip = triggerChip([succeeded(), failed()], nameFor, NOW);
    expect(chip?.kind).toBe('failed');
    mount([succeeded(), failed()], chip);
    expect(screen.getByTestId('request-status-chip')).toHaveTextContent('실패');
  });

  it('칩 자리가 비어도 머리 줄은 칩이 있을 때와 같은 모양이다: 줄바꿈 없음·가운데 정렬·이름만 줄어듦', () => {
    const view = mount([run()], chipOf({}));
    expect(screen.getByTestId('request-status-chip')).toBeTruthy();
    const withChip = headShape();
    const shrinksWithChip = nameShrinks();
    expect(withChip).toEqual({flexWrap: 'nowrap', alignItems: 'center'});
    expect(shrinksWithChip).toBe(true);
    view.unmount();

    // 같은 메시지가 성공으로 끝났다: 칩만 사라지고 머리 줄은 그대로다(줄이 다시 흐르면 높이가 바뀐다).
    const done = mount([succeeded()], triggerChip([succeeded()], nameFor, NOW));
    expect(screen.queryByTestId('request-status-chip')).toBeNull();
    expect(headShape()).toEqual(withChip);
    expect(nameShrinks()).toBe(true);
    done.unmount();

    // 대조: run을 부르지 않은 메시지의 머리 줄은 여전히 줄바꿈이 있는 줄이다(칩이 없다는 이유만으로 모양이 바뀌지 않는다는 뜻이 아니다).
    mount([], null);
    expect(headShape().flexWrap).toBe('wrap');
    expect(nameShrinks()).toBe(false);
  });

  it('이어지는 행에는 성공 뒤에도 칩도 머리 줄도 서지 않는다', () => {
    mount([succeeded()], triggerChip([succeeded()], nameFor, NOW), false);
    expect(screen.queryByTestId('request-status-chip')).toBeNull();
    expect(screen.queryByTestId('row-time', HIDDEN)).toBeNull();
  });
});

describe('칩이 서는 머리 줄 (#4620 B)', () => {
  it('머리 줄이 이미 있는 행에만 서고 줄바꿈이 없다 — 이어지는 행에는 칩 때문에 머리 줄을 새로 세우지 않는다', () => {
    const chip = chipOf({});
    const view = render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={NOW}
        requestChip={chip}
        runStatus={[]}
        actions={{myMemberId: SELF} as unknown as MessageRowActions}
      />,
    );
    // 칩에서 올라가며 처음 만나는 「줄바꿈을 정하는」 상자가 머리 줄이다.
    let head: ReturnType<typeof screen.getByTestId> | null = screen.getByTestId('request-status-chip').parent;
    let wrap: string | undefined;
    while (head !== null && wrap === undefined) {
      wrap = (StyleSheet.flatten(head.props.style) as {flexWrap?: string} | undefined)?.flexWrap;
      head = head.parent;
    }
    expect(wrap).toBe('nowrap');
    view.unmount();
    render(
      <MessageRow
        message={message()}
        startsGroup={false}
        directory={DIRECTORY}
        chips={[]}
        nowMs={NOW}
        requestChip={chip}
        runStatus={[]}
        actions={{myMemberId: SELF} as unknown as MessageRowActions}
      />,
    );
    expect(screen.queryByTestId('request-status-chip')).toBeNull();
  });
});

describe('스레드 요약 줄의 「작업 중」 칩 (#4620 E)', () => {
  const rollup = {replyCount: 3, lastReplySeq: 9, lastReplyAtMs: NOW - 5_000, participantIds: [BOT]} as ThreadRollup;
  const mount = (chip: TriggerChip | null, extra: Partial<React.ComponentProps<typeof MessageRow>> = {}) =>
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={NOW}
        rollup={rollup}
        requestChip={chip}
        runStatus={[]}
        actions={{myMemberId: SELF, onOpenThread: jest.fn()} as unknown as MessageRowActions}
        {...extra}
      />,
    );

  it('일이 진행 중(가져감·작업 중)이면 「답글 N개」 줄 끝에 같은 칩이 서고, 높이는 고정이며 폭은 예약하지 않는다', () => {
    const view = mount(chipOf({}));
    expect(screen.getByTestId('thread-count')).toHaveTextContent(/답글 3개/);
    const chip = screen.getByTestId('thread-work-chip');
    const style = StyleSheet.flatten(chip.props.style) as {width?: number; height: number};
    expect(style.height).toBe(line.meta * Math.min(Dimensions.get('window').fontScale, BAR_CONTROL_MAX_SCALE));
    expect(style.width).toBeUndefined();
    // 누르는 것이 아니다(요약 줄 전체가 스레드로 가는 문이다).
    expect(chip.props.accessibilityRole).not.toBe('button');
    view.unmount();
    mount(chipOf({status: 'running', phase: 'claimed'}));
    expect(screen.getByTestId('thread-work-chip')).toBeTruthy();
  });

  it('끝난 일(성공·실패)과 아직 안 가져간 일에는 서지 않는다 — 성공은 칩이 없고, 나머지는 머리 줄의 칩과 예외 줄이 말한다', () => {
    for (const extra of [
      {status: 'succeeded', phase: 'succeeded'},
      {status: 'failed', phase: 'failed'},
      {status: 'queued', phase: 'queued', leaseState: 'none', createdAtMs: NOW - 1_000},
    ] as Partial<AgentRunProgress>[]) {
      const view = mount(triggerChip([run(extra)], nameFor, NOW));
      expect(screen.queryByTestId('thread-work-chip')).toBeNull();
      view.unmount();
    }
  });
});

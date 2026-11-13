import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import {TypingLiveBar} from '../src/features/conversation/TypingLiveBar';
import {markTyping, resetTyping} from '../src/features/conversation/typingSignals';

// 「작성 중」 줄의 만료 시계 (#5756): 치는 사람이 있을 때만 1초, 만료 뒤 1초 안에 줄이 내려간다.

const WS = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const SELF = '11111111-1111-4111-8111-111111111111';
const HUMAN = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const NOW = 1_785_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
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
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: HUMAN, displayName: '김도현', handle: 'dohyun'}),
]);

function sendFrame(): void {
  markTyping({
    type: 'ephemeral.typing',
    v: 1,
    ts: Date.now(),
    payload: {workspace_id: WS, channel_id: CH, member_id: HUMAN, expires_at: Date.now() + 6_000},
  } as Parameters<typeof markTyping>[0]);
}

/** 1초 간격 인터벌이 지금 살아 있는 수 — 다른 타이머(애니메이션 등)는 세지 않는다. */
function liveTicks(spies: {set: jest.SpyInstance; clear: jest.SpyInstance}): number {
  const started = spies.set.mock.results.filter((_r, i) => spies.set.mock.calls[i][1] === 1_000);
  const ids = started.map(r => r.value);
  const cleared = spies.clear.mock.calls.map(c => c[0]);
  return ids.filter(id => !cleared.includes(id)).length;
}

function lineSays(): boolean {
  return screen.queryByLabelText(/김도현/) !== null;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  resetTyping();
});
afterEach(() => {
  cleanup();
  resetTyping();
  jest.useRealTimers();
});

describe('작성 중 시계 (#5756)', () => {
  let spies: {set: jest.SpyInstance; clear: jest.SpyInstance};
  beforeEach(() => {
    spies = {set: jest.spyOn(global, 'setInterval'), clear: jest.spyOn(global, 'clearInterval')};
  });
  afterEach(() => {
    spies.set.mockRestore();
    spies.clear.mockRestore();
  });

  it('치는 사람이 없으면 1초 타이머가 걸려 있지 않다', () => {
    render(<TypingLiveBar channelId={CH} myMemberId={SELF} directory={DIRECTORY} />);
    expect(liveTicks(spies)).toBe(0);
    act(() => jest.advanceTimersByTime(60_000));
    expect(liveTicks(spies)).toBe(0);
  });

  it('신호가 멈추면 만료(6초) + 1초 안에 줄이 내려가고 타이머도 풀린다', () => {
    render(<TypingLiveBar channelId={CH} myMemberId={SELF} directory={DIRECTORY} />);
    act(() => sendFrame());
    expect(lineSays()).toBe(true);
    expect(liveTicks(spies)).toBe(1);

    act(() => jest.advanceTimersByTime(5_000));
    expect(lineSays()).toBe(true);

    act(() => jest.advanceTimersByTime(2_000));
    expect(lineSays()).toBe(false);
    expect(liveTicks(spies)).toBe(0);
  });

  it('1초 시계는 줄만 다시 그린다 — 감싼 부모(대화 화면)는 다시 그려지지 않는다', () => {
    let parentRenders = 0;
    function Parent(): React.JSX.Element {
      parentRenders += 1;
      return <TypingLiveBar channelId={CH} myMemberId={SELF} directory={DIRECTORY} />;
    }
    render(<Parent />);
    act(() => sendFrame());
    const before = parentRenders;
    act(() => jest.advanceTimersByTime(5_000));
    expect(lineSays()).toBe(true);
    expect(parentRenders).toBe(before);
  });
});

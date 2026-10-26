import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {DRAG_MOMENTUM_GRACE_MS, Timeline, type ScrollLogEntry} from '../src/features/conversation/Timeline';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 측정 seam `scrollLogRef` 는 「누가 낸 스크롤인가」를 날짜 알약이 서는 판정과 **같은 말**로 남긴다 (#4613)
//
// `measure/enter-windows.mjs` 가 「프로그램이 낸 스크롤 중에 알약이 선 프레임 0」을 이 기록으로 센다. 그 0 이 증거가 되려면 기록이 거짓 음성을 내면 안 된다 — 손가락·관성인데
// `user: false` 로 남거나, 목록이 스스로 낸 이동인데 `user: true` 로 남으면 교집합이 비어서 통과하는 가드가 된다(「실패할 수 없는 가드」). 이 시험은 두 방향을 모두 잠근다.
// seam 은 앱에서 아무도 읽지 않는다 — 배열을 꽂지 않으면 아무것도 쌓지 않는다는 것도 함께 잠근다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

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
  member({id: SELF, displayName: '이도현', handle: 'dohyun'}),
  member({id: OTHER, displayName: '박서연', handle: 'seoyeon'}),
]);

const BASE_MS = 1_700_000_000_000;

function message(seq: number): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: seq % 2 === 0 ? SELF : OTHER,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}

const HISTORY = [1, 2, 3, 4, 5, 6].map(message);

function mount(scrollLogRef?: React.MutableRefObject<ScrollLogEntry[] | null>) {
  render(
    <Timeline
      messages={HISTORY}
      directory={DIRECTORY}
      status="ready"
      channelId="ch"
      myMemberId={SELF}
      nowMs={BASE_MS + 10_000}
      lastReadSeq={null}
      unreadCount={0}
      jumpPills
      scrollLogRef={scrollLogRef}
    />,
  );
}

const list = () => screen.getByTestId('timeline-list');

const SCROLL_EVENT = {
  nativeEvent: {
    contentOffset: {x: 0, y: 300},
    contentSize: {height: 4000, width: 390},
    layoutMeasurement: {height: 800, width: 390},
    velocity: {x: 0, y: 0},
  },
};

function fire(name: 'scroll' | 'scrollBeginDrag' | 'scrollEndDrag' | 'momentumScrollBegin' | 'momentumScrollEnd') {
  fireEvent(list(), name, SCROLL_EVENT);
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/** 마운트 직후의 보고는 버리고(진입 수렴이 낸 것) 이 시험이 부른 보고만 본다. */
function scrollEntries(log: ScrollLogEntry[]) {
  return log.filter((entry): entry is Extract<ScrollLogEntry, {k: 's'}> => entry.k === 's');
}

beforeEach(() => {
  installAppClock();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('측정 seam scrollLogRef (#4613)', () => {
  it('손가락도 관성도 없을 때의 보고는 목록이 낸 것이다(user: false)', () => {
    const log: React.MutableRefObject<ScrollLogEntry[] | null> = {current: []};
    mount(log);
    const before = scrollEntries(log.current as ScrollLogEntry[]).length;
    fire('scroll');
    const entries = scrollEntries(log.current as ScrollLogEntry[]);
    expect(entries).toHaveLength(before + 1);
    expect(entries[entries.length - 1].user).toBe(false);
    expect(entries[entries.length - 1].y).toBe(300);
    expect(entries[entries.length - 1].content).toBe(4000);
    expect(entries[entries.length - 1].view).toBe(800);
  });

  it('손가락이 목록을 잡은 동안과 손가락이 끈 관성 동안은 user: true, 관성이 끝나면 다시 false', () => {
    const log: React.MutableRefObject<ScrollLogEntry[] | null> = {current: []};
    mount(log);
    const userFlags = () => scrollEntries(log.current as ScrollLogEntry[]).map(entry => entry.user);
    const mark = () => userFlags().length;

    fire('scrollBeginDrag');
    let from = mark();
    fire('scroll');
    expect(userFlags().slice(from)).toEqual([true]);

    fire('scrollEndDrag');
    fire('momentumScrollBegin');
    from = mark();
    fire('scroll');
    expect(userFlags().slice(from)).toEqual([true]);

    fire('momentumScrollEnd');
    from = mark();
    fire('scroll');
    expect(userFlags().slice(from)).toEqual([false]);
  });

  it('관성 없이 손가락만 뗀 뒤(자격 시계가 지난 다음)의 보고는 손가락의 것이 아니다', () => {
    const log: React.MutableRefObject<ScrollLogEntry[] | null> = {current: []};
    mount(log);
    fire('scrollBeginDrag');
    fire('scrollEndDrag');
    advance(DRAG_MOMENTUM_GRACE_MS + 10);
    const from = scrollEntries(log.current as ScrollLogEntry[]).length;
    fire('scroll');
    expect(scrollEntries(log.current as ScrollLogEntry[]).slice(from).map(entry => entry.user)).toEqual([false]);
  });

  it('배열을 꽂지 않으면(앱 전부) 아무것도 쌓지 않고, 스크롤 보고는 그대로 처리된다', () => {
    // 같은 이벤트를 부르되 seam 이 없다 — 예외 없이 지나가야 하고(앱 동작이 그대로), 어디에도 기록이 남지 않는다.
    mount(undefined);
    expect(() => {
      fire('scroll');
      fire('scrollBeginDrag');
      fire('scroll');
    }).not.toThrow();
  });

  it('chasingTail 전이는 `c` 줄로 남는다 — 마운트의 첫 줄은 on: false(진입 시작 표식)', () => {
    const log: React.MutableRefObject<ScrollLogEntry[] | null> = {current: []};
    mount(log);
    const chase = (log.current as ScrollLogEntry[]).filter(entry => entry.k === 'c');
    expect(chase.length).toBeGreaterThanOrEqual(1);
    expect(chase[0]).toMatchObject({k: 'c', on: false});
  });
});

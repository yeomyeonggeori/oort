import type {Message, RosterMember} from '@momo/core/lib/api';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';

import {Timeline, type PillState} from '../src/features/conversation/Timeline';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 위쪽 떠 있는 필은 연결 띠 밑에 쌓인다 (#4292).
//
// 대화 머리의 연결 띠는 목록 위에 **뜬다** — 흐름에 끼면 띠가 설 때마다 목록의 보이는 높이가 바뀌기 때문이다.
// 그런데 목록 위 가운데는 목록의 위쪽 필(「안 읽은 곳으로」·떠 있는 날짜)이 이미 쓰는 자리다. 둘이 같은 자리에 뜨면
// 필이 띠 **뒤에 숨은 채** 눌리는 컨트롤이 된다. 그래서 띠의 실제 높이가 `topPillInset` 으로 건너와 필 틀이 그만큼 내려간다.
//
// 이 시험은 `Timeline` 쪽 절반만 잰다: 틀이 `topPillInset` 을 따르고, 필이 그 틀 **안**에 서고, 틀이 손을 받지 않는다.
// 머리 → 화면 → `Timeline` 으로 값이 건너가는 배선은 `conversationSteady.test.tsx` 마지막 묶음이 잰다.
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
    authorMemberId: OTHER,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}

const HISTORY = [1, 2, 3, 4, 5, 6, 7, 8].map(message);

let pills: React.MutableRefObject<PillState | null> = {current: null};

function element(topPillInset: number | undefined) {
  return (
    <Timeline
      messages={HISTORY}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS}
      lastReadSeq={3}
      unreadCount={5}
      jumpPills
      topPillInset={topPillInset}
      pillsRef={pills}
    />
  );
}

const flat = (style: unknown): Record<string, unknown> =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;

const list = () => screen.getByTestId('timeline-list');
const topFrame = () => screen.getByTestId('timeline-top-pills');

async function sleep(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** 진입이 앉을 때까지 — 구분선 판정은 목록이 바닥에 앉았다고 보고한 뒤에야 선다. */
async function settleAtBottom() {
  fireEvent(list(), 'contentSizeChange', 390, 4000);
  fireEvent.scroll(list(), {
    nativeEvent: {
      contentOffset: {y: 3200},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
  await sleep(0);
  for (let waited = 0; waited < 2000 && pills.current?.settled !== true; waited += 20) {
    await sleep(20);
  }
  expect(pills.current?.settled).toBe(true);
}

/** 구분선이 창 **위쪽 밖**이라고 보고한다 — 위 필이 서는 조건. */
function reportDividerAbove() {
  const data = list().props.data as TimelineStreamItem[];
  const at = data.findIndex(item => item.kind === 'unread');
  expect(at).toBeGreaterThanOrEqual(0);
  const viewableItems = data.slice(at + 2).map((item, offset) => ({
    item,
    key: item.key,
    index: at + 2 + offset,
    isViewable: true,
  }));
  act(() => {
    list().props.onViewableItemsChanged({viewableItems, changed: viewableItems});
  });
}

beforeEach(() => {
  installAppClock();
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
  pills = {current: null};
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('위쪽 필 틀 (#4292)', () => {
  it('틀은 topPillInset 만큼 내려가고, 위 필은 그 틀 안에 서며, 틀 자신은 손을 받지 않는다', async () => {
    const view = render(element(undefined));
    await settleAtBottom();
    reportDividerAbove();

    // 띠가 없으면(값을 안 주면) 필은 목록 위 가장자리에 선다.
    expect(screen.getByTestId('jump-unread')).toBeTruthy();
    expect(within(topFrame()).getByTestId('jump-unread')).toBeTruthy();
    expect(flat(topFrame().props.style)).toMatchObject({position: 'absolute', top: 0});
    expect(topFrame().props.pointerEvents).toBe('box-none');

    // 띠가 서서 36.7pt 를 가렸다 — 틀이 그만큼 내려가고, 필은 여전히 그 틀 안에 있다.
    view.rerender(element(36.7));
    expect(flat(topFrame().props.style).top).toBe(36.7);
    expect(within(topFrame()).getByTestId('jump-unread')).toBeTruthy();

    // 띠가 걷히면 제자리다.
    view.rerender(element(0));
    expect(flat(topFrame().props.style).top).toBe(0);
  });
});

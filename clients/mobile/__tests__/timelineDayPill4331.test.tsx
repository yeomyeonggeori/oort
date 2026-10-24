import type {Message, RosterMember} from '@momo/core/lib/api';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import type {FlatList} from 'react-native';

import {
  DAY_PILL_LINGER_MS,
  DRAG_MOMENTUM_GRACE_MS,
  Timeline,
  type PillState,
} from '../src/features/conversation/Timeline';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 떠 있는 날짜 알약은 **손가락이 끈 스크롤**에만 선다 (#4331)
//
// 실기(3053)의 말: 「채팅을 치면 진동하면서 위에 날짜가 뜨고 안뜨고 하면서 채팅이 이동해」. 알약을 세우는 신호는 둘뿐이다 —
// `onScrollBeginDrag`(손가락)와 `onMomentumScrollBegin`(UIKit 이 감속을 시작할 때마다). 뒤의 것은 이 목록이 스스로 낸 이동이 낳은
// 감속에도 온다(입력창이 자라고 줄어 창이 변할 때의 바닥 맞춤 · 새 줄을 따라가는 활강). 그래서 관성은 **직전에 손가락이 끈 것일 때만**
// 알약을 세운다.
//
// 제스트에는 UIKit 이 없다. 그래서 두 이벤트를 손으로 부르고, 알약이 서 있는지는 배송되는 `Timeline` 의 측정 seam(`PillState.day`)과
// 화면의 `floating-day` 노드 **둘 다**로 읽는다(둘이 어긋나면 seam 이 화면과 다른 말을 하는 것이다).
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

const DAY_MS = 86_400_000;
const BASE_MS = 1_700_000_000_000;

/** 사흘에 걸친 8줄 — 날짜 구분선이 여럿 서므로 창 맨 위 행의 날이 알약에 실린다. */
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
    createdAtMs: BASE_MS + Math.floor((seq - 1) / 3) * DAY_MS + seq * 1000,
  };
}

const HISTORY = [1, 2, 3, 4, 5, 6, 7, 8].map(message);

type ListRef = React.MutableRefObject<FlatList<TimelineStreamItem> | null>;

let pills: React.MutableRefObject<PillState | null> = {current: null};

function mount() {
  pills = {current: null};
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as ListRef;
  render(
    <Timeline
      messages={HISTORY}
      directory={DIRECTORY}
      status="ready"
      channelId="ch"
      myMemberId={SELF}
      nowMs={BASE_MS + 3 * DAY_MS}
      lastReadSeq={null}
      unreadCount={0}
      jumpPills
      listRef={listRef}
      pillsRef={pills}
    />,
  );
}

function list() {
  return screen.getByTestId('timeline-list');
}

interface Item {
  key: string;
  kind: string;
}

/** 첫 메시지 행 **다음**부터 끝까지가 보인다고 보고한다 — 첫 날의 구분선이 창 위쪽 밖이라 그 날이 알약에 실린다. */
function reportScrolledPastFirstDay() {
  const data = list().props.data as Item[];
  const first = data.findIndex(item => item.kind === 'message');
  const viewableItems = data.slice(first + 1).map((item, offset) => ({
    item,
    key: item.key,
    index: first + 1 + offset,
    isViewable: true,
  }));
  act(() => {
    list().props.onViewableItemsChanged({viewableItems, changed: viewableItems});
  });
}

function pillOnScreen(): boolean {
  return screen.queryByTestId('floating-day', {includeHiddenElements: true}) !== null;
}

/** seam 과 화면이 같은 말을 해야 한다. */
function pillStands(): boolean {
  const seam = pills.current?.day === true;
  expect(pillOnScreen()).toBe(seam);
  return seam;
}

/** `VirtualizedList` 의 스크롤 핸들러들은 `nativeEvent` 를 읽는다 — 목록이 낼 법한 값 한 벌. */
const SCROLL_EVENT = {
  nativeEvent: {
    contentOffset: {x: 0, y: 3000},
    contentSize: {height: 4000, width: 390},
    layoutMeasurement: {height: 800, width: 390},
    velocity: {x: 0, y: 0},
  },
};

function fire(name: 'scrollBeginDrag' | 'scrollEndDrag' | 'momentumScrollBegin' | 'momentumScrollEnd') {
  fireEvent(list(), name, SCROLL_EVENT);
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  installAppClock();
  mount();
  reportScrolledPastFirstDay();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('날짜 알약은 손가락이 끈 스크롤에만 선다 (#4331)', () => {
  it('손가락 없이 온 감속(입력창 높이 변화·활강이 낳은)에는 서지 않는다', () => {
    expect(pillStands()).toBe(false);
    fire('momentumScrollBegin');
    expect(pillStands()).toBe(false);
    fire('momentumScrollEnd');
    advance(DAY_PILL_LINGER_MS + 10);
    expect(pillStands()).toBe(false);
  });

  it('손가락이 잡으면 서고, 이어진 관성 동안 서 있고, 멈춘 뒤 잠깐 머물다 물러난다', () => {
    fire('scrollBeginDrag');
    expect(pillStands()).toBe(true);
    fire('scrollEndDrag');
    fire('momentumScrollBegin');
    // 관성이 도는 동안은 물러나는 시계가 멈춰 있다.
    advance(DAY_PILL_LINGER_MS + DRAG_MOMENTUM_GRACE_MS + 500);
    expect(pillStands()).toBe(true);
    fire('momentumScrollEnd');
    advance(DAY_PILL_LINGER_MS - 10);
    expect(pillStands()).toBe(true);
    advance(20);
    expect(pillStands()).toBe(false);
  });

  it('관성 없이 손가락만 뗀 뒤에 오는 감속은 손가락의 것이 아니다', () => {
    fire('scrollBeginDrag');
    fire('scrollEndDrag');
    // 관성이 안 왔다: 자격 시계가 지나면 알약도 물러난다.
    advance(DRAG_MOMENTUM_GRACE_MS + DAY_PILL_LINGER_MS + 10);
    expect(pillStands()).toBe(false);
    // 그 뒤에 이 목록이 스스로 낸 이동의 감속이 온다.
    fire('momentumScrollBegin');
    expect(pillStands()).toBe(false);
  });

  it('관성이 끝나면 자격도 끝난다 — 다음 손가락 없는 감속에는 서지 않는다', () => {
    fire('scrollBeginDrag');
    fire('scrollEndDrag');
    fire('momentumScrollBegin');
    fire('momentumScrollEnd');
    advance(DAY_PILL_LINGER_MS + 10);
    expect(pillStands()).toBe(false);
    fire('momentumScrollBegin');
    expect(pillStands()).toBe(false);
  });

  it('손가락이 다시 잡으면 다시 선다(앞선 관성이 끝나기 전이어도)', () => {
    fire('scrollBeginDrag');
    fire('scrollEndDrag');
    fire('momentumScrollBegin');
    fire('scrollBeginDrag');
    expect(pillStands()).toBe(true);
    fire('scrollEndDrag');
    fire('momentumScrollBegin');
    fire('momentumScrollEnd');
    advance(DAY_PILL_LINGER_MS + 10);
    expect(pillStands()).toBe(false);
  });
});

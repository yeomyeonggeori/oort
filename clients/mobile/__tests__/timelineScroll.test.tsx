// timelineScroll — 스크롤이 만드는 표시 (Timeline)
// 합친 원본: timelineDayPill4331.test.tsx, timelineScrollLog4613.test.tsx
// 이슈 번호는 아래 묶음 `describe` 이름과 주석에 남아 있다.

import type {Message} from '@momo/core/lib/api';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import React from 'react';
import type {FlatList} from 'react-native';

import {
  DAY_PILL_LINGER_MS,
  DRAG_MOMENTUM_GRACE_MS,
  type PillState,
  type ScrollLogEntry,
  Timeline,
} from '../src/features/conversation/Timeline';
import {installAppClock} from './fixtures/fakeClock';
import {drainRender, member} from './testkit';

// ---- 아래 묶음들이 함께 쓰는 고정값·도구 (원래 파일마다 글자 그대로 같게 선언돼 있던 것)
const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '이도현', handle: 'dohyun'}),
  member({id: OTHER, displayName: '박서연', handle: 'seoyeon'}),
]);
const BASE_MS = 1_700_000_000_000;

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

// =============================================================================
// 합친 시험: 원래 timelineDayPill4331.test.tsx (#4331)
// =============================================================================
describe('timelineDayPill (#4331)', () => {
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

  const DAY_MS = 86_400_000;

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

  beforeEach(() => {
    installAppClock();
    mount();
    reportScrolledPastFirstDay();
  });

  afterEach(async () => {
    await drainRender();
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
});

// =============================================================================
// 합친 시험: 원래 timelineScrollLog4613.test.tsx (#4613)
// =============================================================================
describe('timelineScrollLog (#4613)', () => {
  // =============================================================================
  // 측정 seam `scrollLogRef` 는 「누가 낸 스크롤인가」를 날짜 알약이 서는 판정과 **같은 말**로 남긴다 (#4613)
  //
  // `measure/enter-windows.mjs` 가 「프로그램이 낸 스크롤 중에 알약이 선 프레임 0」을 이 기록으로 센다. 그 0 이 증거가 되려면 기록이 거짓 음성을 내면 안 된다 — 손가락·관성인데
  // `user: false` 로 남거나, 목록이 스스로 낸 이동인데 `user: true` 로 남으면 교집합이 비어서 통과하는 가드가 된다(「실패할 수 없는 가드」). 이 시험은 두 방향을 모두 잠근다.
  // seam 은 앱에서 아무도 읽지 않는다 — 배열을 꽂지 않으면 아무것도 쌓지 않는다는 것도 함께 잠근다.
  // =============================================================================

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

  /** 마운트 직후의 보고는 버리고(진입 수렴이 낸 것) 이 시험이 부른 보고만 본다. */
  function scrollEntries(log: ScrollLogEntry[]) {
    return log.filter((entry): entry is Extract<ScrollLogEntry, {k: 's'}> => entry.k === 's');
  }

  beforeEach(() => {
    installAppClock();
  });

  afterEach(async () => {
    await drainRender();
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
});

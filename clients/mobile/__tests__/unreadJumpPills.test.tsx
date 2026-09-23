import type {Message, RosterMember} from '@momo/core/lib/api';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import {readFileSync} from 'fs';
import {join} from 'path';
import React from 'react';
import {AccessibilityInfo, type FlatList} from 'react-native';

import {Timeline} from '../src/features/conversation/Timeline';
import {
  countNewerThan,
  countUnreadJump,
  dividerRelation,
  jumpLatestAccessibilityLabel,
  jumpLatestSegments,
  jumpUnreadAccessibilityLabel,
  shouldShowJumpUnread,
} from '../src/features/conversation/jumpPills';

// =============================================================================
// 폰 타임라인의 안읽음·최신 점프 필 (#1892 — 웹 UnreadPill 의미론의 RN 이식)
//
// 웹 `Timeline.unreadPill.test.tsx` 가 잠근 규칙을 폰의 배송되는 `Timeline` 에서
// 같은 모양으로 잰다. 웹이 virtuoso 의 `rangeChanged` 와 IntersectionObserver 를
// 손으로 부르듯, 여기서는 `FlatList` 의 두 보고 — `onViewableItemsChanged`(어느 행이
// 보이는가)와 `onScroll`(바닥에서 얼마나 떨어졌는가) — 를 손으로 부른다. 레이아웃이
// 없는 제스트에서 목록은 스스로 보고하지 않고, 그 두 보고가 이 기능의 입력 전부다.
//
// 픽스처는 웹과 같다: 메시지 8개, 커서 3, 안읽음 5 → 구분선은 seq 4 위.
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
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

const BASE_MS = 1_700_000_000_000;

function message(seq: number, authorMemberId = OTHER): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}

const HISTORY = [1, 2, 3, 4, 5, 6, 7, 8].map(seq => message(seq));

type ListRef = React.MutableRefObject<FlatList<TimelineStreamItem> | null>;

interface MountProps {
  messages?: Message[];
  lastReadSeq?: number | null;
  unreadCount?: number;
  jumpPills?: boolean;
  status?: 'loading' | 'ready';
}

function element(listRef: ListRef, over: MountProps = {}) {
  return (
    <Timeline
      messages={over.messages ?? HISTORY}
      directory={DIRECTORY}
      status={over.status ?? 'ready'}
      myMemberId={SELF}
      nowMs={BASE_MS}
      lastReadSeq={over.lastReadSeq === undefined ? 3 : over.lastReadSeq}
      unreadCount={over.unreadCount ?? 5}
      jumpPills={over.jumpPills ?? true}
      listRef={listRef}
    />
  );
}

function mount(over: MountProps = {}) {
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as ListRef;
  const view = render(element(listRef, over));
  const rerender = (next: MountProps) => view.rerender(element(listRef, {...over, ...next}));
  return {view, listRef, rerender};
}

function list() {
  return screen.getByTestId('timeline-list');
}

interface Item {
  key: string;
  kind: string;
  message?: {seq: number};
}

function items(): Item[] {
  return list().props.data as Item[];
}

function dividerIndex(): number {
  const at = items().findIndex(item => item.kind === 'unread');
  if (at < 0) throw new Error('expected an unread divider in the stream');
  return at;
}

/** 목록이 「이 첨자들이 보인다」고 보고한다 — 웹 테스트의 `reportObserved` 자리. */
function reportVisible(from: number, to: number) {
  const data = items();
  const viewableItems = data.slice(from, to + 1).map((item, offset) => ({
    item,
    key: item.key,
    index: from + offset,
    isViewable: true,
  }));
  act(() => {
    list().props.onViewableItemsChanged({viewableItems, changed: viewableItems});
  });
}

/** 구분선이 창 **위쪽 밖**: 구분선 아래 두 행부터 끝까지가 보인다. */
function reportDividerAbove() {
  reportVisible(dividerIndex() + 2, items().length - 1);
}

/** 구분선이 창 **안**. */
function reportDividerIn() {
  reportVisible(dividerIndex() - 1, dividerIndex() + 2);
}

async function flushFrame() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

/**
 * 진입: 목록이 첫 콘텐츠 크기를 알리고 바닥에 앉았다고 보고한다. 진입 수렴이
 * 그것을 보고 도착을 선언하면 — 그때가 이 목록이 「출발점에 앉은」 순간이다.
 * 이것 없이 보고를 부르면 마운트 순간(오프셋 0)의 보고를 흉내 내는 것이 된다.
 */
async function settleAtBottom() {
  fireEvent(list(), 'contentSizeChange', 390, 4000);
  fireEvent.scroll(list(), {
    nativeEvent: {
      contentOffset: {y: 3200},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
  await flushFrame();
}

/** 사람이 위로 올라가 읽는다 — 바닥에서 멀다. */
function scrollUpIntoHistory() {
  fireEvent(list(), 'scrollBeginDrag');
  fireEvent.scroll(list(), {
    nativeEvent: {
      contentOffset: {y: 1200},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
}

/** 목록이 콘텐츠 끝보다 `by`pt 아래에 섰다고 보고한다(창 800 · 콘텐츠 4000). */
function overshoot(by: number) {
  fireEvent.scroll(list(), {
    nativeEvent: {
      contentOffset: {y: 3200 + by},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
}

/** 목록이 정확히 끝에 섰다. */
function atTheEnd() {
  fireEvent.scroll(list(), {
    nativeEvent: {
      contentOffset: {y: 3200},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
}

/** 수렴 한 라운드(50ms)를 실제로 흘려보낸다. */
async function waitRound() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
  });
}

function topPill() {
  return screen.queryByTestId('jump-unread');
}

function bottomPill() {
  return screen.queryByTestId('jump-latest');
}

/** 필 안의 보이는 문장(화살표 글리프 제외). */
function pillSentence(testID: string): string {
  const pill = screen.getByTestId(testID);
  const texts = within(pill).queryAllByText(/보기|이동/);
  const label = texts[texts.length - 1];
  const flatten = (node: unknown): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(flatten).join('');
    const children = (node as {props?: {children?: unknown}})?.props?.children;
    return children === undefined ? '' : flatten(children);
  };
  return flatten(label.props.children);
}

beforeEach(() => {
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

// ---- the arithmetic, as pure functions (same table as the web's navigation.test) ----

describe('필의 산수 (웹 navigation.ts 와 같은 판정)', () => {
  it('아래 N 은 기준선 뒤의 남의 말만 센다 — 내 것은 건너뛰되 꼬리를 끊지 않는다', () => {
    const tail = [
      message(9),
      message(10, SELF),
      message(11),
    ];
    expect(countNewerThan([...HISTORY, ...tail], 8, SELF)).toBe(2);
    expect(countNewerThan([...HISTORY, ...tail], 8)).toBe(3);
    expect(countNewerThan(HISTORY, 8, SELF)).toBe(0);
  });

  it('위 N 은 동결 스냅샷 그대로다 — 음수·없음은 0', () => {
    expect(countUnreadJump(5)).toBe(5);
    expect(countUnreadJump(0)).toBe(0);
    expect(countUnreadJump(null)).toBe(0);
    expect(countUnreadJump(-3)).toBe(0);
  });

  it('구분선의 자리는 보이는 행들로 판정한다', () => {
    expect(dividerRelation(null, [1, 2])).toBe('absent');
    expect(dividerRelation(4, [])).toBeNull();
    expect(dividerRelation(4, [6, 7, 8])).toBe('above');
    expect(dividerRelation(4, [3, 4, 5])).toBe('in');
    expect(dividerRelation(4, [0, 1, 2])).toBe('below');
  });

  it('위 필은 위쪽 밖 · N>0 · 래치 전에만 선다', () => {
    expect(shouldShowJumpUnread('above', 5, false)).toBe(true);
    expect(shouldShowJumpUnread('above', 5, true)).toBe(false);
    expect(shouldShowJumpUnread('in', 5, false)).toBe(false);
    expect(shouldShowJumpUnread('above', 0, false)).toBe(false);
    expect(shouldShowJumpUnread(null, 5, false)).toBe(false);
  });
});

describe('문장은 웹 UnreadPill 과 같은 낱말이다', () => {
  const WEB = readFileSync(
    join(__dirname, '..', '..', 'web', 'src', 'features', 'timeline', 'UnreadPill.tsx'),
    'utf8',
  );

  it('동사로 끝나는 두 문장 — 쌓인 게 있으면 「보기」, 없으면 「이동」', () => {
    expect(jumpLatestSegments(3).map(s => s.text).join('')).toBe('새 메시지 3개 보기');
    expect(jumpLatestSegments(0).map(s => s.text).join('')).toBe('최신 메시지로 이동');
    expect(jumpLatestAccessibilityLabel(3)).toBe('새 메시지 3개 보기');
    expect(jumpLatestAccessibilityLabel(0)).toBe('최신 메시지로 이동');
    expect(jumpUnreadAccessibilityLabel(5)).toBe('위쪽의 새 메시지 5개 보기');
  });

  it('웹 원본에 같은 낱말이 그대로 있다 — 한쪽만 고치면 여기가 빨갛다', () => {
    expect(WEB).toContain('`새 메시지 ${newCount}개 보기`');
    expect(WEB).toContain('"최신 메시지로 이동"');
    expect(WEB).toContain('`위쪽의 새 메시지 ${count}개 보기`');
  });

  it('숫자는 자릿폭을 고정할 조각으로 떨어진다', () => {
    expect(jumpLatestSegments(12)).toEqual([
      {kind: 'prose', text: '새 메시지 '},
      {kind: 'figure', text: '12'},
      {kind: 'prose', text: '개 보기'},
    ]);
  });
});

// ---- the shipping Timeline ---------------------------------------------------

describe('위 필 「안읽음으로」', () => {
  it('구분선이 창 위쪽 밖일 때만 선다 — 동결 N, 동사 라벨, 「위쪽의」 접근명', async () => {
    mount();
    await settleAtBottom();
    expect(topPill()).toBeNull();

    reportDividerAbove();
    const pill = topPill();
    expect(pill).not.toBeNull();
    expect(pill?.props.accessibilityRole).toBe('button');
    expect(pill?.props.accessibilityLabel).toBe('위쪽의 새 메시지 5개 보기');
    expect(pillSentence('jump-unread')).toBe('새 메시지 5개 보기');
  });

  it('구분선이 창에 들어오면 사라지고, 다시 위로 밀려나도 서지 않는다 (래치)', async () => {
    mount();
    await settleAtBottom();
    reportDividerAbove();
    expect(topPill()).not.toBeNull();

    reportDividerIn();
    expect(topPill()).toBeNull();

    reportDividerAbove();
    expect(topPill()).toBeNull();
  });

  it('N 이 움직여도(새 메시지 도착) 래치된 위 필은 다시 서지 않는다 — 위 N 은 동결이다', async () => {
    const {rerender} = mount();
    await settleAtBottom();
    scrollUpIntoHistory();
    reportDividerAbove();
    expect(pillSentence('jump-unread')).toBe('새 메시지 5개 보기');
    expect(pillSentence('jump-latest')).toBe('최신 메시지로 이동');

    // 새 말이 도착한다. 아래 N 은 움직이고, 위 N 은 방을 연 순간의 수 그대로다.
    rerender({messages: [...HISTORY, message(9)]});
    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');
    expect(pillSentence('jump-unread')).toBe('새 메시지 5개 보기');

    // 사람이 구분선을 본다 → 래치.
    reportDividerIn();
    expect(topPill()).toBeNull();

    // 더 도착한다. 아래 N 은 계속 움직이고, 구분선은 다시 위로 밀려난다.
    rerender({messages: [...HISTORY, message(9), message(10), message(11)]});
    reportDividerAbove();
    expect(pillSentence('jump-latest')).toBe('새 메시지 3개 보기');
    // 래치가 없으면 여기서 위 필이 「새 메시지 5개 보기」로 다시 선다.
    expect(topPill()).toBeNull();
  });

  it('마운트 순간(오프셋 0)의 보고로는 래치가 걸리지 않는다 — 진입 스윕', async () => {
    mount();
    // 목록이 아직 맨 위에 서 있을 때의 첫 보고. 구분선이 창 안이라고 말한다.
    reportDividerIn();
    // 진입 수렴이 목록을 바닥으로 데려간다. 그 스크롤마다 목록은 보이는 행을 다시
    // 계산해 보고하므로(`VirtualizedList._onScroll` → `_updateViewableItems`),
    // 수렴이 도착을 선언하기 **전에** 구분선은 이미 위쪽 밖으로 보고돼 있다.
    fireEvent(list(), 'contentSizeChange', 390, 4000);
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 3200},
        contentSize: {height: 4000, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    reportDividerAbove();
    await flushFrame();
    // 사람은 그 경계를 한 번도 본 적이 없다. 첫 보고로 래치가 걸렸다면 여기서
    // 위 필은 이 방문 내내 서지 않는다(웹 design-review H-1 의 폰판).
    expect(topPill()).not.toBeNull();
  });

  it('마운트 직후 짧은 콘텐츠의 스크롤 보고로는 앉지 않는다 — 시뮬레이터에서 위 필이 끝내 안 섰던 길', async () => {
    // 첫 배치만 든 목록은 오프셋 0 에서도 「끝 근처」로 읽힌다(콘텐츠 700 · 창 800).
    // 그 스크롤 보고가 출발점을 선언하면, 바로 뒤의 보이는 행 보고(맨 위 행들 사이의
    // 구분선)가 사람이 본 적 없는 경계로 래치를 건다.
    mount();
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 0},
        contentSize: {height: 700, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    reportDividerIn();
    fireEvent(list(), 'contentSizeChange', 390, 4000);
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 3200},
        contentSize: {height: 4000, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    reportDividerAbove();
    await flushFrame();
    expect(topPill()).not.toBeNull();
  });

  it('짧은 대화에서 앉은 자리에 구분선이 보이면 — 봤다. 위 필은 서지 않는다', async () => {
    mount();
    // 스크롤할 것이 없는 짧은 방: 바닥에 앉은 자리에서 구분선이 창 안이다.
    reportDividerIn();
    await settleAtBottom();
    // 뒤따른 새 메시지가 그 줄을 위로 밀어내도, 사람은 이미 경계를 봤다.
    reportDividerAbove();
    expect(topPill()).toBeNull();
  });

  it('누르면 구분선을 창 맨 위로 데려가고(viewPosition 0), 그 자리에서 래치가 걸린다', async () => {
    const {listRef} = mount();
    await settleAtBottom();
    reportDividerAbove();
    const spy = jest
      .spyOn(listRef.current!, 'scrollToIndex')
      .mockImplementation(() => {});

    fireEvent.press(screen.getByTestId('jump-unread'));

    expect(spy).toHaveBeenCalledWith({
      index: dividerIndex(),
      viewPosition: 0,
      animated: true,
    });
    expect(topPill()).toBeNull();
    // 화면을 보지 않는 사람에게는 도착한 자리의 이름을 말한다.
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      '새 메시지 5개, 여기까지 읽음',
    );
    // 목록이 도착해 다시 위쪽 밖을 보고해도(짧은 이동) 다시 서지 않는다.
    reportDividerAbove();
    expect(topPill()).toBeNull();
  });

  it('동작 줄이기면 점프는 즉시다', async () => {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);
    const {listRef} = mount();
    await flushFrame();
    await settleAtBottom();
    reportDividerAbove();
    const spy = jest
      .spyOn(listRef.current!, 'scrollToIndex')
      .mockImplementation(() => {});
    fireEvent.press(screen.getByTestId('jump-unread'));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({animated: false}));
  });

  it('안읽음이 없으면 위 필은 없다', async () => {
    mount({lastReadSeq: null, unreadCount: 0});
    await settleAtBottom();
    scrollUpIntoHistory();
    reportVisible(4, 7);
    expect(topPill()).toBeNull();
    expect(bottomPill()).not.toBeNull();
  });

  it('방이 바뀌면(목록이 비면) 래치가 풀린다', async () => {
    const {rerender} = mount();
    await settleAtBottom();
    reportDividerAbove();
    reportDividerIn();
    expect(topPill()).toBeNull();

    // 새 방: `useTimeline` 이 먼저 비우고 다시 읽는다.
    rerender({messages: [], status: 'loading'});
    const next = [101, 102, 103, 104].map(seq => message(seq));
    rerender({messages: next, status: 'ready', lastReadSeq: 101, unreadCount: 3});
    await settleAtBottom();
    reportDividerAbove();
    expect(pillSentence('jump-unread')).toBe('새 메시지 3개 보기');
  });
});

describe('아래 필 「최신으로」', () => {
  it('바닥에 있으면 없고, 떠나면 「최신 메시지로 이동」이 선다', async () => {
    mount();
    await settleAtBottom();
    expect(bottomPill()).toBeNull();

    scrollUpIntoHistory();
    expect(bottomPill()).not.toBeNull();
    expect(bottomPill()?.props.accessibilityLabel).toBe('최신 메시지로 이동');
    expect(pillSentence('jump-latest')).toBe('최신 메시지로 이동');
  });

  it('떠난 뒤 붙은 남의 말만 센다 — 내가 보낸 확정 메시지는 「새 메시지」가 아니다', async () => {
    const {rerender} = mount();
    await settleAtBottom();
    scrollUpIntoHistory();

    rerender({messages: [...HISTORY, message(9), message(10, SELF), message(11)]});
    expect(pillSentence('jump-latest')).toBe('새 메시지 2개 보기');
    expect(bottomPill()?.props.accessibilityLabel).toBe('새 메시지 2개 보기');
  });

  it('누르면 스크롤뷰가 든 콘텐츠의 끝으로 가고, 필은 그 순간 물러난다', async () => {
    const {listRef} = mount();
    await settleAtBottom();
    scrollUpIntoHistory(); // 오프셋 1200 · 콘텐츠 4000 · 창 800
    const spy = jest.spyOn(listRef.current!, 'scrollToOffset');

    fireEvent.press(screen.getByTestId('jump-latest'));
    expect(bottomPill()).toBeNull();
    await flushFrame();
    // 목록의 추정(`scrollToEnd`)이 아니라 콘텐츠의 실제 끝: 4000 − 800.
    expect(spy).toHaveBeenCalledWith({offset: 3200, animated: false});
  });

  it('끝을 넘어 선 자리는 쉬는 자리가 아니다 — 스크롤뷰가 든 끝으로 되돌린다', async () => {
    // 시뮬레이터 실측(iOS 26.5): 착지한 목록이 콘텐츠 끝보다 415pt 아래에 서서
    // 화면이 비었다. 옛 도착 판정(`left <= 1`)은 음수도 도착으로 읽었다.
    const {listRef} = mount();
    await settleAtBottom();
    scrollUpIntoHistory();
    const spy = jest.spyOn(listRef.current!, 'scrollToOffset');
    fireEvent.press(screen.getByTestId('jump-latest'));
    await flushFrame();
    spy.mockClear();

    overshoot(415);
    await waitRound();

    expect(spy).toHaveBeenCalledWith({offset: 3200, animated: false});
  });

  it('도착한 뒤 손가락 없이 밀려나면 되돌린다 — 착지 유지', async () => {
    const {listRef} = mount();
    await settleAtBottom();
    scrollUpIntoHistory();
    const spy = jest.spyOn(listRef.current!, 'scrollToOffset');
    fireEvent.press(screen.getByTestId('jump-latest'));
    await flushFrame();
    atTheEnd();
    await waitRound(); // 도착 — 수렴이 풀리고 착지 유지가 시작된다
    spy.mockClear();

    overshoot(415); // 풀린 뒤에 온 어긋남. 이 파일의 누구도 스크롤하지 않았다.
    await waitRound();
    await waitRound();

    expect(spy).toHaveBeenCalledWith({offset: 3200, animated: false});
    // 그동안 아래 필은 다시 서지 않는다 — 떨림 없이 제자리다.
    expect(bottomPill()).toBeNull();
  });

  it('착지 유지는 손가락에게 진다', async () => {
    const {listRef} = mount();
    await settleAtBottom();
    scrollUpIntoHistory();
    const spy = jest.spyOn(listRef.current!, 'scrollToOffset');
    fireEvent.press(screen.getByTestId('jump-latest'));
    await flushFrame();
    atTheEnd();
    await waitRound();
    spy.mockClear();

    scrollUpIntoHistory(); // 사람이 잡고 올라간다
    await waitRound();
    await waitRound();

    expect(spy).not.toHaveBeenCalled();
    expect(bottomPill()).not.toBeNull();
  });

  it('바닥으로 돌아오면 쌓인 수는 0 으로 돌아간다', async () => {
    const {rerender} = mount();
    await settleAtBottom();
    scrollUpIntoHistory();
    rerender({messages: [...HISTORY, message(9)]});
    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');

    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 3200},
        contentSize: {height: 4000, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    expect(bottomPill()).toBeNull();
    scrollUpIntoHistory();
    expect(pillSentence('jump-latest')).toBe('최신 메시지로 이동');
  });
});

describe('필을 켜지 않은 표면', () => {
  it('스레드·하네스는 목록을 그대로 둔다 — 필도 보고 콜백도 없다', async () => {
    mount({jumpPills: false});
    await settleAtBottom();
    scrollUpIntoHistory();
    expect(bottomPill()).toBeNull();
    expect(topPill()).toBeNull();
    expect(list().props.onViewableItemsChanged).toBeUndefined();
  });
});

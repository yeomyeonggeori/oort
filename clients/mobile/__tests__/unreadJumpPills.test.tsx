import type {Message, RosterMember} from '@momo/core/lib/api';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import {readFileSync} from 'fs';
import {join} from 'path';
import React from 'react';
import {AccessibilityInfo, FlatList, Keyboard} from 'react-native';

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

// 제스트 렌더러에는 네이티브 태그가 없어 `findNodeHandle` 이 언제나 null 이다
// (`workConsole.test.tsx` 와 같은 사정). 여기서는 **어느 행**이 초점을 받았는지를
// 물어야 하므로, 노드의 접근성 라벨을 그 노드의 손잡이로 돌려준다 — 라벨은 행마다
// 본문이 달라 착지한 행을 이름으로 가려낸다(R1 M-3).
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...jest.requireActual('react-native/Libraries/ReactNative/RendererProxy'),
  findNodeHandle: jest.fn(
    (node: {props?: {accessibilityLabel?: string}} | null) =>
      node?.props?.accessibilityLabel ?? null,
  ),
}));

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

function message(seq: number, authorMemberId = OTHER, channelId = 'ch'): Message {
  return {
    id: `msg-${seq}`,
    channelId,
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
  channelId?: string;
  working?: readonly {memberId: string}[];
  jumpTarget?: {messageId: string; seq: number | null; token: number};
}

function element(listRef: ListRef, over: MountProps = {}) {
  return (
    <Timeline
      messages={over.messages ?? HISTORY}
      directory={DIRECTORY}
      status={over.status ?? 'ready'}
      channelId={over.channelId}
      myMemberId={SELF}
      nowMs={BASE_MS}
      lastReadSeq={over.lastReadSeq === undefined ? 3 : over.lastReadSeq}
      unreadCount={over.unreadCount ?? 5}
      working={over.working}
      jumpTarget={over.jumpTarget}
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

type Emitter = {emit: (event: string, payload: unknown) => void};

/** 키보드 이벤트 — `keyboardTravel.test.tsx` 와 같은 길로 보낸다. */
function keyboard(event: string, height = 336) {
  act(() => {
    (Keyboard as unknown as {_emitter: Emitter})._emitter.emit(event, {
      endCoordinates: {height, screenX: 0, screenY: 0, width: 390},
      duration: 250,
      easing: 'keyboard',
    });
  });
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
  // 프리셋의 목이다 — `spyOn` 은 같은 함수를 돌려주고 `restoreAllMocks` 는 기록을
  // 지우지 않는다. 비우지 않으면 앞 시험의 초점 이동이 다음 시험의 기록에 남는다.
  (AccessibilityInfo.setAccessibilityFocus as jest.Mock).mockClear();
});

afterEach(() => {
  cleanup();
  // `Keyboard` 는 모듈 하나가 「지금 올라와 있다」를 들고 있다. 다음 시험이 올라온
  // 키보드로 시작하지 않게 내려 둔다.
  (Keyboard as unknown as {_emitter: Emitter})._emitter.emit('keyboardDidHide', {
    endCoordinates: {height: 0, screenX: 0, screenY: 0, width: 390},
  });
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
    // 목록이 도착해 다시 위쪽 밖을 보고해도(짧은 이동) 다시 서지 않는다.
    reportDividerAbove();
    expect(topPill()).toBeNull();
  });

  it('누른 뒤 VoiceOver 초점은 구분선 아래 첫 메시지로 간다 — 낭독이 아니라 초점이다 (R1 M-3)', async () => {
    // 웹 `jumpToUnread` 가 초점을 두는 행과 같다(`firstUnreadMessageSeq`). 첫 판은
    // 구분선의 문장을 낭독했고, 그 낭독은 초점을 쥔 필이 사라지는 순간에 나갔다.
    const focus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {});
    const {listRef} = mount();
    await settleAtBottom();
    reportDividerAbove();
    jest.spyOn(listRef.current!, 'scrollToIndex').mockImplementation(() => {});

    fireEvent.press(screen.getByTestId('jump-unread'));

    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1), {timeout: 2000});
    expect(focus).toHaveBeenCalledWith(expect.stringContaining('4번째 메시지'));
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
  });

  it('손가락이 목록을 잡으면 걸려 있던 초점 이동은 거둔다 (R1 M-3)', async () => {
    const focus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {});
    const {listRef} = mount();
    await settleAtBottom();
    reportDividerAbove();
    jest.spyOn(listRef.current!, 'scrollToIndex').mockImplementation(() => {});

    fireEvent.press(screen.getByTestId('jump-unread'));
    fireEvent(list(), 'scrollBeginDrag');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
    });

    expect(focus).not.toHaveBeenCalled();
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

});

// ---- 방을 옮기면 (design-review 2594 R1 H-1) ------------------------------------
//
// 대화 화면은 방을 옮길 때 목록을 언마운트하지 않는다. 셸이 `channelId` 만 갈아
// 끼우고, `useTimeline` 은 **효과에서** 비운다 — 그래서 목록이 보는 순서는 늘 셋이다:
//
//   1. 새 방 id + 앞 방의 행        (바뀐 첫 렌더)
//   2. 새 방 id + 빈 메시지 · 로딩  (효과가 비운 뒤)
//   3. 새 방 id + 새 방의 첫 페이지
//
// 에이전트가 새 방에서 일하고 있으면 2 에서도 「작업 중」 자리가 서 있어 목록이
// 한 번도 비지 않는다. 첫 판은 「목록이 비었는가」로 방 전환을 판정했고, 이 길에서
// 앞 방의 래치·기준선·진입 판정이 새 방으로 넘어왔다.

const ROOM_B = [101, 102, 103, 104].map(seq => message(seq, OTHER, 'ch-b'));
/** 새 방에서 일하는 에이전트의 「작업 중」 자리. 이것이 목록을 붙잡는다. */
const WORKING = [{memberId: OTHER}] as const;

/** 방 B 로 옮기는 세 렌더. `live` 는 3 에 얹을 값(커서·안읽음·점프). */
function switchToRoomB(
  rerender: (next: MountProps) => void,
  live: MountProps = {},
  between?: () => void,
) {
  rerender({channelId: 'ch-b', working: WORKING});
  between?.();
  rerender({channelId: 'ch-b', working: WORKING, messages: [], status: 'loading'});
  between?.();
  rerender({
    channelId: 'ch-b',
    working: WORKING,
    messages: ROOM_B,
    status: 'ready',
    lastReadSeq: 101,
    unreadCount: 3,
    ...live,
  });
}

describe('방을 옮기면 필의 판정을 새로 한다 — 방의 정체성 (R1 H-1)', () => {
  it('「작업 중」 자리가 목록을 붙잡은 채 옮겨도 래치가 풀린다', async () => {
    const {rerender} = mount({channelId: 'ch'});
    await settleAtBottom();
    reportDividerAbove();
    reportDividerIn(); // 방 A 에서 구분선을 봤다 → 래치
    expect(topPill()).toBeNull();

    switchToRoomB(rerender, {}, () => {
      // 이 판의 요점: 목록은 한 번도 비지 않는다.
      expect(list()).toBeTruthy();
    });
    await settleAtBottom();
    reportDividerAbove();

    // 래치가 넘어왔다면 방 B 의 위 필은 이 방문 내내 서지 않는다.
    expect(pillSentence('jump-unread')).toBe('새 메시지 3개 보기');
  });

  it('앞 방에서 위로 올라가 있었어도 새 방의 아래 필은 앞 방의 기준선으로 세지 않는다', async () => {
    const {rerender} = mount({channelId: 'ch'});
    await settleAtBottom();
    scrollUpIntoHistory(); // 방 A 의 기준선은 seq 8
    expect(bottomPill()).not.toBeNull();

    switchToRoomB(rerender, {}, () => {
      // 옮긴 첫 프레임부터 앞 방의 「최신으로」는 없다.
      expect(bottomPill()).toBeNull();
    });

    // seq 는 방마다 따로 매긴다. 기준선 8 로 방 B 를 세면 「새 메시지 4개 보기」다.
    expect(bottomPill()).toBeNull();
  });

  it('진입 앵커는 새 방의 메시지가 도착한 뒤에 다시 탄다 — 앞 방의 행이나 자리표시에는 타지 않는다', async () => {
    const {rerender, listRef} = mount({channelId: 'ch'});
    await settleAtBottom(); // 방 A 의 진입은 끝났다
    const toEnd = jest
      .spyOn(listRef.current!, 'scrollToEnd')
      .mockImplementation(() => {});

    // 1: 새 방 id 인데 행은 앞 방의 것. 그 위의 레이아웃 보고로 진입하면 새 방의
    //    첫 페이지는 앵커 없이 도착한다.
    rerender({channelId: 'ch-b', working: WORKING});
    fireEvent(list(), 'contentSizeChange', 390, 3000);
    // 2: 자리표시 하나뿐인 목록.
    rerender({channelId: 'ch-b', working: WORKING, messages: [], status: 'loading'});
    fireEvent(list(), 'contentSizeChange', 390, 80);
    expect(toEnd).not.toHaveBeenCalledWith({animated: false});

    // 3: 새 방의 첫 페이지 — 여기서 진입(#1025)이 다시 탄다: 즉시 한 번, 그리고 수렴.
    rerender({
      channelId: 'ch-b',
      working: WORKING,
      messages: ROOM_B,
      status: 'ready',
      lastReadSeq: 101,
      unreadCount: 3,
    });
    fireEvent(list(), 'contentSizeChange', 390, 4000);
    expect(toEnd).toHaveBeenCalledWith({animated: false});
    await flushFrame(); // 수렴이 act 안에서 끝나게 둔다
  });
});

// ---- 점프가 진입을 가져간다 (design-review 2594 R1 M-1) --------------------------
//
// 다른 방으로 가는 착지(ADE 「대화로」, #2584 의 알림 탭)는 새 방의 목록이 준비된
// 뒤 `jumpTarget` 으로 걸린다. 그 효과와 새 목록의 첫 `onContentSizeChange` 는 순서가
// 약속되지 않는다. 어느 순서로 와도 착지가 진입 수렴에 지면 안 된다.

describe('점프가 진입을 가져간다 (R1 M-1)', () => {
  it('점프가 쫓기를 거둔다 — 진입 수렴이 도는 중에 걸린 점프', async () => {
    const {rerender, listRef} = mount({channelId: 'ch'});
    const toEnd = jest
      .spyOn(listRef.current!, 'scrollToEnd')
      .mockImplementation(() => {});
    const toIndex = jest
      .spyOn(listRef.current!, 'scrollToIndex')
      .mockImplementation(() => {});
    // 진입 수렴이 시작된다. 창을 아직 못 쟀으므로 끝까지의 거리는 모르고, 수렴은
    // 라운드마다 끝으로 한 번씩 더 간다.
    fireEvent(list(), 'contentSizeChange', 390, 4000);
    await waitRound();
    expect(toEnd).toHaveBeenCalled();

    rerender({channelId: 'ch', jumpTarget: {messageId: 'msg-2', seq: 2, token: 1}});
    expect(toIndex).toHaveBeenCalledWith(
      expect.objectContaining({viewPosition: 0.5}),
    );
    toEnd.mockClear();
    await waitRound();
    await waitRound();

    // 쫓기가 남아 있으면 방금 데려간 줄에서 목록을 도로 바닥으로 끌어내린다.
    expect(toEnd).not.toHaveBeenCalled();
    expect(bottomPill()).not.toBeNull();
  });

  it('대기 점프가 있으면 진입 수렴이 서지 않는다 — 새 방에서 점프가 첫 레이아웃 보고보다 먼저 온 경우', async () => {
    const {rerender, listRef} = mount({channelId: 'ch'});
    await settleAtBottom();
    const toIndex = jest
      .spyOn(listRef.current!, 'scrollToIndex')
      .mockImplementation(() => {});

    // ADE 「대화로」: 방 B 의 첫 페이지가 준비된 뒤 그 줄로 가는 점프가 걸린다.
    // 목록은 아직 새 콘텐츠를 보고하지 않았다.
    switchToRoomB(rerender, {
      jumpTarget: {messageId: 'msg-102', seq: 102, token: 1},
    });
    expect(toIndex).toHaveBeenCalledWith(
      expect.objectContaining({viewPosition: 0.5}),
    );
    const toEnd = jest
      .spyOn(listRef.current!, 'scrollToEnd')
      .mockImplementation(() => {});

    // 늦게 도착한 첫 레이아웃 보고. 진입 앵커가 여기서 타면 목록은 바닥에 서고,
    // 착지 틴트는 화면 밖 행에 걸린다.
    fireEvent(list(), 'contentSizeChange', 390, 4000);
    await waitRound();
    await waitRound();

    expect(toEnd).not.toHaveBeenCalled();
    // 따라가기는 점프가 끈 그대로다 — 「최신으로」가 선다.
    expect(bottomPill()).not.toBeNull();
  });

  it('빗나간 점프는 진입을 가져가지 않는다 — 그 방의 바닥에서 열린다', async () => {
    const onJumpMissed = jest.fn();
    const listRef = React.createRef<FlatList<TimelineStreamItem>>() as ListRef;
    render(
      <Timeline
        messages={HISTORY}
        directory={DIRECTORY}
        status="ready"
        channelId="ch"
        myMemberId={SELF}
        nowMs={BASE_MS}
        lastReadSeq={3}
        unreadCount={5}
        jumpTarget={{messageId: 'msg-older', seq: 1, token: 1}}
        onJumpMissed={onJumpMissed}
        jumpPills
        listRef={listRef}
      />,
    );
    expect(onJumpMissed).toHaveBeenCalled();
    const toEnd = jest
      .spyOn(listRef.current!, 'scrollToEnd')
      .mockImplementation(() => {});

    fireEvent(list(), 'contentSizeChange', 390, 4000);

    expect(toEnd).toHaveBeenCalledWith({animated: false});
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

  it('도착하면 VoiceOver 초점이 가장 아래 메시지로 간다 — 누른 필은 사라졌다 (R1 M-3)', async () => {
    // 웹 `jumpToLatest` 가 초점을 두는 행과 같다. 첫 판은 낭독도 초점 이동도 없어서,
    // 초점을 쥔 필이 사라지는 순간 VoiceOver 는 갈 곳을 잃었다.
    const focus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {});
    mount();
    await settleAtBottom();
    scrollUpIntoHistory();
    fireEvent.press(screen.getByTestId('jump-latest'));
    await flushFrame();
    // 아직 가는 중에는 옮기지 않는다 — 움직이는 행에 초점을 주면 VoiceOver 가 한 번
    // 더 스크롤한다.
    expect(focus).not.toHaveBeenCalled();

    atTheEnd();
    await waitRound(); // 도착 — 수렴이 풀린다

    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1), {timeout: 2000});
    expect(focus).toHaveBeenCalledWith(expect.stringContaining('8번째 메시지'));
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

describe('키보드가 올라와 있으면 위 필은 잘린 띠에 서지 않는다 (R1 M-4)', () => {
  // 대화 화면은 키보드 높이만큼 판을 들어 올리고 그 위를 잘라 낸다
  // (`ConversationLayout`). 목록 맨 위에 붙은 필은 그 띠 안에 서서 보이지도 눌리지도
  // 않는데, 스크린리더에는 단추로 남는다.

  it('올라오면 위 필은 트리에서 빠지고, 내려가면 다시 선다 — 아래 필은 그대로다', async () => {
    mount();
    await settleAtBottom();
    scrollUpIntoHistory();
    reportDividerAbove();
    expect(topPill()).not.toBeNull();
    expect(bottomPill()).not.toBeNull();

    keyboard('keyboardWillShow');
    // 그리지 않은 단추는 접근성 트리에도 없다 — 숨김 속성으로 가리는 것과 다르다.
    expect(topPill()).toBeNull();
    expect(screen.queryByLabelText('위쪽의 새 메시지 5개 보기')).toBeNull();
    // 아래 필은 목록과 함께 컴포저 위에 서므로 잘리지 않는다.
    expect(bottomPill()).not.toBeNull();

    keyboard('keyboardWillHide', 0);
    expect(pillSentence('jump-unread')).toBe('새 메시지 5개 보기');
  });

  it('키보드가 이미 올라와 있을 때 새로 서는 위 필도 서지 않는다', async () => {
    // 입력 중에 새 메시지가 구분선을 위로 밀어내는 순간이 이 길이다.
    keyboard('keyboardDidShow');
    expect(Keyboard.isVisible()).toBe(true);
    mount();
    await settleAtBottom();
    reportDividerAbove();
    expect(topPill()).toBeNull();

    keyboard('keyboardDidHide', 0);
    expect(topPill()).not.toBeNull();
  });
});

describe('인용·고정·검색 점프도 「동작 줄이기」를 따른다 (R1 N-4)', () => {
  // 한 클라 안에서 점프가 움직임을 거르는 자리가 둘이면, 같은 설정이 단추마다
  // 다르게 듣는다. 두 필은 첫 판부터 따랐고, 같은 효과 안의 인용 점프만 빠져 있었다.
  async function quoteJump(): Promise<{animated?: boolean | null} | undefined> {
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => {});
    const {rerender} = mount();
    await flushFrame(); // 설정의 첫 답이 온다
    await settleAtBottom();
    rerender({jumpTarget: {messageId: 'msg-2', seq: 2, token: 1}});
    return toIndex.mock.calls.at(-1)?.[0];
  }

  it('동작 줄이기면 인용 점프도 즉시다', async () => {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);
    expect(await quoteJump()).toEqual(
      expect.objectContaining({viewPosition: 0.5, animated: false}),
    );
  });

  it('아니면 인용 점프는 그대로 부드럽다', async () => {
    expect(await quoteJump()).toEqual(
      expect.objectContaining({viewPosition: 0.5, animated: true}),
    );
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

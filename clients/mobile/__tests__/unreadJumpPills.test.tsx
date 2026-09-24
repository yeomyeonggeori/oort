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
  selfSendToken?: number;
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
      selfSendToken={over.selfSendToken}
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

/** 목록이 오프셋 `y` 에 섰다고 보고한다(창 800 · 콘텐츠 4000). 드래그는 없다. */
function scrollBy(y: number) {
  fireEvent.scroll(list(), {
    nativeEvent: {
      contentOffset: {y},
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
    const {rerender} = mount({channelId: 'ch'});
    await settleAtBottom(); // 방 A 의 진입은 끝났다
    // 원형에 건다 — 새 방의 행은 새 스크롤뷰가 받으므로(아래 시험) 인스턴스 하나에
    // 걸면 새 방의 진입을 못 본다.
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
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

  it('새 방의 행은 새 스크롤뷰가 받는다 — 앞 방의 행이나 빈 목록일 때는 그대로다', () => {
    // 시뮬레이터 실측(`JUMP-PILLS-ROOMS`): 앞 방의 스크롤뷰가 새 방을 그대로 받으면,
    // 진입 수렴이 끝나 `maintainVisibleContentPosition` 이 다시 켜지는 순간 앞 판에서
    // 기록한 앵커를 clamp 없이 적용했다 — 끝을 오르던 목록(2396/3008)이 357 로 밀려
    // 구분선이 보이는 자리에 섰고, 거기서 래치가 걸려 새 방의 위 필이 서지 않았다.
    const {rerender, listRef} = mount({channelId: 'ch'});
    const roomA = listRef.current;

    rerender({channelId: 'ch-b', working: WORKING});
    expect(listRef.current).toBe(roomA); // 앞 방의 행 — 새 목록에 그리면 그 행이 번쩍인다
    rerender({channelId: 'ch-b', working: WORKING, messages: [], status: 'loading'});
    expect(listRef.current).toBe(roomA); // 자리표시만 — 여기서 새로 세우면 그것을 앵커로 삼는다

    rerender({
      channelId: 'ch-b',
      working: WORKING,
      messages: ROOM_B,
      status: 'ready',
      lastReadSeq: 101,
      unreadCount: 3,
    });
    expect(listRef.current).not.toBeNull();
    expect(listRef.current).not.toBe(roomA);
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

    // 점프가 목표 줄에 앉는다(끝에서 멀다). 이동이 멈추면 그 자리에서 판정하고 —
    // 필은 그때까지 그대로다(R2 H-A) — 「최신으로」가 선다.
    scrollBy(400);
    await sleep(350);
    expect(toEnd).not.toHaveBeenCalled();
    expect(bottomPill()).not.toBeNull();
  });

  it('대기 점프가 있으면 진입 수렴이 서지 않는다 — 새 방에서 점프가 첫 레이아웃 보고보다 먼저 온 경우', async () => {
    const {rerender} = mount({channelId: 'ch'});
    await settleAtBottom();
    // 원형에 건다 — 새 방의 행은 새 스크롤뷰가 받는다.
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
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
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});

    // 늦게 도착한 첫 레이아웃 보고. 진입 앵커가 여기서 타면 목록은 바닥에 서고,
    // 착지 틴트는 화면 밖 행에 걸린다.
    fireEvent(list(), 'contentSizeChange', 390, 4000);
    await waitRound();
    await waitRound();

    expect(toEnd).not.toHaveBeenCalled();
    // 점프가 목표 줄(msg-102)에 앉는다 — 끝에서 멀다. 이동이 멈추면 그 자리에서
    // 판정하고 「최신으로」가 선다(R2 H-A: 필은 판정이 날 때까지 그대로다).
    scrollBy(400);
    await sleep(350);
    expect(toEnd).not.toHaveBeenCalled();
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

  it('착지하러 가는 동안 목록이 콘텐츠 끝에 서도 「바닥」으로 읽지 않는다 — 회복 경로의 clamp', () => {
    // 시뮬레이터 실측(`JUMP-PILLS-LAND`): 새 방의 아직 안 잰 줄로 가는 점프는
    // `onScrollToIndexFailed` 를 타고, 그 회복은 목록을 `평균 행 높이 × 첨자` 에 세운다.
    // 새 목록은 몇 행만 재어 두었으므로 스크롤뷰가 그 자리를 **재어 둔 끝**에 세우고
    // (788/1399), 그 스크롤 보고가 따라가기를 켰다. 다음 콘텐츠 증가가 목록을 꼬리로
    // 활강시켜 착지는 끝내 보이지 않았다.
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    mount({channelId: 'ch', jumpTarget: {messageId: 'msg-2', seq: 2, token: 1}});

    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 800},
        contentSize: {height: 1399, width: 390},
        layoutMeasurement: {height: 599, width: 390},
      },
    });
    fireEvent(list(), 'contentSizeChange', 390, 2099);

    expect(toEnd).not.toHaveBeenCalled();
    // 필은 판정이 날 때까지 그대로다(R2 H-A). 멈춘 뒤의 판정은 아래 「회복 경로의
    // clamp 자리는 착지가 아니다」가 회복의 한 바퀴를 끝까지 돌려 단정한다.
  });
});

// ---- 이동이 멈추면 다시 판정한다 (design-review 2594 R2 H-A) -----------------------
//
// R2 의 점프 핀(800ms)은 「가는 동안의 자리는 사람의 것이 아니다」를 지켰지만, 핀이
// **놓을 때** 아무도 바닥을 다시 판정하지 않았다. 착지한 목록이 멈추며 보내는 마지막
// 스크롤 보고(RN `_handleFinishedScrolling`)는 핀 안에 와서 버려지고, 목표가 지금
// 자리와 같으면(끝 근처 착지·짧은 대화) 보고는 아예 오지 않는다. 그러면 가장 새 메시지
// 위에 서 있는데 「최신 메시지로 이동」이 서고, 다음 메시지는 따라가지 않는다.
//
// 리뷰의 탐침(`probe-2594r2/__tests__/pinExpiry.test.tsx`) 판을 그대로 옮겼다: 메시지
// 8개, 끝에 앉힘(3200/4000/800), 가장 새 `msg-8` 로 점프.

async function sleep(ms: number) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

/** 안읽음 없이 끝에 앉은 목록 — 탐침의 판. */
async function mountAtTheEnd(over: MountProps = {}) {
  const mounted = mount({channelId: 'ch', lastReadSeq: 8, unreadCount: 0, ...over});
  await settleAtBottom();
  expect(bottomPill()).toBeNull();
  return mounted;
}

const TO_NEWEST = {messageId: 'msg-8', seq: 8, token: 1};

/** 남의 메시지가 붙는다. 따라가면 목록이 끝으로 간다. */
function someoneElseTalks() {
  const toEnd = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  fireEvent(list(), 'contentSizeChange', 390, 4100);
  return toEnd;
}

describe('끝 근처 착지 — 이동이 멈추면 바닥을 다시 판정한다 (R2 H-A)', () => {
  beforeEach(() => {
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
  });

  it('탐침 A: 착지 보고가 이동 중에 와도, 이동이 멈추면 따라가기로 돌아온다', async () => {
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: TO_NEWEST});
    await sleep(300);
    atTheEnd(); // 끝난 프로그램 스크롤이 강제로 한 번 보내는 보고
    await sleep(700);
    const toEnd = someoneElseTalks();

    expect(bottomPill()).toBeNull();
    expect(toEnd).toHaveBeenCalled();
  });

  it('움직이는 동안 매 프레임 보고가 오고 마지막 보고가 끝 근처면, 멈춘 뒤 따라가기로 돌아온다', async () => {
    // 실제 활강은 보고를 한 번이 아니라 프레임마다 보낸다 — 이동은 그동안 살아 있고,
    // 판정은 멈춘 자리(마지막 보고)에서 난다. 탐침 A 의 보고 한 번은 이동이 이미 멈춘
    // 뒤에 도착해 보통의 판정을 받는다.
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: TO_NEWEST});
    for (const y of [3120, 3140, 3160, 3180, 3195, 3200]) {
      await sleep(50);
      scrollBy(y);
    }
    await sleep(400);
    const toEnd = someoneElseTalks();

    expect(bottomPill()).toBeNull();
    expect(toEnd).toHaveBeenCalled();
  });

  it('탐침 B(대조): 같은 보고가 늦게 와도 같은 결과다', async () => {
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: TO_NEWEST});
    await sleep(850);
    atTheEnd();
    const toEnd = someoneElseTalks();

    expect(bottomPill()).toBeNull();
    expect(toEnd).toHaveBeenCalled();
  });

  it('보고가 아예 오지 않는 착지(목표가 지금 자리)도 곧 따라가기로 돌아온다', async () => {
    // 목표를 clamp 한 자리가 지금 오프셋과 같으면 스크롤뷰는 아무 보고도 하지 않는다
    // (`RCTScrollViewComponentView.mm` `scrollToOffset:animated:` 의 같은 점 반환).
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: TO_NEWEST});
    await sleep(400);
    const toEnd = someoneElseTalks();

    expect(bottomPill()).toBeNull();
    expect(toEnd).toHaveBeenCalled();
  });

  it('끝 근처에 착지하는 동안 「최신으로」는 한 번도 서지 않는다', async () => {
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: TO_NEWEST});
    expect(bottomPill()).toBeNull();
    await sleep(100);
    expect(bottomPill()).toBeNull();
    atTheEnd();
    await sleep(500);
    expect(bottomPill()).toBeNull();
  });

  it('「안읽음으로」도 끝 근처에 착지하면 따라가기로 돌아온다', async () => {
    // 안읽음 묶음이 한 화면보다 조금 긴 방: 구분선(seq 7 위)은 창 위쪽 밖이고,
    // 누르면 끝에서 50pt 앞에 앉는다.
    mount({channelId: 'ch', lastReadSeq: 6, unreadCount: 2});
    await settleAtBottom();
    reportDividerAbove();
    fireEvent.press(screen.getByTestId('jump-unread'));
    // 구분선을 창 맨 위로 데려가는 활강 — 프레임마다 보고가 오고, 끝에서 50pt 앞에 앉는다.
    for (const y of [3190, 3175, 3160, 3150]) {
      await sleep(60);
      scrollBy(y);
    }
    await sleep(450);
    const toEnd = someoneElseTalks();

    expect(bottomPill()).toBeNull();
    expect(toEnd).toHaveBeenCalled();
  });

  it('VoiceOver 세 손가락 스크롤처럼 드래그 없는 이동으로 끝에 돌아와도 판정이 막히지 않는다', async () => {
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: {messageId: 'msg-2', seq: 2, token: 1}});
    await sleep(100);
    scrollBy(1200); // 점프가 위로 데려간다
    await sleep(200);
    atTheEnd(); // 사람이 세 손가락으로 끝까지 내린다 — `scrollBeginDrag` 는 없다
    await sleep(400);
    const toEnd = someoneElseTalks();

    expect(bottomPill()).toBeNull();
    expect(toEnd).toHaveBeenCalled();
  });

  it('멀리 착지하면 이동이 멈춘 뒤 「최신으로」가 서고, 따라가지 않는다', async () => {
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: {messageId: 'msg-2', seq: 2, token: 1}});
    await sleep(100);
    scrollBy(1200);
    await sleep(500);
    const toEnd = someoneElseTalks();

    expect(bottomPill()).not.toBeNull();
    expect(toEnd).not.toHaveBeenCalled();
  });

  it('손가락이 거둔 점프를 회복 경로가 다시 쥐지 않는다 (R2 N-A)', async () => {
    // 아직 안 잰 행으로 가는 점프는 `onScrollToIndexFailed` 를 탄다. 가상 목록처럼
    // 실패를 그 자리에서(동기로) 알린다.
    const toIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(function (this: FlatList<TimelineStreamItem>, params) {
        this.props.onScrollToIndexFailed?.({
          index: params.index,
          averageItemLength: 70,
          highestMeasuredFrameIndex: 1,
        });
      });
    const toOffset = jest
      .spyOn(FlatList.prototype, 'scrollToOffset')
      .mockImplementation(() => {});
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: {messageId: 'msg-2', seq: 2, token: 1}});
    expect(toIndex).toHaveBeenCalledTimes(1);
    toOffset.mockClear();

    fireEvent(list(), 'scrollBeginDrag'); // 사람이 목록을 잡는다
    await flushFrame();
    await sleep(50);

    // 회복의 다음 라운드가 손가락 밑에서 목록을 옮기거나 핀을 다시 걸면 안 된다.
    expect(toIndex).toHaveBeenCalledTimes(1);
    expect(toOffset).not.toHaveBeenCalled();
    // 손가락이 끝으로 데려오면 그 자리는 곧바로 바닥이다.
    atTheEnd();
    expect(bottomPill()).toBeNull();
  });

  it('회복 경로의 clamp 자리는 착지가 아니다 — 멈춘 뒤 목표 자리로 판정한다', async () => {
    // R1 M-1 실측: 새 목록에서 아직 안 잰 줄로 가는 점프는 목록을 잰 데까지의 끝에
    // 세우고(788/1399), 그 보고가 따라가기를 켜 착지가 꼬리로 끌려갔다.
    let calls = 0;
    jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(function (this: FlatList<TimelineStreamItem>, params) {
        calls += 1;
        if (calls > 1) return;
        this.props.onScrollToIndexFailed?.({
          index: params.index,
          averageItemLength: 70,
          highestMeasuredFrameIndex: 3,
        });
      });
    jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    mount({channelId: 'ch', jumpTarget: {messageId: 'msg-2', seq: 2, token: 1}});

    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 788},
        contentSize: {height: 1399, width: 390},
        layoutMeasurement: {height: 599, width: 390},
      },
    });
    fireEvent(list(), 'contentSizeChange', 390, 2099);
    await flushFrame(); // 회복의 다음 라운드 — 이번에는 목표에 앉는다
    expect(calls).toBe(2);
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 100},
        contentSize: {height: 2099, width: 390},
        layoutMeasurement: {height: 599, width: 390},
      },
    });
    fireEvent(list(), 'contentSizeChange', 390, 3008);
    await sleep(400);
    fireEvent(list(), 'contentSizeChange', 390, 3100);

    expect(toEnd).not.toHaveBeenCalled();
    expect(bottomPill()).not.toBeNull();
  });

  it('점프로 방에 들어온 방문은 착지에서 앉는다 — 드래그 없이도 구분선을 보면 래치가 걸린다 (R2 N-B)', async () => {
    // 착지 점프가 진입을 가져간 방문은 진입 수렴이 없으므로 「앉음」이 오지 않았다.
    // VoiceOver 사용자는 드래그를 하지 않으니, 구분선을 보고도 래치가 안 걸려 위 필이
    // 다시 섰다.
    mount({channelId: 'ch', jumpTarget: {messageId: 'msg-5', seq: 5, token: 1}});
    reportDividerIn(); // 착지한 자리에서 구분선이 보인다
    await sleep(400);
    reportDividerAbove(); // 새 메시지가 그것을 위로 밀어낸다

    expect(topPill()).toBeNull();
  });
});

// ---- 이동 중에 도착한 말 · 기하 없이 끝난 이동 · scrollToIndex 의 문 (#2608) --------
//
// design-review 2594 R3(PASS)가 남긴 같은 계열의 좁은 틈 둘과 가드. 리뷰 순서 탐침
// (`probe-2594r3/__tests__/orderings.test.tsx`)의 O1a·O1b·O2·O5·O7·O9 를 옮겼다.

/** 남의 말이 이동 중에 붙는다 — 점프는 그대로 걸려 있다. */
function arriveDuringTravel(
  rerender: (next: MountProps) => void,
  jumpTarget: MountProps['jumpTarget'],
  seq: number,
  height: number,
) {
  rerender({
    jumpTarget,
    messages: [1, 2, 3, 4, 5, 6, 7, 8, ...Array.from({length: seq - 8}, (_, i) => 9 + i)].map(
      n => message(n),
    ),
  });
  fireEvent(list(), 'contentSizeChange', 390, height);
}

describe('이동 중에 도착한 말은 판정 뒤에 따라간다 (#2608 M-B)', () => {
  // 점프는 가는 동안 따라가기를 붙든다 — 가는 도중에 붙은 말이 목록을 끌어내리면
  // 안 되기 때문이다. 그런데 착지 판정이 「따라가기」로 나와도 그동안 벌어진 틈을
  // 메우지 않아, 붙은 말이 접힌 아래 100pt 에 숨고 필도 서지 않았다(가장 흔한 알림 탭
  // 길, 창 약 0.45초).
  beforeEach(() => {
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
  });

  it('O1a: 착지 보고 뒤 이동이 끝나기 전에 100pt 가 붙으면, 판정이 나며 그 틈을 메운다', async () => {
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: TO_NEWEST});
    await sleep(200);
    atTheEnd(); // 착지 보고
    await sleep(100);
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    arriveDuringTravel(rerender, TO_NEWEST, 9, 4100); // 이동은 아직 걸려 있다
    expect(toEnd).not.toHaveBeenCalled(); // 가는 동안에는 끌어내리지 않는다
    await sleep(600);

    // 도착이 부르는 것과 같은 **활강**이다(#2618 M-1 · 리뷰 S11) — 즉시 이동이 아니다.
    expect(toEnd).toHaveBeenCalledWith({animated: true});
    expect(bottomPill()).toBeNull();
  });

  it('O1b: 붙은 말이 문턱보다 크면(300pt) 따라가지 않고, 필이 떠난 뒤의 수를 말한다', async () => {
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: TO_NEWEST});
    await sleep(200);
    atTheEnd();
    await sleep(100);
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    arriveDuringTravel(rerender, TO_NEWEST, 9, 4300);
    await sleep(600);

    expect(toEnd).not.toHaveBeenCalled();
    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');
  });

  it('O2: 보고 없는 착지(같은 자리) 중에 100pt 가 붙어도, 판정이 나며 따라간다', async () => {
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: TO_NEWEST});
    await sleep(100);
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    arriveDuringTravel(rerender, TO_NEWEST, 9, 4100);
    await sleep(500);

    expect(toEnd).toHaveBeenCalled();
    expect(bottomPill()).toBeNull();
  });

  it('「안읽음으로」가 끝 근처에 앉고 붙은 말이 없으면, 판정 뒤에 움직이지 않는다 — 구분선이 창 맨 위에 남는다', async () => {
    // 끝에서 50pt 앞에 앉은 착지는 판정이 「따라가기」다. 그래도 붙은 말이 없으면 틈을
    // 메우지 않는다: 메우면 방금 창 맨 위에 놓은 구분선이 창 밖으로 밀려난다.
    mount({channelId: 'ch', lastReadSeq: 6, unreadCount: 2});
    await settleAtBottom();
    reportDividerAbove();
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    fireEvent.press(screen.getByTestId('jump-unread'));
    for (const y of [3190, 3175, 3160, 3150]) {
      await sleep(60);
      scrollBy(y);
    }
    await sleep(450);
    expect(toEnd).not.toHaveBeenCalled();
    expect(bottomPill()).toBeNull();

    // 판정은 「따라가기」였다 — 그 뒤에 붙는 말은 따라간다.
    fireEvent(list(), 'contentSizeChange', 390, 4100);
    expect(toEnd).toHaveBeenCalled();
  });

  it('붙은 말이 없고 끝에 앉았으면, 판정 뒤에 더 움직이지 않는다', async () => {
    const {rerender} = await mountAtTheEnd();
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    rerender({jumpTarget: TO_NEWEST});
    await sleep(200);
    atTheEnd();
    await sleep(500);

    expect(toEnd).not.toHaveBeenCalled();
    expect(bottomPill()).toBeNull();
  });
});

/** 목록이 자기 창의 높이를 알린다(`onLayout`). */
function layoutReport(height: number) {
  fireEvent(list(), 'layout', {
    nativeEvent: {layout: {x: 0, y: 0, width: 390, height}},
  });
}

describe('기하를 모른 채 끝난 이동은 첫 기하 보고에서 판정한다 (#2608 M-C)', () => {
  // 목록이 한 번도 기하를 보고하지 않은 채 이동이 끝나면 판정할 수 없다. 첫 판은 그때
  // 따라가기를 붙든 채로 놓았고, 「다음 보고가 판정한다」는 주석과 달리 보고가 오지
  // 않는 착지에서는 아무도 판정하지 않았다 — 따라가지도 않고 필도 없었다.
  beforeEach(() => {
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
  });

  it('O9: 첫 기하가 끝에 앉은 자리면 따라가기로 판정하고, 붙은 말을 따라간다', async () => {
    const {rerender} = mount({channelId: 'ch', lastReadSeq: 8, unreadCount: 0, jumpTarget: TO_NEWEST});
    await sleep(400); // 기하 없이 이동이 끝난다
    layoutReport(800);
    fireEvent(list(), 'contentSizeChange', 390, 800);
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    arriveDuringTravel(rerender, TO_NEWEST, 9, 900);

    expect(toEnd).toHaveBeenCalled();
    expect(bottomPill()).toBeNull();
  });

  it('첫 기하가 끝에서 멀면 「최신으로」가 서고, 붙은 말은 따라가지 않는다', async () => {
    const {rerender} = mount({channelId: 'ch', lastReadSeq: 8, unreadCount: 0, jumpTarget: TO_NEWEST});
    await sleep(400);
    layoutReport(800);
    fireEvent(list(), 'contentSizeChange', 390, 4000); // 오프셋 0, 끝까지 3200
    expect(pillSentence('jump-latest')).toBe('최신 메시지로 이동');
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    arriveDuringTravel(rerender, TO_NEWEST, 9, 4100);

    expect(toEnd).not.toHaveBeenCalled();
    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');
  });
});

describe('scrollToIndex 는 이동을 거는 문 하나로만 부른다 (#2608 N-E)', () => {
  it('이동 없이 받은 실패는 개발 빌드에서 크게 실패한다 — 조용히 삼키지 않는다', async () => {
    // 가상 목록은 안 잰 목표를 **동기로** `onScrollToIndexFailed` 에 알리고, 회복은
    // 걸린 이동의 일부다. 이동 없이 이 콜백이 불렸다면 누군가 문을 거치지 않고
    // `scrollToIndex` 를 부른 것이다 — 「눌렀는데 아무 일도 안 일어남」.
    const {listRef} = await mountAtTheEnd();
    const failed = listRef.current!.props.onScrollToIndexFailed!;
    expect(() =>
      failed({index: 3, averageItemLength: 70, highestMeasuredFrameIndex: 1}),
    ).toThrow(/scrollToIndex/);
  });
});

describe('주장했던 성질을 시험이 잡는다 (#2608 N-F)', () => {
  it('O5: 먼 점프 중에 붙은 말은 착지 뒤 필의 수에 든다 — 기준선은 떠난 순간이다', async () => {
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    const far = {messageId: 'msg-2', seq: 2, token: 1};
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: far});
    await sleep(80);
    scrollBy(1200);
    await sleep(70);
    arriveDuringTravel(rerender, far, 9, 4100);
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 1200},
        contentSize: {height: 4100, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    await sleep(400);

    // 판정 순간의 가장 새 seq(9)를 기준선으로 삼으면 「최신 메시지로 이동」이 된다.
    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');
  });

  it('O7: 끝내 성공하지 않는 회복은 받침(1.5초)에서 끊고, 그 자리에서 판정한다', async () => {
    const calls: number[] = [];
    let startedAt = 0;
    jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(function (this: FlatList<TimelineStreamItem>, params) {
        calls.push(Date.now() - startedAt);
        this.props.onScrollToIndexFailed?.({
          index: params.index,
          averageItemLength: 70,
          highestMeasuredFrameIndex: 1,
        });
      });
    jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    const {rerender} = await mountAtTheEnd();
    startedAt = Date.now();
    rerender({jumpTarget: {messageId: 'msg-2', seq: 2, token: 1}});
    await sleep(2200);

    expect(calls.length).toBeGreaterThan(1); // 회복은 돌았다
    expect(calls.filter(ms => ms > 1700)).toEqual([]); // 받침 뒤로는 하나도 없다
    // 판정은 났다: 목록은 끝에 앉은 채였으므로 따라가기로 돌아온다.
    const toEnd = someoneElseTalks();
    expect(toEnd).toHaveBeenCalled();
  });
});

// ---- 미룬 판정의 수명주기 · 연쇄 점프 · 메우기 뒤 초점 (#2618) ----------------------
//
// design-review 2614(PASS)의 M-1 과 N-1·N-2. 미룬 판정(`pendingVerdictRef`)에는 줄이
// 여덟 있다 — 세우기 하나, 판정 셋(`onScroll`·`onContentSizeChange`·`onLayout`), 거두기
// 셋(방 전환·새 점프·전송 등), 그리고 손가락. 첫 판의 시험은 세우기와 콘텐츠 판정만
// 잡아, 나머지 여섯 줄은 하나씩 지워도 스위트가 초록이었다 — 그중 셋은 R1–R2 의 거짓
// 필과 「끝으로 끌려감」을 되돌린다. 리뷰 탐침 P4·P5·P7·P8·P9 와 연쇄 점프 N5a·N5b,
// 초점 N1b 를 옮겼다. 손가락 줄은 이 판에서 거두기가 아니라 **넘기기**가 됐다 — 판정을
// 손가락의 첫 보고에 넘기되 떠난 순간을 지킨다(`onScrollBeginDrag`).

/** 가장 오래된 것부터 `n` 통. */
function upTo(n: number, channelId = 'ch'): Message[] {
  return Array.from({length: n}, (_, i) => message(i + 1, OTHER, channelId));
}

/** 기하 보고가 오기 전에 점프해서, 기하 없이 이동이 끝난다 — 판정이 미뤄진다. */
async function pendingVerdict() {
  const mounted = mount({
    channelId: 'ch',
    lastReadSeq: 8,
    unreadCount: 0,
    jumpTarget: TO_NEWEST,
  });
  await sleep(400);
  return mounted;
}

describe('미룬 판정의 수명주기 — 여덟 줄이 저마다 시험에 걸린다 (#2618 M-1)', () => {
  beforeEach(() => {
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
  });

  it('P4: 첫 보고가 스크롤 보고(끝에서 멂)면 거기서 판정한다 — 기하 전에 붙은 말이 수에 든다', async () => {
    const {rerender} = await pendingVerdict();
    rerender({jumpTarget: TO_NEWEST, messages: upTo(9)}); // 기하 보고 전에 붙는다
    scrollBy(0); // 첫 보고 — 끝까지 3200

    // 떠난 순간(8)이 기준선이다. 보통 판정(지금의 9)으로 가면 「최신 메시지로 이동」.
    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');
  });

  it('P5: 콘텐츠 보고가 레이아웃보다 먼저 오면, 레이아웃 보고가 판정한다', async () => {
    const {rerender} = await pendingVerdict();
    fireEvent(list(), 'contentSizeChange', 390, 850); // 창을 아직 모른다
    layoutReport(800); // 이제 안다 — 끝까지 50
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    arriveDuringTravel(rerender, TO_NEWEST, 9, 950);

    expect(toEnd).toHaveBeenCalled();
    expect(bottomPill()).toBeNull();
  });

  it('P7: 판정을 기다리는 중에 방을 옮기면 버린다 — 앞 방의 기준선으로 새 방을 세지 않는다', async () => {
    const {rerender} = await pendingVerdict();
    rerender({
      channelId: 'ch2',
      jumpTarget: undefined,
      messages: upTo(12, 'ch2'),
      lastReadSeq: 12,
    });
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 0},
        contentSize: {height: 3000, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });

    // 앞 방의 기준선 8 이 새면 seq 9–12 를 세어 「새 메시지 4개 보기」가 된다.
    expect(pillSentence('jump-latest')).toBe('최신 메시지로 이동');
  });

  it('P8: 판정을 기다리는 중에 새 점프가 떠나면 버린다 — 이동 중에 끝으로 끌려가지 않는다', async () => {
    const {rerender} = await pendingVerdict();
    const second = {messageId: 'msg-2', seq: 2, token: 2};
    rerender({jumpTarget: second});
    await sleep(30);
    scrollBy(3150); // 새 이동이 아직 움직인다 — 이 보고가 옛 판정을 풀면 「따라가기」
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    arriveDuringTravel(rerender, second, 9, 4100);

    expect(toEnd).not.toHaveBeenCalled();
  });

  it('P9: 판정을 기다리는 중에 내가 보내면 버린다 — 보내는 동안 「최신으로」가 서지 않는다', async () => {
    const {rerender} = await pendingVerdict();
    rerender({jumpTarget: TO_NEWEST, selfSendToken: 1});
    scrollBy(0); // 전송이 끝으로 가는 도중의 보고

    expect(bottomPill()).toBeNull();
  });

  it('손가락: 기다리던 판정은 손가락의 첫 보고가 내린다 — 떠난 뒤 붙은 말이 수에 든다', async () => {
    const {rerender} = await pendingVerdict();
    rerender({jumpTarget: TO_NEWEST, messages: upTo(9)});
    fireEvent(list(), 'scrollBeginDrag');
    scrollBy(0); // 손가락이 과거에 머문다

    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');
  });

  it('손가락: 이동 도중에 잡아도 같다 — 점프가 떠난 순간이 기준선이다', async () => {
    jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => {});
    const far = {messageId: 'msg-2', seq: 2, token: 1};
    const {rerender} = await mountAtTheEnd();
    rerender({jumpTarget: far});
    await sleep(80);
    scrollBy(1200);
    await sleep(40);
    arriveDuringTravel(rerender, far, 9, 4100);
    fireEvent(list(), 'scrollBeginDrag');
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 1000},
        contentSize: {height: 4100, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });

    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');
  });
});

describe('연쇄 점프는 앞 이동이 떠난 순간을 물려받는다 (#2618 N-1)', () => {
  // 끝나지 않은 이동을 새 점프가 거두면, 앞 이동은 판정 없이 사라지고 필 쪽은 여전히
  // 「바닥」이다. 새 점프가 떠난 순간을 다시 잡으면 앞 이동 동안 붙은 말을 보지 못한다.
  beforeEach(() => {
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
  });

  async function firstJumpWithArrival() {
    const {rerender} = await mountAtTheEnd();
    const first = {messageId: 'msg-2', seq: 2, token: 1};
    rerender({jumpTarget: first});
    await sleep(80);
    scrollBy(1200);
    await sleep(40);
    arriveDuringTravel(rerender, first, 9, 4100); // 첫 이동 중에 붙는다
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y: 1200},
        contentSize: {height: 4100, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    await sleep(60);
    return rerender;
  }

  function landAt(y: number) {
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y},
        contentSize: {height: 4100, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
  }

  it('N5a: 둘째 점프가 끝에서 100pt 앞에 앉으면, 첫 이동 중 붙은 말까지 메운다', async () => {
    const rerender = await firstJumpWithArrival();
    const second = {messageId: 'msg-7', seq: 7, token: 2};
    const toEnd = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    rerender({jumpTarget: second, messages: upTo(9)});
    await sleep(60);
    landAt(3200); // 4100 − 3200 − 800 = 100
    await sleep(500);

    expect(toEnd).toHaveBeenCalledWith({animated: true});
    expect(bottomPill()).toBeNull();
  });

  it('N5b: 둘째 점프가 멀리 앉으면, 첫 이동 중 붙은 말이 수에 든다', async () => {
    const rerender = await firstJumpWithArrival();
    const second = {messageId: 'msg-4', seq: 4, token: 2};
    rerender({jumpTarget: second, messages: upTo(9)});
    await sleep(60);
    landAt(2000);
    await sleep(500);

    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');
  });

  it('판정을 기다리던 이동도 같다 — 기하 전에 붙은 말은 다음 점프가 멀리 앉으면 수에 든다', async () => {
    // 기다리는 판정(#2608 M-C)도 끝나지 않은 판정이다. 필 쪽은 첫 점프가 떠난 뒤로 아직
    // 한 번도 판정되지 않았다.
    const {rerender} = await pendingVerdict();
    rerender({messages: upTo(9)}); // 기하 보고 전에 붙는다 — 판정은 계속 기다린다
    rerender({jumpTarget: {messageId: 'msg-4', seq: 4, token: 2}, messages: upTo(9)});
    await sleep(60);
    landAt(2000);
    await sleep(500);

    expect(pillSentence('jump-latest')).toBe('새 메시지 1개 보기');
  });

  it('방을 옮기며 떠난 점프는 앞 방의 이동을 물려받지 않는다 — seq 는 방마다 따로 매긴다', async () => {
    const rerender = await firstJumpWithArrival(); // 방 ch 에서 이동 중(떠난 순간 8)
    // 가장 나쁜 순서: 방 전환과 새 방의 점프가 한 커밋에 온다.
    rerender({
      channelId: 'ch-b',
      messages: ROOM_B,
      lastReadSeq: 104,
      jumpTarget: {messageId: 'msg-102', seq: 102, token: 2},
    });
    await sleep(60);
    landAt(2000);
    await sleep(500);

    // 앞 방의 8 을 물려받으면 방 B 의 101–104 를 세어 「새 메시지 4개 보기」가 된다.
    expect(pillSentence('jump-latest')).toBe('최신 메시지로 이동');
  });
});

describe('메우기를 걸었으면 초점은 활강이 끝난 뒤에 옮긴다 (#2618 N-2)', () => {
  it('N1b: 「안읽음으로」가 끝 근처에 앉는 동안 말이 붙으면, 메우기 활강 뒤에 초점이 간다', async () => {
    // 움직이는 행에 초점을 주면 VoiceOver 가 그 행을 보이게 한 번 더 스크롤하고, 붙은
    // 말은 다시 접힌 아래로 간다. 「최신으로」가 `GLIDE_SETTLE_MS` 를 기다리는 이유와 같다.
    const events: Array<[string, number]> = [];
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {
        events.push(['toEnd', Date.now()]);
      });
    jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {
        events.push(['focus', Date.now()]);
      });
    const {rerender} = mount({channelId: 'ch', lastReadSeq: 6, unreadCount: 2});
    await settleAtBottom();
    events.length = 0;
    reportDividerAbove();
    fireEvent.press(screen.getByTestId('jump-unread'));
    for (const y of [3190, 3175]) {
      await sleep(60);
      scrollBy(y);
    }
    await sleep(40);
    arriveDuringTravel(rerender, undefined, 9, 4060); // 이동 중에 +60pt
    for (const y of [3160, 3150]) {
      fireEvent.scroll(list(), {
        nativeEvent: {
          contentOffset: {y},
          contentSize: {height: 4060, width: 390},
          layoutMeasurement: {height: 800, width: 390},
        },
      });
      await sleep(30);
    }
    await waitFor(
      () => expect(events.filter(([what]) => what === 'focus')).toHaveLength(1),
      {timeout: 2000},
    );

    const glideAt = events.find(([what]) => what === 'toEnd')?.[1];
    const focusAt = events.find(([what]) => what === 'focus')?.[1];
    expect(glideAt).toBeDefined();
    expect(focusAt! - glideAt!).toBeGreaterThanOrEqual(300);
  });

  it('메우기가 없으면 초점은 이동이 끝나는 대로 간다 — 기다리지 않는다', async () => {
    const events: Array<[string, number]> = [];
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => {});
    jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {
        events.push(['focus', Date.now()]);
      });
    mount({channelId: 'ch', lastReadSeq: 6, unreadCount: 2});
    await settleAtBottom();
    reportDividerAbove();
    const pressedAt = Date.now();
    fireEvent.press(screen.getByTestId('jump-unread'));
    scrollBy(3150); // 한 번에 앉는다
    await waitFor(() => expect(events).toHaveLength(1), {timeout: 2000});

    // 이동은 마지막 보고 250ms 뒤에 끝난다. 활강을 기다렸다면 600ms 를 넘긴다.
    expect(events[0][1] - pressedAt).toBeLessThan(550);
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

  it('끝에 닿지 못한 「최신으로」도 초점을 가장 아래 메시지로 옮긴다 (R2 N-C)', async () => {
    // 수렴이 끝에 못 닿고 풀려도(`release(false)`) 누른 필은 이미 사라졌다 —
    // VoiceOver 초점이 갈 곳이 있어야 한다.
    const focus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {});
    mount();
    await settleAtBottom();
    scrollUpIntoHistory();
    fireEvent.press(screen.getByTestId('jump-latest'));
    // 도착 보고가 없다 — 수렴은 진전 없이 400ms 뒤 손을 놓는다.
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

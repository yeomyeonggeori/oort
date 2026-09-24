import type {Message, RosterMember} from '@momo/core/lib/api';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import type {FlatList} from 'react-native';

import {Timeline, type PillState} from '../src/features/conversation/Timeline';

// =============================================================================
// 옛 페이지 문은 「앉았다」와 함께 열린다 — 어느 길로 앉았든 (#2680 R1 H-1)
//
// #2604 의 D(`olderReady`)는 옛 페이지를 진입이 앉은 뒤에만 부른다. 문을 여는 것은
// `settleEntry()` 이고, 그 함수는 `entrySettledRef` 가 이미 참이면 첫 줄에서 돌아간다.
// 그런데 「안읽음」 필(`jumpToUnread`)이 그 ref 를 **직접** 참으로 썼다. 진입이 앉기
// 전에 필을 누르면 문은 닫힌 채 ref 만 참이 되고, 그 뒤의 착지·손가락·풀림이 부르는
// `settleEntry()` 가 모두 헛돈다 — 방을 나갈 때까지 옛 페이지가 불리지 않는다.
//
// 닿을 수 있는 틈이다. 필은 앉음을 기다리지 않고(구분선이 창 위에 있으면 선다), Q 가
// 앉는 시점을 콘텐츠가 150ms 멈춘 뒤로 늦췄다(Release 195–290ms, 콘텐츠가 계속 바뀌면
// 4s 까지). 그리고 조용히 실패한다 — 목록 맨 위에 스피너도 「대화의 시작입니다」도 없이
// 마지막으로 받은 행에서 그냥 끝난다.
//
// 이 파일은 design-review R1 의 재현 시험을 옮긴 것이다(판정과 단언만 다듬었다). 수리
// 전 코드에서 첫 시험은 `{wiredAfterLanding: false, wiredAfterFingerAtTop: false,
// olderCalls: 0}` 로 빨갛다. 이중 없이 스크롤 보고만 준다 — 문이 붙었는지(`onStartReached`
// 가 목록에 있는지)와 실제로 불렸는지가 이 결함의 전부라서다. 기하까지 싣는 판은
// `timelineEntryEnd.test.tsx` 의 「안읽음 방」 시험이다.
// =============================================================================

// 착지 뒤 VoiceOver 초점 이동(`focusRow`)이 노드 핸들을 찾는다 — 시험 렌더러에는 없다.
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
    handle: 'h',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재'}),
  member({id: OTHER, displayName: '김인턴'}),
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

/** 3번까지 읽었고 다섯이 안 읽혔다 — 구분선이 4번 앞에 선다. */
const HISTORY = [1, 2, 3, 4, 5, 6, 7, 8].map(message);

const list = () => screen.getByTestId('timeline-list');

async function sleep(ms: number) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

function scrollTo(y: number) {
  fireEvent.scroll(list(), {
    nativeEvent: {
      contentOffset: {y},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
}

/** 구분선이 창 **위쪽 밖**: 구분선 아래 두 행부터 끝까지가 보인다 — 위 필이 선다. */
function reportDividerAbove() {
  const data = list().props.data as {key: string; kind: string}[];
  const divider = data.findIndex(item => item.kind === 'unread');
  if (divider < 0) throw new Error('no unread divider');
  const viewableItems = data
    .slice(divider + 2)
    .map((item, offset) => ({item, key: item.key, index: divider + 2 + offset, isViewable: true}));
  act(() => {
    list().props.onViewableItemsChanged({viewableItems, changed: viewableItems});
  });
}

function mount(onStartReached: () => void, pills: React.MutableRefObject<PillState | null>) {
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as React.MutableRefObject<
    FlatList<TimelineStreamItem> | null
  >;
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
      reachedStart={false}
      onStartReached={onStartReached}
      jumpPills
      listRef={listRef}
      pillsRef={pills}
    />,
  );
}

afterEach(() => cleanup());

/** 진입을 시작하고, 필을 누르고(앉기 전이거나 뒤), 착지를 기다리고, 손가락으로 맨 위에 간다. */
async function pillThenTop(pressBeforeSettle: boolean) {
  const onStartReached = jest.fn();
  const pills: React.MutableRefObject<PillState | null> = {current: null};
  mount(onStartReached, pills);
  fireEvent(list(), 'contentSizeChange', 390, 4000); // 진입이 시작된다
  scrollTo(3200);
  await sleep(0);
  if (!pressBeforeSettle) {
    for (let waited = 0; waited < 2000 && pills.current?.settled !== true; waited += 20) {
      await sleep(20);
    }
  }
  const settledAtPress = pills.current?.settled === true;
  reportDividerAbove();
  fireEvent.press(screen.getByTestId('jump-unread'));
  await sleep(2500); // 점프가 착지하거나 1500ms 한도에 닿고, 유지가 있으면 끝난다
  const wiredAfterLanding = typeof list().props.onStartReached === 'function';
  fireEvent(list(), 'scrollBeginDrag'); // 사람이 목록을 잡고 위로 읽어 올라간다
  scrollTo(600);
  scrollTo(0);
  await sleep(300);
  return {
    settledAtPress,
    wiredAfterLanding,
    wiredAfterFingerAtTop: typeof list().props.onStartReached === 'function',
    olderCalls: onStartReached.mock.calls.length,
  };
}

describe('옛 페이지 문 — 「안읽음」 필을 거쳐 앉아도 열린다 (#2680 R1 H-1)', () => {
  it('진입이 앉기 전에 필을 눌러도, 사람이 맨 위에 닿으면 옛 페이지를 부른다', async () => {
    const out = await pillThenTop(true);

    expect(out).toEqual({
      settledAtPress: false, // 누름이 정말 앉기 전이었다
      wiredAfterLanding: true,
      wiredAfterFingerAtTop: true,
      olderCalls: 1,
    });
  });

  it('대조 — 진입이 앉은 뒤에 필을 눌러도 같다', async () => {
    const out = await pillThenTop(false);

    expect(out).toEqual({
      settledAtPress: true,
      wiredAfterLanding: true,
      wiredAfterFingerAtTop: true,
      olderCalls: 1,
    });
  });

  it('필 없이 — 진입이 앉기 전에 손가락으로 곧장 맨 위에 가도 부른다', async () => {
    const onStartReached = jest.fn();
    const pills: React.MutableRefObject<PillState | null> = {current: null};
    mount(onStartReached, pills);
    fireEvent(list(), 'contentSizeChange', 390, 4000);
    scrollTo(3200);
    await sleep(0);
    const settledAtFinger = pills.current?.settled === true;
    fireEvent(list(), 'scrollBeginDrag');
    scrollTo(1600);
    await sleep(20);
    scrollTo(0);
    await sleep(300);

    expect(settledAtFinger).toBe(false);
    expect(onStartReached).toHaveBeenCalled();
  });
});

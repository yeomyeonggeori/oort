import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {FlatList, type View} from 'react-native';

import {Timeline} from '../src/features/conversation/Timeline';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 앱에 돌아올 때 대화 목록이 위에서 아래로 빠르게 훑는 현상 (#4949, owner 10-31, v0.1.41).
//
// ## 원인
//
// 목록의 `refreshControl` prop 이 `undefined` ↔ 요소로 뒤집혔다(`pullEnabled` 가 연결 상태를 따랐다 — 복구
// 중에는 이력이 남은 방도 당겨서 다시 맞춘다, #4783). RN 0.86 iOS `ScrollView` 는 컨트롤이 있으면
// `{refreshControl}{contentContainer}` 두 자식을, 없으면 `{contentContainer}` 하나를 그린다
// (`ScrollView.js` 1838~1858). 자식의 모양이 바뀌면 React 는 첫 자리가 달라졌다고 보고 **내용 컨테이너를 통째로
// 내렸다 다시 세운다** — 모든 행이 다시 마운트되고, 바닥을 따라가던 목록은 새 컨테이너의 첫
// `onContentSizeChange` 에서 끝으로 활강한다(`followGlide`, 애니메이션 `scrollToOffset`).
// 앱 복귀는 소켓을 일부러 다시 열어(`resume`) 연결이 `connecting` → `connected` 로 흔들리고, 이력이 긴 방
// (`reachedStart` 거짓)은 그 두 번에 두 번 뒤집혔다. 이력을 다 읽은 방은 늘 켜져 있어 겪지 않았다.
//
// ## 이 파일이 재는 것
//
// 제스트의 기본 `ScrollView` 모형은 `[refreshControl, <View>]` 두 자리를 **늘 고정해** 그려서 이 차이를 숨긴다
// (`@react-native/jest-preset/jest/mocks/ScrollView.js`). 그래서 이 파일은 모형을 걷고 **RN 의 실제 ScrollView**
// 를 올린다 — 자식 모양은 RN 자신의 코드가 정한다. 내용 컨테이너가 다시 마운트됐는지는 목록 꼬리 노드의 ref
// 부착 횟수로 센다(꼬리는 내용 컨테이너 안에 있다).
//
// 네이티브는 새로 선 내용 컨테이너의 첫 레이아웃을 알린다(실제 ScrollView 에서는 내용 컨테이너의 `onLayout` →
// `onContentSizeChange`). 제스트에는 그 보고가 없어(`conversationSteady` 의 `startProbe` 와 같은 사정) 재마운트가
// 일어난 횟수만큼 손으로 낸다 — 재마운트가 없으면 낼 보고도 없다.
//
// RNTL 의 `fireEvent` 는 쓰지 않는다: 실제 ScrollView 는 응답자(`onStartShouldSetResponder`)를 달아 두고 RNTL 은
// 그것이 「시작하지 않겠다」고 답하면 이벤트를 꺼진 것으로 본다 — 기본 모형에는 그 prop 이 없어 닿던 이벤트가
// 여기서는 핸들러에 닿지 못한다. 그래서 네이티브가 하는 보고를 호스트의 핸들러를 직접 불러 대신한다.
// =============================================================================

jest.mock('react-native/Libraries/Components/ScrollView/ScrollView', () =>
  jest.requireActual('react-native/Libraries/Components/ScrollView/ScrollView'),
);

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;

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

const HISTORY = Array.from({length: 12}, (_, i) => message(i + 1));
const CONTENT_HEIGHT = 4000;
const VIEWPORT = {height: 800, width: 390};

/** 꼬리 노드가 **붙은** 횟수를 세는 ref — 내용 컨테이너가 다시 서면 꼬리도 다시 붙는다. */
function countingTailRef() {
  let node: View | null = null;
  let attaches = 0;
  const ref = {
    get current(): View | null {
      return node;
    },
    set current(next: View | null) {
      if (next !== null) attaches += 1;
      node = next;
    },
  } as React.MutableRefObject<View | null>;
  return {ref, attaches: () => attaches};
}

interface Props {
  realtimeConnected: boolean;
  reachedStart?: boolean;
  messages?: Message[];
  onRefresh?: () => Promise<void>;
}

function mount(initial: Props) {
  const tail = countingTailRef();
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as React.MutableRefObject<
    FlatList<TimelineStreamItem> | null
  >;
  const onRefresh = async () => {};
  const element = (props: Props) => (
    <Timeline
      messages={props.messages ?? HISTORY}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS}
      reachedStart={props.reachedStart ?? false}
      realtimeConnected={props.realtimeConnected}
      onRefresh={'onRefresh' in props ? props.onRefresh : onRefresh}
      tailRef={tail.ref}
      listRef={listRef}
    />
  );
  const view = render(element(initial));
  return {
    tail,
    listRef,
    update: (next: Props) => act(() => view.rerender(element(next))),
  };
}

const list = () => screen.getByTestId('timeline-list');

type Handler = (event: unknown) => void;
const handlerOf = (name: string) => (list().props as Record<string, Handler>)[name];

/** 네이티브가 하는 보고 셋 — 뷰포트(`onLayout`) · 내용 길이(내용 컨테이너 `onLayout`) · 스크롤 위치(`onScroll`). */
function reportViewport() {
  act(() => handlerOf('onLayout')({nativeEvent: {layout: {x: 0, y: 0, ...VIEWPORT}}}));
}
function reportContent(height: number) {
  // 실제 ScrollView 는 내용 컨테이너의 `onLayout` 으로 `onContentSizeChange` 를 부른다. 컨테이너는 목록 호스트 아래 첫
  // `onLayout` 달린 호스트다(재마운트되면 새것이 서므로 부를 때마다 다시 찾는다).
  const container = list().findAll(
    (node: {type: unknown; props: Record<string, unknown>}) =>
      typeof node.type === 'string' && node !== (list() as unknown) && typeof node.props.onLayout === 'function',
  )[0];
  act(() => container.props.onLayout({nativeEvent: {layout: {x: 0, y: 0, width: 390, height}}}));
}
function reportScroll(y: number, height = CONTENT_HEIGHT) {
  act(() =>
    handlerOf('onScroll')({
      nativeEvent: {
        contentOffset: {y},
        contentSize: {height, width: 390},
        layoutMeasurement: VIEWPORT,
      },
    }),
  );
}

/** 목록이 끝에 앉아 있다고 알린다 — 바닥을 따라가는 상태(`following`)로 만든다. */
async function settleAtBottom() {
  reportViewport();
  reportContent(CONTENT_HEIGHT);
  reportScroll(CONTENT_HEIGHT - VIEWPORT.height);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1_000); // 진입 수렴이 손을 돌려줄 때까지
  });
}

/** 컨트롤이 당김을 받는가 — 실제 컨트롤만 `onRefresh` 를 든다. 빈 자리는 요소지만 받지 않는다. */
const pullIsLive = () =>
  typeof (list().props.refreshControl as {props?: {onRefresh?: unknown}} | undefined)?.props
    ?.onRefresh === 'function';

beforeEach(() => {
  installAppClock();
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('복귀 때 연결이 흔들려도 대화 목록은 다시 서지 않는다 (#4949)', () => {
  it('이력이 남은 방에서 연결 복구가 시작되고 끝나도 내용 컨테이너는 그대로이고 스크롤 명령이 나가지 않는다', async () => {
    const view = mount({realtimeConnected: true});
    const toEnd = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => {});
    const toOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    await settleAtBottom();
    expect(pullIsLive()).toBe(false); // 연결됐고 읽을 이력이 남았으니 당김은 닫혀 있다.
    const mountedOnce = view.tail.attaches();
    toEnd.mockClear();
    toOffset.mockClear();

    // 앱 복귀: 소켓을 다시 열어 연결이 끊겼다 이어진다 — 복구 시작과 끝, 두 번. 네이티브가 새로 선 컨테이너의
    // 첫 레이아웃을 알리는 것을 재마운트가 있었던 만큼만 손으로 낸다.
    for (const realtimeConnected of [false, true]) {
      const before = view.tail.attaches();
      view.update({realtimeConnected});
      for (let remount = before; remount < view.tail.attaches(); remount += 1) {
        reportContent(CONTENT_HEIGHT);
      }
      expect(pullIsLive()).toBe(!realtimeConnected); // 복구 중에는 당김이 열린다(#4783).
    }

    // 내용 컨테이너(와 그 안의 모든 행)는 한 번도 다시 마운트되지 않았고,
    expect(view.tail.attaches()).toBe(mountedOnce);
    // 그래서 목록이 낸 스크롤 명령도 없다 — 오프셋 명령도, 애니메이션 활강도.
    expect(toOffset).not.toHaveBeenCalled();
    expect(toEnd).not.toHaveBeenCalled();

    // 반대쪽: 바닥을 따라가는 상태는 살아 있다 — 그 뒤 새 행이 오면 그 행으로 따라간다. 위의 0 이 「스크롤을
    // 아예 못 내서 0」이 아니다.
    view.update({realtimeConnected: true, messages: [...HISTORY, message(13)]});
    reportContent(CONTENT_HEIGHT + 120);
    expect(toOffset).toHaveBeenCalledWith({offset: CONTENT_HEIGHT + 120 - VIEWPORT.height, animated: true});
    // 깨뜨리면: `Timeline` 의 `refreshControl` 을 `pullEnabled ? refreshControl : undefined` 로 되돌리면 꼬리 부착이
    //          3 번이 되고(위 두 단정), 재마운트마다 낸 보고가 활강을 부른다 — 첫 단정부터 빨갛다.
  });

  it('당김의 문은 그대로다 — 이력이 남았으면 연결됐을 때 닫히고 복구 중에는 열린다', () => {
    const view = mount({realtimeConnected: false});
    expect(pullIsLive()).toBe(true);
    view.update({realtimeConnected: true});
    expect(pullIsLive()).toBe(false);
    // 닫혀도 자리는 비어 있지 않다(요소는 있고 당김을 받지 않는다) — 비우면 위 시험의 재마운트가 돌아온다.
    expect(list().props.refreshControl).toBeTruthy();
    // 이력을 다 읽었으면 연결돼 있어도 열려 있다.
    view.update({realtimeConnected: true, reachedStart: true});
    expect(pullIsLive()).toBe(true);
    // 깨뜨리면: `pullEnabled` 에서 `!realtimeConnected` 를 빼면 첫 단정이, `reachedStart` 검사를 빼면 둘째 단정이 빨갛다.
  });

  it('당길 곳이 없는 표면(`onRefresh` 없음 — 스레드 패널)에는 컨트롤 자체가 없다', () => {
    mount({realtimeConnected: false, onRefresh: undefined});
    expect(list().props.refreshControl).toBeUndefined();
  });
});

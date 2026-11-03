import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {FlatList, Share, type ShareAction, type View} from 'react-native';

import {Timeline} from '../src/features/conversation/Timeline';
import {resetShareSheetForTest, SHARE_SHEET_TAP_GRACE_MS} from '../src/lib/shareSheet';
import {ShareSheetTouchShield} from '../src/lib/ShareSheetTouchShield';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 첨부 내려받기 공유 시트가 열리고 닫혀도 대화 목록은 그 자리에 선다 (#5207, owner 11-03).
//
// 보고: 시트를 열 때마다 목록이 위로 크게 올랐다가 맨 아래로 내려오기를 두 번쯤 되풀이한다.
//
// ## 원인(시뮬레이터 실측, 인계 파일의 표)
//
// 시트 자체는 앱 상태를 바꾸지도(`AppState` 는 내내 `active`) 목록을 움직이지도 않는다 — 6 MB·58 MB 첨부 모두 내려받는 6초와 시트 여닫기 동안 스크롤 보고 0건이다. 목록을 훑게 만드는 것은
// 연결이 한 번 끊겼다 이어질 때 `refreshControl` 자리가 `undefined` ↔ 요소로 뒤집혀 내용 컨테이너가 통째로 다시 서는 일이다(#4949 의 원인, `Timeline.tsx` 의 `NoPullSlot`). 그 모양으로 되돌린
// 코드에서 하네스가 연결 흔들림 한 번(= 두 번 뒤집힘)을 얹으면 목록이 두 번 맨 위(y≈481)로 올랐다 맨 아래(y≈1549)로 내려왔다 — 보고된 「두 번쯤 되풀이」와 같은 모양이다. 합친 머리에는
// #4949 의 수리가 이미 들어 있어 그 흔들림이 목록을 움직이지 않는다.
//
// ## 이 파일이 재는 것
//
// 공유 시트 한 주기(카드 탭 → 시트 열림 → **시트가 떠 있는 동안 연결 흔들림** → 시트 닫힘 → 막이 걷힘) 동안 ① 내용 컨테이너가 다시 마운트되지 않고(꼬리 노드 부착 횟수),
// ② 목록이 낸 스크롤 명령(오프셋·활강)이 없고, ③ 그 뒤에도 바닥을 따라가는 상태가 살아 있다. 막이(`ShareSheetTouchShield`)가 목록의 **형제**로 서고 걷히는 것도 이 주기에 들어 있다 —
// 막이가 서고 걷힐 때 목록이 다시 서면 안 된다.
//
// 기본 `ScrollView` 모형은 자식 모양을 고정해 그려서 재마운트를 숨긴다 — `timelinePullStable.test.tsx` 와 같이 RN 의 실제 `ScrollView` 를 올린다(그 파일의 머리말이 이유를 길게 말한다).
// =============================================================================

jest.mock('react-native/Libraries/Components/ScrollView/ScrollView', () =>
  jest.requireActual('react-native/Libraries/Components/ScrollView/ScrollView'),
);

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: {id: 'self'},
    signOut: jest.fn(),
  }),
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;
const DISMISSED: ShareAction = {action: Share.dismissedAction};

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

function message(seq: number, extra: Partial<Message> = {}): Message {
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
    ...extra,
  };
}

// 첫 화면 창 안(앞쪽 열 줄)에 영상 첨부 카드가 있다.
// 앱 안 재생(mp4·mov, #5208) 밖의 영상 — 파일 카드에서 공유 시트로 가는 길을 잰다.
const VIDEO = {id: 'att-video', name: 'v1.webm', mime: 'video/webm', sizeBytes: 61_235_000};
const HISTORY = Array.from({length: 12}, (_, i) => message(i + 1, i === 2 ? {attachments: [VIDEO]} : {}));
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

function mount(initial: {realtimeConnected: boolean; messages?: Message[]}) {
  const tail = countingTailRef();
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as React.MutableRefObject<
    FlatList<TimelineStreamItem> | null
  >;
  const onRefresh = async () => {};
  // 막이는 앱의 셸처럼 목록의 **형제**로 선다.
  const element = (props: {realtimeConnected: boolean; messages?: Message[]}) => (
    <>
      <Timeline
        messages={props.messages ?? HISTORY}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS}
        reachedStart={false}
        realtimeConnected={props.realtimeConnected}
        onRefresh={onRefresh}
        tailRef={tail.ref}
        listRef={listRef}
      />
      <ShareSheetTouchShield />
    </>
  );
  const view = render(element(initial));
  return {
    tail,
    update: (next: {realtimeConnected: boolean; messages?: Message[]}) => act(() => view.rerender(element(next))),
  };
}

const list = () => screen.getByTestId('timeline-list');
type Handler = (event: unknown) => void;
const handlerOf = (name: string) => (list().props as Record<string, Handler>)[name];

function reportViewport() {
  act(() => handlerOf('onLayout')({nativeEvent: {layout: {x: 0, y: 0, ...VIEWPORT}}}));
}
function reportContent(height: number) {
  const container = list().findAll(
    (node: {type: unknown; props: Record<string, unknown>}) =>
      typeof node.type === 'string' && node !== (list() as unknown) && typeof node.props.onLayout === 'function',
  )[0];
  act(() => container.props.onLayout({nativeEvent: {layout: {x: 0, y: 0, width: 390, height}}}));
}
function reportScroll(y: number, height = CONTENT_HEIGHT) {
  act(() =>
    handlerOf('onScroll')({
      nativeEvent: {contentOffset: {y}, contentSize: {height, width: 390}, layoutMeasurement: VIEWPORT},
    }),
  );
}
async function settleAtBottom() {
  reportViewport();
  reportContent(CONTENT_HEIGHT);
  reportScroll(CONTENT_HEIGHT - VIEWPORT.height);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1_000);
  });
}

beforeEach(() => {
  installAppClock();
  resetShareSheetForTest();
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('공유 시트 한 주기 동안 대화 목록은 그 자리에 선다 (#5207)', () => {
  it('시트가 떠 있는 동안 연결이 흔들려도, 막이가 서고 걷혀도 내용 컨테이너는 그대로이고 스크롤 명령이 나가지 않는다', async () => {
    const calls: Array<(result: ShareAction) => void> = [];
    jest.spyOn(Share, 'share').mockImplementation(
      () => new Promise<ShareAction>(resolve => calls.push(resolve)),
    );
    const view = mount({realtimeConnected: true});
    const toEnd = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => {});
    const toOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    await settleAtBottom();
    const mountedOnce = view.tail.attaches();
    toEnd.mockClear();
    toOffset.mockClear();

    // 카드를 눌러 시트를 연다(내려받기는 모형이 즉시 끝낸다). 막이가 목록의 형제로 선다.
    fireEvent.press(screen.getByTestId('attachment-item'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.getByTestId('share-sheet-touch-shield')).toBeTruthy();

    // 시트가 떠 있는 동안 연결이 한 번 끊겼다 이어진다 — 복구 시작과 끝, 두 번 뒤집힌다. 재마운트가 있었던 만큼만 새 컨테이너의 첫 레이아웃을 손으로 낸다.
    for (const realtimeConnected of [false, true]) {
      const before = view.tail.attaches();
      view.update({realtimeConnected});
      for (let remount = before; remount < view.tail.attaches(); remount += 1) {
        reportContent(CONTENT_HEIGHT);
      }
    }

    // 시트가 닫히고, 막이가 걷힌다.
    await act(async () => {
      calls[0](DISMISSED);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(SHARE_SHEET_TAP_GRACE_MS);
    });
    expect(screen.queryByTestId('share-sheet-touch-shield')).toBeNull();

    // 한 주기 내내 내용 컨테이너(와 안의 모든 행)는 다시 마운트되지 않았고, 목록이 낸 스크롤 명령도 없다.
    expect(view.tail.attaches()).toBe(mountedOnce);
    expect(toOffset).not.toHaveBeenCalled();
    expect(toEnd).not.toHaveBeenCalled();

    // 반대쪽: 바닥을 따라가는 상태는 살아 있다 — 그 뒤 새 행이 오면 그 행으로 따라간다. 위의 0 이 「스크롤을 아예 못 내서 0」이 아니다.
    view.update({realtimeConnected: true, messages: [...HISTORY, message(13)]});
    reportContent(CONTENT_HEIGHT + 120);
    expect(toOffset).toHaveBeenCalledWith({offset: CONTENT_HEIGHT + 120 - VIEWPORT.height, animated: true});
    // 깨뜨리면: `Timeline` 의 `refreshControl` 을 `pullEnabled ? refreshControl : undefined` 로 되돌리면 꼬리 부착이 늘고(첫 단정), 재마운트마다 낸 보고가 활강을 부른다.
  });
});

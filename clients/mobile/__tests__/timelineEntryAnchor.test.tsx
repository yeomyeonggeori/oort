import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import type {FlatList} from 'react-native';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';

import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// 채널을 열면 **제일 아래**다 (goal RN-B4a / #1025)
//
// 성재: *"채널에 진입을 하면 제일 하단으로 이동해야 하는데, 왜 자꾸 상단 어중간한
// 부분에서 진입되는 거야?"*
//
// 진단 먼저, 왜냐하면 티켓이 「읽던 위치 복원 정책과의 충돌」을 의심했기 때문이다.
// 그런 정책은 이 코드에 **없다** — `lastReadSeq` 는 안 읽은 구분선을 그리는 데만
// 쓰이고, 진입 앵커는 처음부터 `scrollToEnd` 하나였다. 그러니 고칠 것은 정책이
// 아니라, 그 한 번의 호출이 **닿지 못한다**는 사실이다:
//
//   진입 시점의 리스트는 첫 배치(기본 10행)만 측정돼 있고, `VirtualizedList` 는
//   `getItemLayout` 이 없으면 tail spacer 를 측정된 데까지로 일부러 자른다
//   (`VirtualizedList.js:1010`). 그래서 첫 `scrollToEnd` 는 **잘린 끝**에 착지한다 —
//   긴 대화라면 그 자리가 「상단 어중간한 부분」이다.
//
// 리스트는 착지한 자리에서 다음 배치를 재고, 콘텐츠가 자라고, 그것이 두 번째
// 기회다. 그 기회를 죽이고 있던 것이 `onScroll` 이었다. 자란 콘텐츠를 실은 스크롤
// 이벤트는 오프셋이 그대로여도 「끝에서 멀어졌다」로 계산되고, 임계값 120pt 는 한
// 배치(≈600pt)면 넘는다. 사람은 손도 대지 않았는데 `following` 이 꺼지고, 그 뒤로는
// 아무도 데려가지 않는다.
//
// 전송(RN-P3)이 이미 그 답을 갖고 있었다 — 핀 + 즉시 라운드 + 도착 판정. 이 파일이
// 재는 것은 **그 기계가 진입에도 걸려 있는가**다. 아래 첫 테스트가 결함 그 자체이고,
// 나머지는 그 수리가 지나치지 않았음을 잠근다(손가락은 언제나 이긴다).
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

/** 한 화면에 담기지 않는 대화. 진입 앵커가 문제가 되는 유일한 경우다. */
const HISTORY = Array.from({length: 60}, (_, i) => message(i + 1));

function mount() {
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as React.MutableRefObject<
    FlatList<TimelineStreamItem> | null
  >;
  render(
    <Timeline
      messages={HISTORY}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS}
      selfSendToken={0}
      listRef={listRef}
    />,
  );
  const spy = jest.spyOn(listRef.current!, 'scrollToEnd');
  fireEvent(screen.getByTestId('timeline-list'), 'layout', {
    nativeEvent: {layout: {width: 390, height: 800}},
  });
  return {listRef, spy};
}

function contentSize(height: number) {
  fireEvent(
    screen.getByTestId('timeline-list'),
    'contentSizeChange',
    390,
    height,
  );
}

function scrolled(offsetY: number, contentHeight: number) {
  fireEvent.scroll(screen.getByTestId('timeline-list'), {
    nativeEvent: {
      contentOffset: {y: offsetY},
      contentSize: {height: contentHeight, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
}

async function flushFrame() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

afterEach(cleanup);

describe('채널을 열면 최신 메시지 앞이다', () => {
  it('첫 콘텐츠 보고에 곧바로 끝으로 간다', () => {
    const {spy} = mount();
    contentSize(900);
    expect(spy).toHaveBeenCalled();
  });

  it('활강하지 않는다 — 열린 채널은 이미 끝에 있는 것이지 끝으로 가는 중이 아니다', async () => {
    // 진입에서 애니메이션은 두 번 틀린다. 사람이 「어중간한 위쪽」을 실제로 보게
    // 되고(그것이 성재가 본 화면이다), 그 활강의 중간 지점이 곧바로 `following` 을
    // 끄는 스크롤 이벤트가 된다.
    const {spy} = mount();
    contentSize(900);
    await flushFrame();
    expect(spy).toHaveBeenCalled();
    for (const [options] of spy.mock.calls) {
      expect(options).toEqual({animated: false});
    }
  });

  // ===========================================================================
  // 결함 그 자체.
  //
  // 잘린 끝(900pt)에 착지한 뒤 다음 배치가 측정되며 진짜 콘텐츠(1600pt)가 드러난다.
  // 그 사실은 **스크롤 이벤트로 먼저** 도착하고, 오프셋은 그대로이므로 계산되는
  // 「끝까지의 거리」는 700pt — 임계값 120pt 를 넘는다. 이 한 줄이 없으면 그 이벤트가
  // `following` 을 끄고, 뒤이어 온 `contentSizeChange` 는 아무 일도 하지 않는다.
  // 사람은 유리에 손을 댄 적이 없는데 대화의 위쪽 어딘가에 서 있게 된다.
  // ===========================================================================
  it('뒤늦게 드러난 끝까지 계속 데려간다', () => {
    const {spy} = mount();
    contentSize(900);
    spy.mockClear();

    scrolled(100, 900); // 잘린 끝에 착지 — 이 시점의 거리는 0이다
    scrolled(100, 1600); // 배치가 측정되며 진짜 끝이 드러난다 — 거리 700

    contentSize(1600);

    expect(spy).toHaveBeenCalled();
  });

  it('여러 배치가 이어져도 끝까지 간다', () => {
    const {spy} = mount();
    contentSize(900);

    for (const height of [1600, 2300, 3000, 3700]) {
      spy.mockClear();
      scrolled(height - 1500, height);
      contentSize(height);
      expect(spy).toHaveBeenCalled();
    }
  });
});

describe('그래도 손가락이 이긴다', () => {
  it('진입 직후라도 리스트를 잡으면 앵커는 자리를 내준다', () => {
    // 수리가 「진입 뒤 400ms 는 무조건 바닥으로」가 되면 이 배치가 고치려는 것과
    // 정반대의 결함이 생긴다 — 열자마자 위로 올라가 읽으려는 사람을 도로 끌어내리는
    // 것. 마감시각은 의도에 대한 추측이지만 끄는 손가락은 아니다.
    const {spy} = mount();
    contentSize(900);
    spy.mockClear();

    fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag', {
      nativeEvent: {
        contentOffset: {y: 100},
        contentSize: {height: 900, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
    scrolled(0, 4000); // 위로 올라가 읽는다

    contentSize(4600);

    expect(spy).not.toHaveBeenCalled();
  });

  it('앵커가 끝난 뒤에는 위에 있는 사람을 남이 말했다고 데려가지 않는다', async () => {
    const {spy} = mount();
    contentSize(900);
    scrolled(100, 900); // 도착 — 앵커가 스크롤을 돌려준다
    await flushFrame();
    spy.mockClear();

    scrolled(0, 4000); // 이제 이것은 진짜로 사람이 올라간 것이다
    contentSize(4300);

    expect(spy).not.toHaveBeenCalled();
  });
});

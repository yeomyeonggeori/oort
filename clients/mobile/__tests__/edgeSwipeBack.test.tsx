import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import React from 'react';
import {Text, View, type NativeTouchEvent} from 'react-native';

import {Composer} from '../src/features/conversation/Composer';
import {Timeline} from '../src/features/conversation/Timeline';
import {EdgeSwipeBack} from '../src/nav/EdgeSwipeBack';
import {ACTIVATE_PX, MAX_SETTLE_MS} from '../src/nav/edgeSwipe';

// =============================================================================
// 배선: 규칙이 실제로 **화면을 움직이는가**.
//
// `edgeSwipe.test.ts` 가 판정을 증명한다. 이 파일이 증명하는 것은 그 판정이
// `PanResponder` 에 옳게 묶여 있다는 것, 그리고 이 배치의 요구 중 테스트로만 지킬 수
// 있는 두 가지다:
//
//   * **화면이 손가락을 따라 움직인다.** 임계를 넘겼을 때 툭 바꾸는 구현은 뒤로가기가
//     아니라 순간이동이다. 그래서 드래그 도중의 위치를 매 프레임 읽어 손가락과
//     같은지 본다 — 「따라간다」를 눈이 아니라 숫자로 확인하는 유일한 방법이다.
//   * **겹치면 안쪽이 이긴다.** 스레드는 대화 안에 그려지고 capture 는 바깥이
//     먼저이므로, 아무 조치가 없으면 스레드를 열어 둔 채 민 손가락이 대화를 닫는다.
//
// 그리고 마지막 describe 가 이 배치의 진짜 관문이다: 래퍼를 씌운 **진짜 타임라인**에서
// 길게 누르기가 여전히 시트를 연다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;
const WIDTH = 750; // react-native 의 jest 기본 화면 너비

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

const MESSAGE: Message = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  channelId: 'ch',
  seq: 10,
  hlcTs: 1,
  hlcCount: 0,
  authorMemberId: OTHER,
  type: 'text',
  body: '배포는 금요일에 합니다.',
  state: 'sent',
  createdAtMs: BASE_MS,
};

// -----------------------------------------------------------------------------
// 손가락 하나. React Native 의 responder 시스템이 뷰에게 하는 호출을 그대로 한다.
//
// `fireEvent` 가 아니라 prop 을 직접 부르는 이유: 이 제스처의 판정은 **capture 단계**에
// 있고(그래야 밑의 스크롤뷰보다 먼저 질문을 받는다), 그 단계는 테스트 라이브러리의
// 이벤트 이름으로는 정확히 재현되지 않는다. `PanResponder` 는 `event.touchHistory` 로
// 자기 상태를 갱신하므로 그것도 진짜 모양으로 만들어 준다.
// -----------------------------------------------------------------------------
interface Sample {
  x: number;
  y: number;
  t: number;
}

function finger(target: {props: Record<string, (event: unknown) => unknown>}) {
  let start: Sample = {x: 0, y: 0, t: 0};
  let previous: Sample = start;
  let current: Sample = start;
  let clock = 1_000;
  let active = true;
  let granted = false;

  function event() {
    const touch = {
      identifier: 0,
      target: 1,
      pageX: current.x,
      pageY: current.y,
      locationX: current.x,
      locationY: current.y,
      timestamp: current.t,
    } as unknown as NativeTouchEvent;
    return {
      nativeEvent: {
        ...touch,
        touches: active ? [touch] : [],
        changedTouches: [touch],
        timestamp: current.t,
      },
      touchHistory: {
        touchBank: [
          {
            touchActive: active,
            startPageX: start.x,
            startPageY: start.y,
            startTimeStamp: start.t,
            currentPageX: current.x,
            currentPageY: current.y,
            currentTimeStamp: current.t,
            previousPageX: previous.x,
            previousPageY: previous.y,
            previousTimeStamp: previous.t,
          },
        ],
        numberActiveTouches: active ? 1 : 0,
        indexOfSingleActiveTouch: 0,
        mostRecentTimeStamp: current.t,
      },
    };
  }

  return {
    /** 화면에 손가락이 닿았다. */
    down(x: number, y: number) {
      clock += 16;
      start = {x, y, t: clock};
      previous = start;
      current = start;
      active = true;
      granted = false;
      act(() => {
        target.props.onStartShouldSetResponderCapture?.(event());
      });
    },
    /** 손가락이 움직였다. 가져갔으면 true. */
    move(x: number, y: number, dt = 16): boolean {
      clock += dt;
      previous = current;
      current = {x, y, t: clock};
      let claimed = false;
      act(() => {
        if (!granted) {
          claimed = Boolean(
            target.props.onMoveShouldSetResponderCapture?.(event()),
          );
          if (claimed) {
            granted = true;
            target.props.onResponderGrant?.(event());
          }
        } else {
          target.props.onResponderMove?.(event());
        }
      });
      return claimed;
    },
    /** 손가락을 뗐다. */
    up() {
      active = false;
      act(() => {
        target.props.onResponderRelease?.(event());
      });
    },
    get granted() {
      return granted;
    },
  };
}

function pane(testID = 'edge-swipe-pane') {
  return screen.getByTestId(testID) as unknown as {
    props: Record<string, (event: unknown) => unknown>;
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  cleanup();
});

/** 미끄러짐이 끝나고 커밋 타이머가 울릴 때까지. */
function settle() {
  act(() => {
    jest.advanceTimersByTime(MAX_SETTLE_MS + 32);
  });
}

// -----------------------------------------------------------------------------

describe('화면이 손가락을 따라 움직인다', () => {
  it('민 만큼 가 있다 — 매 프레임', () => {
    // 이것이 이 배치의 요구 그 자체다. "끝나고 툭 넘어가는 건 뒤로가기가 아니라
    // 순간이동이다."
    const at = {current: null as number | null};
    const onBack = jest.fn();
    render(
      <EdgeSwipeBack onBack={onBack} progressRef={at}>
        <Text>대화</Text>
      </EdgeSwipeBack>,
    );
    const touch = finger(pane());

    touch.down(6, 400);
    expect(at.current).toBeNull(); // 아직 아무 데도 안 갔다

    // 문턱을 넘는 순간 손가락이 가 있는 만큼에서 시작한다.
    touch.move(6 + ACTIVATE_PX, 400);
    expect(at.current).toBe(ACTIVATE_PX);

    // 그 뒤로는 손가락과 같이 간다.
    for (const dx of [40, 90, 160, 240]) {
      touch.move(6 + dx, 400);
      expect(at.current).toBe(dx);
    }

    // 되돌리면 화면도 되돌아온다 — 진행 중에 취소할 수 있다는 것이 절반이다.
    touch.move(6 + 120, 400);
    expect(at.current).toBe(120);
  });

  it('문턱을 넘기 전에는 화면이 꼼짝도 하지 않는다', () => {
    const at = {current: null as number | null};
    render(
      <EdgeSwipeBack onBack={jest.fn()} progressRef={at}>
        <Text>대화</Text>
      </EdgeSwipeBack>,
    );
    const touch = finger(pane());
    touch.down(6, 400);
    touch.move(6 + ACTIVATE_PX - 1, 400);
    expect(touch.granted).toBe(false);
    expect(at.current).toBeNull();
  });
});

describe('놓았을 때', () => {
  it('충분히 밀었으면 뒤로 간다', () => {
    const onBack = jest.fn();
    render(
      <EdgeSwipeBack onBack={onBack}>
        <Text>대화</Text>
      </EdgeSwipeBack>,
    );
    const touch = finger(pane());
    touch.down(6, 400);
    touch.move(200, 400);
    touch.move(500, 400);
    touch.up();

    expect(onBack).not.toHaveBeenCalled(); // 미끄러지는 동안에는 아직
    settle();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('조금 밀다 놓으면 아무 일도 없다', () => {
    const onBack = jest.fn();
    const at = {current: null as number | null};
    render(
      <EdgeSwipeBack onBack={onBack} progressRef={at}>
        <Text>대화</Text>
      </EdgeSwipeBack>,
    );
    const touch = finger(pane());
    touch.down(6, 400);
    touch.move(60, 400);
    touch.up();

    settle();
    expect(onBack).not.toHaveBeenCalled();
    expect(at.current).toBe(0); // 제자리로 돌아왔다
  });

  it('세로로 그으면 잡지도 않고 뒤로도 안 간다', () => {
    const onBack = jest.fn();
    render(
      <EdgeSwipeBack onBack={onBack}>
        <Text>대화</Text>
      </EdgeSwipeBack>,
    );
    const touch = finger(pane());
    touch.down(6, 600);
    touch.move(8, 500);
    touch.move(10, 380);
    expect(touch.granted).toBe(false);
    settle();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('가운데서 시작한 드래그는 잡지 않는다', () => {
    const onBack = jest.fn();
    render(
      <EdgeSwipeBack onBack={onBack}>
        <Text>대화</Text>
      </EdgeSwipeBack>,
    );
    const touch = finger(pane());
    touch.down(300, 400);
    touch.move(500, 400);
    touch.move(700, 400);
    expect(touch.granted).toBe(false);
    settle();
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe('겹치면 안쪽이 이긴다', () => {
  it('스레드가 열려 있으면 대화는 물러난다 — 닫히는 것은 스레드 하나다', () => {
    // 실제 트리와 같은 모양: 대화의 래퍼 **안에** 스레드의 래퍼가 있다.
    const closeConversation = jest.fn();
    const closeThread = jest.fn();
    render(
      <EdgeSwipeBack onBack={closeConversation} testID="outer">
        <Text>대화</Text>
        <EdgeSwipeBack onBack={closeThread} testID="inner">
          <Text>스레드</Text>
        </EdgeSwipeBack>
      </EdgeSwipeBack>,
    );

    // 바깥은 무장을 풀었다: capture 에서 false 를 주므로 질문이 안쪽까지 내려간다.
    const outer = finger(pane('outer'));
    outer.down(6, 400);
    outer.move(300, 400);
    expect(outer.granted).toBe(false);

    const inner = finger(pane('inner'));
    inner.down(6, 400);
    inner.move(300, 400);
    inner.move(600, 400);
    inner.up();
    settle();

    expect(closeThread).toHaveBeenCalledTimes(1);
    expect(closeConversation).not.toHaveBeenCalled();
  });

  it('스레드가 닫히면 대화가 다시 무장한다', () => {
    const closeConversation = jest.fn();
    function Host({threadOpen}: {threadOpen: boolean}) {
      return (
        <EdgeSwipeBack onBack={closeConversation} testID="outer">
          <Text>대화</Text>
          {threadOpen ? (
            <EdgeSwipeBack onBack={jest.fn()} testID="inner">
              <Text>스레드</Text>
            </EdgeSwipeBack>
          ) : null}
        </EdgeSwipeBack>
      );
    }
    const view = render(<Host threadOpen />);
    view.rerender(<Host threadOpen={false} />);

    const outer = finger(pane('outer'));
    outer.down(6, 400);
    outer.move(300, 400);
    outer.move(600, 400);
    outer.up();
    settle();
    expect(closeConversation).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 이 배치의 관문 — 래퍼를 씌운 진짜 화면에서 셋이 그대로 산다
// =============================================================================

function actions(openThread?: jest.Mock) {
  return {
    myMemberId: SELF,
    onToggleReaction: jest.fn().mockResolvedValue(undefined),
    onEdit: jest.fn().mockResolvedValue(undefined),
    onDelete: jest.fn().mockResolvedValue(undefined),
    onOpenThread: openThread,
  };
}

describe('래퍼를 씌워도 셋은 그대로다', () => {
  it('① 길게 누르기가 여전히 시트를 연다', () => {
    const onBack = jest.fn();
    render(
      <EdgeSwipeBack onBack={onBack}>
        <Timeline
          messages={[MESSAGE]}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={BASE_MS + 60_000}
          actions={actions(jest.fn())}
        />
      </EdgeSwipeBack>,
    );

    fireEvent(screen.getAllByTestId('message-row')[0], 'touchStart', {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    });
    fireEvent(screen.getAllByTestId('message-press')[0], 'longPress');

    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('① 엣지 위에서 길게 눌러도 시트가 열린다 — 제자리 손가락은 뒤로가기가 아니다', () => {
    const onBack = jest.fn();
    render(
      <EdgeSwipeBack onBack={onBack}>
        <Timeline
          messages={[MESSAGE]}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={BASE_MS + 60_000}
          actions={actions(jest.fn())}
        />
      </EdgeSwipeBack>,
    );

    // 엣지 띠 안(x=8)에서 누르되 움직이지 않는다.
    const touch = finger(pane());
    touch.down(8, 200);
    touch.move(9, 201);
    touch.move(8, 200);
    expect(touch.granted).toBe(false);

    fireEvent(screen.getAllByTestId('message-row')[0], 'touchStart', {
      nativeEvent: {pageX: 8, pageY: 200, locationX: 8, locationY: 200},
    });
    fireEvent(screen.getAllByTestId('message-press')[0], 'longPress');
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('② 리스트를 세로로 끌어도 화면을 가져가지 않는다', () => {
    const onBack = jest.fn();
    render(
      <EdgeSwipeBack onBack={onBack}>
        <Timeline
          messages={[MESSAGE]}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={BASE_MS + 60_000}
          actions={actions(jest.fn())}
        />
      </EdgeSwipeBack>,
    );

    const touch = finger(pane());
    touch.down(10, 600);
    touch.move(12, 520);
    touch.move(14, 420);
    touch.move(30, 300); // 도중에 옆으로 휘어도
    expect(touch.granted).toBe(false);
    touch.up();
    settle();
    expect(onBack).not.toHaveBeenCalled();

    // 리스트는 여전히 자기 스크롤을 받는다.
    fireEvent.scroll(screen.getByTestId('timeline-list'), {
      nativeEvent: {
        contentOffset: {y: 120},
        contentSize: {height: 2_000, width: WIDTH},
        layoutMeasurement: {height: 800, width: WIDTH},
      },
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('③ 컴포저에 글을 쓰는 동안 화면이 움직이지 않는다', () => {
    // 한글 입력의 동기 규칙은 `composerHangul.test.tsx` 의 것이다. 여기서 지키는
    // 것은 래퍼가 그 위에 얹혀도 입력이 그대로라는 것.
    const onBack = jest.fn();
    const onSend = jest.fn();
    const at = {current: null as number | null};
    render(
      <EdgeSwipeBack onBack={onBack} progressRef={at}>
        <Composer recipient="place"
          channelLabel="일반"
          directory={DIRECTORY}
          onSend={onSend}
        />
      </EdgeSwipeBack>,
    );

    const input = screen.getByTestId('composer-input');
    fireEvent.changeText(input, '금요일에 배포합니다');
    expect(input.props.value).toBe('금요일에 배포합니다');

    // 입력창 안에서 캐럿을 끄는 수평 드래그. 엣지 밖이므로 후보조차 아니다.
    const touch = finger(pane());
    touch.down(120, 780);
    touch.move(300, 780);
    touch.move(500, 780);
    expect(touch.granted).toBe(false);
    expect(at.current).toBeNull();

    settle();
    expect(onBack).not.toHaveBeenCalled();
    expect(input.props.value).toBe('금요일에 배포합니다');
  });
});

describe('가려진 화면은 자리를 지킨다', () => {
  it('enabled={false} 면 아무리 밀어도 뒤로 가지 않는다', () => {
    const onBack = jest.fn();
    render(
      <EdgeSwipeBack onBack={onBack} enabled={false}>
        <View>
          <Text>대화</Text>
        </View>
      </EdgeSwipeBack>,
    );
    const touch = finger(pane());
    touch.down(6, 400);
    touch.move(400, 400);
    touch.move(700, 400);
    expect(touch.granted).toBe(false);
    touch.up();
    settle();
    expect(onBack).not.toHaveBeenCalled();
  });
});

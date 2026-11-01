// timelineDragRest — 목록을 아래로 끌어 48pt 누적되면 자판을 내리고 입력창이 쉰다 (#4665, Timeline·Composer·ConversationLayout)
//
// 판정의 규칙(문턱·위로 가면 0·관성·한 번)은 `dragRest.test.ts` 가 순수 함수로 재생한다. 이 파일이 재는 것은 **그 판정이 진짜 목록에 걸려 있다**와 **진짜 틀(`ConversationLayout`)이 놓은 다리로
// 입력창이 쉰다**: 손가락이 닿아 있는 동안(손을 떼기 전)에 문턱을 넘으면 자판을 내리라고 하고, 글은 그대로 두고 쉬는 알약으로 접히고, 다시 닿으면 같은 자리에서 펼친다.
//
// **jest 가 못 하는 것.** 이 환경에는 UIKit 도 RN 의 응답자 협상도 없다 — 손가락이 목록을 끌 때 `onScrollBeginDrag` 가 터치 이동과 어떤 순서로 오는지, 쉬는 순간 목록이 손가락 밑에서 튀는지
// (`contentOffset` 점프), 접히는 동안의 이동 오차(±1pt)·방향 반전은 여기서 못 잰다 — 시뮬레이터 계측(`measure/`)과 PR 본문의 「스택 검증 메모」가 몫이다(`runtime-unverified`).

import type {Message} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Keyboard} from 'react-native';

import {Composer} from '../src/features/conversation/Composer';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {Timeline} from '../src/features/conversation/Timeline';
import {drainRender, member} from './testkit';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: OTHER, displayName: '이도현', handle: 'dohyun'}),
]);

const MESSAGE: Message = {
  id: 'msg-1',
  channelId: 'ch',
  seq: 1,
  hlcTs: 1,
  hlcCount: 0,
  authorMemberId: OTHER,
  type: 'text',
  body: '배포는 금요일에 합니다.',
  state: 'sent',
  createdAtMs: BASE_MS,
};

function screenTree() {
  return (
    <ConversationLayout
      list={
        <Timeline
          messages={[MESSAGE]}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={BASE_MS + 120_000}
          actions={{
            myMemberId: SELF,
            onToggleReaction: async () => {},
            onEdit: async () => {},
            onDelete: async () => {},
            onOpenThread: () => {},
            onOpenProfile: () => {},
          }}
        />
      }
      composer={
        <Composer
          recipient="person"
          channelLabel="이도현"
          directory={DIRECTORY}
          attachmentTarget={{workspaceId: 'ws', channelId: 'ch'}}
          onSend={() => {}}
        />
      }
    />
  );
}

const list = () => screen.getByTestId('timeline-list');
const input = () => screen.getByTestId('composer-input');
const hasTools = () => screen.queryByTestId('composer-tools') !== null;
const settle = () =>
  act(() => {
    jest.advanceTimersByTime(500);
  });

function touch(x: number, y: number, at: number, touches: number) {
  return {
    nativeEvent: {
      pageX: x,
      pageY: y,
      locationX: x,
      locationY: y,
      timestamp: at,
      touches: Array.from({length: touches}, () => ({pageX: x, pageY: y})),
      changedTouches: [{pageX: x, pageY: y}],
    },
  };
}
const start = (y: number, at = 10_000, touches = 1) => fireEvent(list(), 'touchStart', touch(100, y, at, touches));
const moveTo = (y: number, at = 10_050, touches = 1) => fireEvent(list(), 'touchMove', touch(100, y, at, touches));
const end = (y: number, at = 10_400) => fireEvent(list(), 'touchEnd', touch(100, y, at, 0));
/** 목록이 손가락에 끌리기 시작한다 / 손가락이 목록을 놓는다 — UIKit 의 `scrollViewWillBeginDragging` · `scrollViewDidEndDragging` 이 RN 에서 이 이름으로 온다. */
const dragBegin = () => fireEvent(list(), 'scrollBeginDrag');
const dragEnd = () => fireEvent(list(), 'scrollEndDrag', {nativeEvent: {velocity: {x: 0, y: 0}}});

const a11y = AccessibilityInfo as unknown as {isReduceMotionEnabled: jest.Mock};
let dismiss: jest.SpyInstance<void, []>;

beforeEach(() => {
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
  jest.useFakeTimers();
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  // 자판을 실제로 내리는 것은 네이티브다 — 여기서는 호출만 남기고, 그 결과(입력창이 포커스를 잃는다)는 시험이 `blur` 로 보낸다.
  dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
});

afterEach(async () => {
  await drainRender();
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/**
 * 포커스를 쥔 채 글을 쓴 입력창을 펼친 끝값에 앉힌다 — 아래 「접힌다」 단정은 이 전제 없이도 통과하지 않도록 먼저 펼침을 확인한다. 「동작 줄이기」·「투명도 줄이기」 질문의 답(프라미스)이 도착할 때까지
 * 진짜 타이머로 기다린 뒤 가짜 타이머로 돌아온다(`timelineTapDismiss.test.tsx` 의 `typeSomething` 과 같은 이유).
 */
async function mount(text: string | null) {
  jest.useRealTimers();
  render(screenTree());
  await act(async () => {});
  jest.useFakeTimers();
  fireEvent(input(), 'focus');
  if (text !== null) fireEvent.changeText(input(), text);
  settle();
  expect(hasTools()).toBe(true);
}

describe('목록을 아래로 끌어 48pt — 자판을 내리고 입력창이 쉰다 (#4665)', () => {
  it('47pt 는 아무 일도 없고, 48pt 에서 — 손가락이 아직 닿아 있는 동안 — 자판이 내려가고 글은 그대로 쉬는 알약으로 접힌다', async () => {
    await mount('쓰던 글');
    dragBegin();
    start(300);
    moveTo(347); // 47pt
    expect(dismiss).not.toHaveBeenCalled();
    settle();
    expect(hasTools()).toBe(true);

    moveTo(348); // 48pt — 손을 떼기 전이다(`touchEnd` 없음)
    expect(dismiss).toHaveBeenCalledTimes(1);
    fireEvent(input(), 'blur'); // `Keyboard.dismiss()` 가 부른 네이티브 블러
    settle();
    expect(hasTools()).toBe(false);
    expect(input().props.value).toBe('쓰던 글'); // 초안은 지우지 않는다
  });

  it('위로 한 번 가면 누적이 0 이 된다 — 40pt 내려갔다 1pt 올라오면 47pt 더 가도 안 쉬고 48pt 에 쉰다', async () => {
    await mount('쓰던 글');
    dragBegin();
    start(300);
    moveTo(340);
    moveTo(339); // 위로 한 번
    moveTo(386); // 339 → 386 = 47pt
    expect(dismiss).not.toHaveBeenCalled();
    moveTo(387); // 48pt
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('관성 중에는 부르지 않는다 — 30pt 끌고 뗀 목록이 멀리 미끄러져도, 관성 중에 닿은 손가락이 목록을 끌기 전에는', async () => {
    await mount('쓰던 글');
    dragBegin();
    start(300);
    moveTo(330); // 30pt
    end(330);
    dragEnd(); // 손을 뗐다 — 이 뒤의 목록 이동은 관성이다
    // 관성: 손가락 없이 목록만 수백 pt 미끄러진다(스크롤 이벤트만 온다). 오프셋을 읽는 판정이라면 여기서 쉬었다.
    for (const y of [3000, 2600, 2100, 1500, 900]) {
      fireEvent.scroll(list(), {
        nativeEvent: {
          contentOffset: {y},
          contentSize: {height: 4000, width: 390},
          layoutMeasurement: {height: 800, width: 390},
        },
      });
    }
    expect(dismiss).not.toHaveBeenCalled();
    settle();
    expect(hasTools()).toBe(true);

    // 관성을 멈추려고 새 손가락이 닿아 100pt 움직였지만 목록은 아직 끌기를 알리지 않았다 — 손가락이 목록을 끌고 있지 않다.
    start(300, 11_000);
    moveTo(400, 11_050);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('한 손가락에 한 번이다 — 문턱을 넘은 뒤 계속 끌어도 자판 내림을 되풀이하지 않는다', async () => {
    await mount('쓰던 글');
    dragBegin();
    start(300);
    moveTo(348);
    moveTo(500);
    moveTo(900);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('끌기 시작 알림이 이동보다 늦게 와도 쉰다 — 합쳐진 이동이 알림 앞에 몰려 온 순서(빠른 스와이프)에서 알림이 오는 순간 자판이 내려가고 접힌다 (#5088)', async () => {
    await mount('쓰던 글');
    start(300);
    moveTo(422); // 122pt(화면 14%) — 이동 하나로 합쳐져 왔고 목록은 아직 끌기를 알리지 않았다
    expect(dismiss).not.toHaveBeenCalled();
    dragBegin(); // 끌기 시작 알림이 이동 뒤에 온다 — 그동안 쌓인 것이 이미 문턱이다(손을 떼기 전)
    expect(dismiss).toHaveBeenCalledTimes(1);
    fireEvent(input(), 'blur'); // `Keyboard.dismiss()` 가 부른 네이티브 블러
    settle();
    expect(hasTools()).toBe(false);
    expect(input().props.value).toBe('쓰던 글'); // 초안은 지우지 않는다
  });

  it('알림이 늦게 와도 47pt 면 쉬지 않고 그 뒤 1pt 를 더 가면 쉰다 — 쌓아 둔 것에 이어서 센다 (#5088)', async () => {
    await mount('쓰던 글');
    start(300);
    moveTo(347); // 47pt
    dragBegin();
    expect(dismiss).not.toHaveBeenCalled();
    moveTo(348); // 쌓아 둔 47pt + 1pt
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('글이 없는 펼친 입력창(보낸 직후)도 48pt 에 자판이 내려가고 포커스를 잃어 접힌다', async () => {
    await mount(null);
    dragBegin();
    start(300);
    moveTo(347);
    expect(dismiss).not.toHaveBeenCalled();
    moveTo(348);
    expect(dismiss).toHaveBeenCalledTimes(1);
    fireEvent(input(), 'blur');
    settle();
    expect(hasTools()).toBe(false);
  });

  it('쉰 입력창을 다시 누르면 같은 자리에서 펼친다 — 글 그대로', async () => {
    await mount('쓰던 글');
    dragBegin();
    start(300);
    moveTo(348);
    fireEvent(input(), 'blur');
    settle();
    expect(hasTools()).toBe(false); // 전제: 끌기로 쉬었다
    end(348);
    dragEnd();

    fireEvent(input(), 'focus'); // 쉬는 알약을 누르는 것 = 입력창에 닿아 포커스가 오는 것
    settle();
    expect(hasTools()).toBe(true);
    expect(input().props.value).toBe('쓰던 글');
  });
});

describe('목록의 자판 내림 방식', () => {
  it('끌기 즉시(`on-drag`)가 아니다 — 첫 1px 에 자판을 걷으면 48pt 문턱이 뜻이 없다', async () => {
    await mount('쓰던 글');
    expect(list().props.keyboardDismissMode).toBe('none');
    // 탭은 지금처럼 `handled` — 자기 동작이 있는 요소가 첫 탭에 죽지 않는다(`Timeline` 의 `keyboardShouldPersistTaps` 주석).
    expect(list().props.keyboardShouldPersistTaps).toBe('handled');
    // 끌기가 시작되는 것 자체에는 자판을 걷지 않는다(문턱 밑의 끌기 — 읽으려 살짝 민 손).
    dragBegin();
    start(300);
    moveTo(310);
    expect(dismiss).not.toHaveBeenCalled();
  });
});

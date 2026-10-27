import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Keyboard} from 'react-native';

import {Composer} from '../src/features/conversation/Composer';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {TAP_SLOP_PT} from '../src/features/conversation/tapDismiss';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// 대화 화면의 **한 틀**(`ConversationLayout`) 안에서 이어 보는 목록 탭 → 입력창 쉬기 (#4614).
//
// `listTapDismiss4614` 는 목록만, `composerRest4614` 는 입력창만 따로 잰다 — 둘을 잇는 다리(`dockFollow.rest`)는 각자 시험에서 손으로 만든 것이다. 여기서는 **진짜 틀이 놓은 다리**로
// 둘을 잇는다: 실제 `ConversationLayout` 이 목록 자리의 `Timeline` 과 도크 자리의 `Composer` 에 같은 다리를 주고, 목록을 누르면 입력창이 쉰다.
//
// 스레드 판(`ThreadPanel`)도 같은 틀·같은 `Timeline`·같은 `Composer` 를 쓴다 — 그래서 이 연결이 곧 스레드 판의 규칙이다(시뮬레이터에서 스레드 판을 따로 열어 재지는 않았다: 코드상 같은 구조).
// 작업 대화(`WorkConversation`)는 같은 틀을 쓰지만 목록이 `Timeline` 이 아니라 이 규칙 밖이다(planner 결정, 후속).
// =============================================================================

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

const input = () => screen.getByTestId('composer-input');
const hasTools = () => screen.queryByTestId('composer-tools') !== null;
const list = () => screen.getByTestId('timeline-list');
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
const start = (x: number, y: number, at: number) => fireEvent(list(), 'touchStart', touch(x, y, at, 1));
const moveTo = (x: number, y: number, at: number) => fireEvent(list(), 'touchMove', touch(x, y, at, 1));
const end = (x: number, y: number, at: number) => fireEvent(list(), 'touchEnd', touch(x, y, at, 0));

const a11y = AccessibilityInfo as unknown as {isReduceMotionEnabled: jest.Mock};
let dismiss: jest.SpyInstance<void, []>;

beforeEach(() => {
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
  jest.useFakeTimers();
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  // 자판을 실제로 내리는 것은 네이티브다 — 여기서는 호출만 남기고, 그 결과(입력창이 포커스를 잃는다)는 시험이 `blur` 로 보낸다.
  dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/**
 * 포커스를 쥔 채 글을 쓴 입력창을 펼친 끝값에 앉힌다 — 아래 「접힌다」 단정은 이 전제 없이도 통과하지 않도록 먼저 펼침을 확인한다. 「동작 줄이기」·「투명도 줄이기」 질문의 답(프라미스)이 도착할 때까지
 * 진짜 타이머로 기다린 뒤 가짜 타이머로 돌아온다(`composerRest4614` 의 `mountSettled` 와 같은 이유).
 */
async function typeSomething() {
  jest.useRealTimers();
  render(screenTree());
  await act(async () => {});
  jest.useFakeTimers();
  fireEvent(input(), 'focus');
  fireEvent.changeText(input(), '쓰던 글');
  settle();
  expect(hasTools()).toBe(true);
}

describe('진짜 틀이 목록과 입력창을 잇는다', () => {
  it('목록을 한 번 누르면 자판을 내리라고 하고, 네이티브가 포커스를 거두면 글은 그대로 두고 쉬는 알약으로 접힌다', async () => {
    await typeSomething();
    start(100, 300, 10_000);
    end(100, 300, 10_080);
    expect(dismiss).toHaveBeenCalledTimes(1);
    fireEvent(input(), 'blur'); // `Keyboard.dismiss()` 가 부른 네이티브 블러
    settle();
    expect(hasTools()).toBe(false);
    expect(input().props.value).toBe('쓰던 글');
  });

  it('블러가 알림보다 먼저 와도 같다 — 행 탭은 손 뗌에서 이미 자판을 내려서 블러가 앞설 수 있다', async () => {
    await typeSomething();
    fireEvent(input(), 'blur');
    settle();
    expect(hasTools()).toBe(true); // 대조: 목록 알림이 없으면 글이 있으니 펼친 채다(#4456)
    start(100, 300, 10_000);
    end(100, 300, 10_080);
    settle();
    expect(hasTools()).toBe(false);
    expect(input().props.value).toBe('쓰던 글');
  });

  it('끌기는 입력창도 자판도 건드리지 않는다 — 스크롤은 지금처럼 `on-drag` 의 몫이다', async () => {
    await typeSomething();
    start(100, 300, 10_000);
    moveTo(100, 300 + TAP_SLOP_PT, 10_030);
    end(100, 300 + TAP_SLOP_PT, 10_080);
    settle();
    expect(dismiss).not.toHaveBeenCalled();
    expect(hasTools()).toBe(true);
  });

  it('쉰 입력창을 다시 누르면 같은 자리에서 펼친다 — 글 그대로', async () => {
    await typeSomething();
    start(100, 300, 10_000);
    end(100, 300, 10_080);
    fireEvent(input(), 'blur');
    settle();
    expect(hasTools()).toBe(false); // 전제
    fireEvent(input(), 'focus');
    settle();
    expect(hasTools()).toBe(true);
    expect(input().props.value).toBe('쓰던 글');
  });
});

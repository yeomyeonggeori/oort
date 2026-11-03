import type {Message, MessageAttachment, RosterMember} from '@momo/core/lib/api';
import {LONG_PRESS_MS} from '@momo/core/features/timeline/longPressModel';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Keyboard} from 'react-native';

import {PRESS_VISUAL_DELAY_MS} from '../src/design/motion';
import {MessageRow, type MessageRowActions} from '../src/features/conversation/MessageRow';
import {flat} from './testkit';

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({workspaceId: 'ws', member: {id: 'self'}, signOut: jest.fn()}),
}));

// =============================================================================
// #4664 — 스크롤하려고 손만 대도 메시지 배경이 눌림으로 바뀌었다 (owner 10-27 요청: 눌림은 길게 누를 때만 보이고 스크롤할 때는 그대로).
//
// 원인: RN 은 iOS 의 150ms 터치 지연을 끈 채(`delaysContentTouches = NO`) `Pressable` 이 닿는 순간 칠하고, 스크롤이 터치를
// 가져가도 최소 130ms 를 붙든다. 고침: 스크롤 컨테이너 안 눌림 면에 `unstable_pressDelay`(=`PRESS_VISUAL_DELAY_MS`)를 주고,
// `Pressability` 가 길게 누르기를 `delayLongPress + delayPressIn` 에 울리므로 `delayLongPress` 에서 같은 만큼 빼 벽시계 250ms 를 지킨다.
//
// 이 시험은 `fireEvent.press`·`'pressIn'`·`'longPress'` 를 쓰지 않는다. 그것들은 `Pressability` 의 타이머를 건너뛰고 콜백을 바로
// 부르므로 지연 prop 이 있든 없든 통과한다. 대신 RN 응답 시스템이 뷰에게 하는 호출(`onResponderGrant` → `Terminate`/`Release`)을
// 그대로 하고 가짜 시계를 흘린다 — 진짜 `Pressability` 상태 기계가 돈다.
//
// 사보타주(PR 본문 표): 1) `unstable_pressDelay` 를 지우면 ①②③④ 가 빨갛다. 2) 길게 누르기 보정(`LONG_PRESS_MS - 지연`)을 지워 `delayLongPress`
// 가 250 이 되면 ③④ 가 빨갛다(시트가 370ms 에 열린다).
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE_MS = 1_700_000_000_000;

function rosterMember(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이도현',
    handle: 'dohyeon',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  rosterMember({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  rosterMember({id: OTHER}),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '배포는 금요일에 합니다.',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

function actions(over: Partial<MessageRowActions> = {}): MessageRowActions {
  return {
    myMemberId: SELF,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    onOpenThread: jest.fn(),
    ...over,
  };
}

function row(over: Partial<React.ComponentProps<typeof MessageRow>> = {}) {
  return (
    <MessageRow
      message={message()}
      startsGroup
      directory={DIRECTORY}
      chips={[]}
      nowMs={BASE_MS}
      actions={actions()}
      {...over}
    />
  );
}

// -----------------------------------------------------------------------------
// 손가락 하나가 행에 하는 일 — RN 응답 시스템이 뷰에게 하는 호출을 그대로 한다.
//   · 바깥 View 의 `onTouchStart/End/Cancel`: 터치 관찰(길게 누르기 10px 게이트를 무장한다).
//   · 안쪽 `Pressable` 의 `onResponderGrant/Release/Terminate`: 응답자가 되면 `Pressability` 가 타이머를 건다.
// `persist` 는 `Pressability` 가 부른다. `currentTarget` 은 비면 안 된다 — `Pressability` 는 응답자 id 가 없으면 `Release` 를 **버린다**
// (`_receiveSignal` 첫머리). 눌림 영역 측정(`measure`)은 아무것도 하지 않는 것으로 대신한다(이동 추적이 필요 없다).
// -----------------------------------------------------------------------------
type Host = {props: Record<string, (event: unknown) => unknown>};
const host = (testID: string) => screen.getByTestId(testID) as unknown as Host;

function touchEvent(touching: boolean) {
  const point = {identifier: 0, pageX: 100, pageY: 200, locationX: 100, locationY: 200, timestamp: Date.now()};
  return {
    persist() {},
    currentTarget: {measure() {}},
    nativeEvent: {...point, touches: touching ? [point] : [], changedTouches: [point]},
  };
}

const finger = {
  /** 닿는다. */
  down() {
    act(() => {
      host('message-row').props.onTouchStart(touchEvent(true));
      host('message-press').props.onResponderGrant(touchEvent(true));
    });
  },
  /** 뗀다. */
  up() {
    act(() => {
      host('message-press').props.onResponderRelease(touchEvent(false));
      host('message-row').props.onTouchEnd(touchEvent(false));
    });
  },
  /** 스크롤뷰가 터치를 가져간다 — 그 안의 `Pressable` 은 취소(`Terminate`)를 받는다. */
  scrollTakesOver() {
    act(() => {
      host('message-press').props.onResponderTerminate(touchEvent(true));
      host('message-row').props.onTouchCancel(touchEvent(true));
    });
  },
};

const wait = (ms: number) => {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
};

/**
 * 행의 눌림 면이 **그려졌는가**. `Pressable` 이 `pressed` 로 계산해 호스트 View 에 준 스타일을 읽는다 —
 * 눌린 상태가 어떻게 생겼는지 흉내 내려고 style 함수를 `{pressed: true}` 로 부르지 않는다(그것은 「눌리면 이렇다」지 「눌렸다」가 아니다).
 * 안 눌린 `rowInner` 는 배경이 없고, 눌리면 `rowPressed` 의 배경이 붙는다.
 */
const pressedFill = () => flat(screen.getByTestId('message-press').props.style).backgroundColor;

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('스크롤 컨테이너 안 눌림 면은 늦게 칠한다 (#4664)', () => {
  it('① 지연 안에 스크롤이 터치를 가져가면 눌림 프레임이 0이다 — 대조: 같은 손가락이 지연을 버티면 그때 칠해진다', () => {
    render(row());
    expect(pressedFill()).toBeUndefined();

    // 닿은 순간부터 지연 직전까지 **매 ms** 의 프레임을 본다. 스크롤이 터치를 가져간 뒤에도, 지연·길게 누르기·최소 눌림 시간이
    // 다 지나는 2초 동안 그대로여야 한다(끝난 제스처가 늦게 칠하지 않는다).
    finger.down();
    const frames = [pressedFill()];
    for (let ms = 1; ms < PRESS_VISUAL_DELAY_MS; ms += 1) {
      wait(1);
      frames.push(pressedFill());
    }
    finger.scrollTakesOver();
    frames.push(pressedFill());
    wait(2000);
    frames.push(pressedFill());
    expect(frames).toHaveLength(PRESS_VISUAL_DELAY_MS + 2);
    expect(frames.filter(fill => fill !== undefined)).toHaveLength(0);
    expect(screen.queryByTestId('message-action-sheet')).toBeNull(); // 취소된 손가락은 시트도 못 연다

    // 대조(짝): 위가 「이 행은 아예 안 칠한다」라서 통과한 것이 아니다. 같은 행이 지연을 버틴 손가락에는 칠한다.
    finger.down();
    wait(PRESS_VISUAL_DELAY_MS - 1);
    expect(pressedFill()).toBeUndefined();
    wait(1);
    expect(pressedFill()).toBeDefined();
    // 깨뜨리면: MessageRow 행 Pressable 의 `{...longPress.pressTiming}` 을 지운다 → 닿는 순간 칠해져 첫 프레임에서 빨갛다.
  });

  it('② 지연보다 짧은 탭은 뗀 뒤 짧게 번쩍인다 — 탭은 그대로 가고 눌림 피드백은 남는다', () => {
    const onOpenThread = jest.fn();
    render(row({actions: actions({onOpenThread})}));

    finger.down();
    wait(PRESS_VISUAL_DELAY_MS / 2);
    expect(pressedFill()).toBeUndefined(); // 뗄 때까지는 안 칠한다
    finger.up();
    expect(onOpenThread).toHaveBeenCalledTimes(1); // 지연이 탭을 늦추지 않는다
    expect(pressedFill()).toBeDefined(); // 뗀 뒤 번쩍 — 피드백이 사라지지 않는다
    wait(100);
    expect(pressedFill()).toBeDefined(); // 눈에 보일 만큼 남는다
    wait(100);
    expect(pressedFill()).toBeUndefined(); // 그리고 풀린다
    // 깨뜨리면: 지연 prop 을 지운다 → 닿는 순간 칠해져 「뗄 때까지는 안 칠한다」가 빨갛다.
  });

  it('③ 길게 누르기 시트는 닿은 지 정확히 250ms 에 열린다 — 칠하기 지연이 시트를 늦추지 않는다', () => {
    render(row());
    finger.down();
    wait(LONG_PRESS_MS - 1);
    expect(screen.queryByTestId('message-action-sheet')).toBeNull();
    wait(1);
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    // 깨뜨리면: `useLongPress` 의 `delayLongPress` 를 `LONG_PRESS_MS`(보정 없음)로 → 시트가 120ms 늦은 370ms 에 열려 249 뒤 1ms 에서 빨갛다.
    // 지연 prop 을 지워 보정만 남기면 → 130ms 에 열려 첫 단정에서 빨갛다.
  });

  it('④ 같은 행 안의 눌림 면도 같은 지연을 진다 — 길게 누르기를 가진 면은 지연 + 길게 누르기 = 250', async () => {
    jest.useRealTimers(); // 시계를 흘리지 않는다. 사진 칸이 늦게 끝내는 약속만 act 안에서 비운다.
    const root = message({id: 'root-1', seq: 9});
    const photo: MessageAttachment = {id: 'att-1', name: '현장.png', mime: 'image/png', sizeBytes: 4096};
    const file: MessageAttachment = {id: 'att-2', name: '견적.pdf', mime: 'application/pdf', sizeBytes: 2048};
    render(
      row({
        message: message({id: 'reply-1', seq: 11, rootId: 'root-1', attachments: [photo, file]}),
        replyParent: root,
        rollup: {replyCount: 2, lastReplyAtMs: BASE_MS, lastReplySeq: 12},
        chips: [{emoji: '👍', count: 2, mine: false}],
        actions: actions({onOpenProfile: jest.fn()}),
      }),
    );

    /**
     * `Pressable`(합성 요소)이 받은 props 전부 — `unstable_pressDelay` 는 호스트 View 로 내려가지 않으므로 이것이 그 면이 낸 값이다.
     * 지연 prop 이 없는 면은 여기서 빠지므로, 한 면이 규칙을 잃으면 목록이 줄어 아래 단정이 빨갛다.
     */
    type PressableProps = {unstable_pressDelay: number; delayLongPress?: number; accessibilityRole?: string};
    const pressables = (testID: string): PressableProps[] =>
      screen.UNSAFE_root
        .findAll(
          (node: {props?: Record<string, unknown>}) =>
            node.props?.testID === testID && node.props.unstable_pressDelay !== undefined,
        )
        .map((node: {props: unknown}) => node.props as PressableProps);
    const expectWallClock250 = (props: PressableProps) => {
      expect(props.unstable_pressDelay).toBe(PRESS_VISUAL_DELAY_MS);
      expect((props.delayLongPress ?? 0) + props.unstable_pressDelay).toBe(LONG_PRESS_MS);
    };

    // 길게 누르기(시트)를 여는 면: 행 자신 · 아바타. 합이 250 이어야 시트가 같은 시각에 열린다.
    for (const testID of ['message-press', 'profile-avatar-target']) {
      const found = pressables(testID);
      expect(found.length).toBeGreaterThan(0);
      found.forEach(expectWallClock250);
    }
    // 사진 칸(imagebutton)과 파일 칸(button) — 둘 다 이 규칙을 지고 있어야 한다. 한 종류가 지연 prop 을 잃으면 그 역할이 이 집합에서
    // 빠져 빨갛고, 두 종류가 다 그려졌다는 것도 이 집합이 보인다(위치 번호로 고르지 않는다: 같은 합성 요소가 둘로 잡혀도 흔들리지 않게).
    const items = pressables('attachment-item');
    expect(new Set(items.map(props => props.accessibilityRole))).toEqual(new Set(['imagebutton', 'button']));
    items.forEach(expectWallClock250);
    // 길게 누르기가 없는 면: 지연만 진다(기본 길게 누르기는 RN 이 `500 - 지연` 으로 총 500 을 지킨다).
    for (const testID of ['reaction-chip-👍', 'reply-marker', 'thread-rollup']) {
      const found = pressables(testID);
      expect(found.length).toBeGreaterThan(0);
      found.forEach(props => expect(props.unstable_pressDelay).toBe(PRESS_VISUAL_DELAY_MS));
    }
    // 깨뜨리면: 위 면 중 하나에서 prop 을 지운다(예: 아바타의 `{...longPress.pressTiming}`) → 그 줄이 빨갛다.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  });
});

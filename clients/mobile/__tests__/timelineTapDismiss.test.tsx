// timelineTapDismiss — 목록 탭으로 자판 내리고 입력창 쉬기 (Timeline·ConversationLayout)
// 합친 원본: listTapDismiss4614.test.tsx, conversationTapRest4614.test.tsx
// 이슈 번호는 아래 묶음 `describe` 이름과 주석에 남아 있다.

import type {Message} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Keyboard, Linking} from 'react-native';

import {createDockFollow, DockFollowContext, type DockFollow} from '../src/features/conversation/dockFollow';
import {TAP_MAX_MS, TAP_SLOP_PT} from '../src/features/conversation/tapDismiss';
import {Timeline} from '../src/features/conversation/Timeline';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {drainRender, member} from './testkit';

// ---- 아래 묶음들이 함께 쓰는 고정값·도구 (원래 파일마다 글자 그대로 같게 선언돼 있던 것)
const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: OTHER, displayName: '이도현', handle: 'dohyun'}),
]);

const list = () => screen.getByTestId('timeline-list');

// =============================================================================
// 합친 시험: 원래 listTapDismiss4614.test.tsx (#4614)
// =============================================================================
describe('listTapDismiss (#4614)', () => {
  // =============================================================================
  // 대화 목록을 누르면 자판이 내려가고 입력창이 쉰다 (#4614) — 목록 쪽의 몫.
  //
  // 이 파일이 재는 것: **목록이 터치를 보고 탭이라고 판정하면** `Keyboard.dismiss()` 를 부르고 다리(`dockFollow.rest`)로 입력창에 쉬라고 알린다. 끌기·긴 누름·두 손가락은 아니다.
  // 입력창이 그 알림을 받아 접히는 쪽은 `composer.test.tsx` 의 `composerRest` 묶음이다.
  //
  // **jest 가 못 하는 것을 적어 둔다.** 이 환경에는 RN 의 응답자 협상이 없다 — `fireEvent.press` 는 `onPress` 를 그냥 부르고, 터치 이벤트는 가장 가까운 한 핸들러에만 간다(대상에서 조상으로
  // 올라오는 전파가 없다). 그래서 「링크·칩·아바타를 눌러도 그 터치가 목록에 닿는가」「행 `Pressable` 이 응답자를 쥔 채로 목록의 손 뗌이 그 **뒤에** 오는가」는 여기서 못 잰다.
  // 그것은 시뮬레이터(iOS 26.5, 16 Pro)에서 실측했다 — 7개 요소 모두 터치가 목록에 닿았고, 응답자의 손 뗌(`onPress`)이 목록의 `onTouchEnd` 보다 1ms 앞섰다(`measure/tapDismiss.tsx` 의
  // 싱크 기록, PR 본문). 여기서는 **판정이 목록에 걸려 있다**와 **자기 동작이 판정과 무관하게 그대로 돈다**를 잰다.
  // =============================================================================

  const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const LINK = 'https://example.com/studio/schedule';

  function message(over: Partial<Message> = {}): Message {
    return {
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
      ...over,
    };
  }

  const ROOT = message({id: ROOT_ID, seq: 10, body: `일정표는 이 링크에서 보세요 ${LINK} @dohyun`});
  const REPLY = message({
    id: 'reply-1',
    seq: 11,
    rootId: ROOT_ID,
    authorMemberId: SELF,
    body: '확인했어요.',
    createdAtMs: BASE_MS + 60_000,
  });
  const REACTIONS = {[ROOT_ID]: {'👍': [OTHER]}};

  function rowActions() {
    return {
      myMemberId: SELF,
      onToggleReaction: jest.fn().mockResolvedValue(undefined),
      onEdit: jest.fn().mockResolvedValue(undefined),
      onDelete: jest.fn().mockResolvedValue(undefined),
      onOpenThread: jest.fn(),
      onOpenProfile: jest.fn(),
    };
  }

  type Actions = ReturnType<typeof rowActions>;

  function renderTimeline(actions: Actions, bridge: DockFollow | null) {
    const timeline = (
      <Timeline
        messages={[ROOT, REPLY]}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={BASE_MS + 120_000}
        actions={actions}
        reactions={REACTIONS}
      />
    );
    return render(
      bridge === null ? timeline : <DockFollowContext.Provider value={bridge}>{timeline}</DockFollowContext.Provider>,
    );
  }

  /** RN 이 터치 이벤트에 싣는 모양 — `touches` 는 이 이벤트 **뒤에** 닿아 있는 손가락이다(`ScrollView._handleTouchEnd` 가 `touches.length !== 0` 으로 읽는 그것). */
  function touchEvent(x: number, y: number, at: number, touches: number) {
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
  const start = (x: number, y: number, at: number, touches = 1) => fireEvent(list(), 'touchStart', touchEvent(x, y, at, touches));
  const moveTo = (x: number, y: number, at: number, touches = 1) => fireEvent(list(), 'touchMove', touchEvent(x, y, at, touches));
  const end = (x: number, y: number, at: number, touches = 0) => fireEvent(list(), 'touchEnd', touchEvent(x, y, at, touches));

  /** 손가락 하나가 (100, 300) 에 닿았다 `heldMs` 뒤에 같은 자리에서 떨어진다. */
  function tap(at = 10_000, heldMs = 80) {
    start(100, 300, at);
    end(100, 300, at + heldMs);
  }

  let dismiss: jest.SpyInstance<void, []>;
  let rest: jest.Mock;
  let bridge: DockFollow;

  beforeEach(() => {
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    bridge = createDockFollow();
    rest = jest.fn();
    bridge.registerRest(rest);
  });

  afterEach(async () => {
    await drainRender();
    jest.restoreAllMocks();
    cleanup();
  });

  // -----------------------------------------------------------------------------

  describe('목록의 탭 — 자판을 내리고 입력창에 쉬라고 알린다', () => {
    it('손가락 하나를 가만히 짧게 대었다 떼면: 닿는 동안은 아무 일도 없고, 뗀 순간에 자판이 내려가고 입력창에 쉬라고 알린다', () => {
      renderTimeline(rowActions(), bridge);
      start(100, 300, 10_000);
      expect(dismiss).not.toHaveBeenCalled();
      expect(rest).not.toHaveBeenCalled();
      end(100, 300, 10_080);
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(rest).toHaveBeenCalledTimes(1);
    });

    it('문턱 바로 안의 떨림은 탭이다 — 시작점에서 TAP_SLOP_PT 미만, TAP_MAX_MS 미만', () => {
      renderTimeline(rowActions(), bridge);
      start(100, 300, 10_000);
      moveTo(100 + TAP_SLOP_PT - 1, 300, 10_030);
      end(100 + TAP_SLOP_PT - 1, 300, 10_000 + TAP_MAX_MS - 1);
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(rest).toHaveBeenCalledTimes(1);
    });

    it('탭마다 한 번씩 알린다 — 두 번 탭하면 두 번이다', () => {
      renderTimeline(rowActions(), bridge);
      tap(10_000);
      tap(11_000);
      expect(dismiss).toHaveBeenCalledTimes(2);
      expect(rest).toHaveBeenCalledTimes(2);
    });

    it('다리가 없는 표면(스레드 시험·하네스 일부)에서도 자판은 내려가고 아무것도 터지지 않는다', () => {
      renderTimeline(rowActions(), null);
      expect(() => tap()).not.toThrow();
      expect(dismiss).toHaveBeenCalledTimes(1);
    });
  });

  describe('탭이 아니면 건드리지 않는다 — 끌기는 48pt 누적 판정(#4665, `dragRest`)의 몫이다', () => {
    it('끌기: 시작점에서 TAP_SLOP_PT 이상 움직이면 뗀 자리가 가까워도 자판도 입력창도 그대로다', () => {
      renderTimeline(rowActions(), bridge);
      start(100, 300, 10_000);
      moveTo(100, 300 + TAP_SLOP_PT, 10_030);
      moveTo(100, 300, 10_060); // 시작점으로 돌아왔다 — 한 번 끌기로 밝혀지면 끝까지 끌기다
      end(100, 300, 10_090);
      expect(dismiss).not.toHaveBeenCalled();
      expect(rest).not.toHaveBeenCalled();
    });

    it('길게 누른 손(TAP_MAX_MS 이상)은 탭이 아니다 — 길게 누르기는 시트의 몫이다', () => {
      renderTimeline(rowActions(), bridge);
      tap(10_000, TAP_MAX_MS);
      expect(dismiss).not.toHaveBeenCalled();
      expect(rest).not.toHaveBeenCalled();
    });

    it('손가락이 둘이면 탭이 아니다', () => {
      renderTimeline(rowActions(), bridge);
      start(100, 300, 10_000);
      start(200, 300, 10_010, 2);
      end(200, 300, 10_050, 1);
      end(100, 300, 10_070, 0);
      expect(dismiss).not.toHaveBeenCalled();
      expect(rest).not.toHaveBeenCalled();
    });

    it('시스템이 터치를 가져가면(취소) 탭이 아니다', () => {
      renderTimeline(rowActions(), bridge);
      start(100, 300, 10_000);
      fireEvent(list(), 'touchCancel', touchEvent(100, 300, 10_040, 0));
      end(100, 300, 10_060);
      expect(dismiss).not.toHaveBeenCalled();
      expect(rest).not.toHaveBeenCalled();
    });

    it('목록은 끌기 즉시 자판을 걷지 않는다(`none` — 손가락 아래 48pt 누적은 `dragRest`, #4665) · 탭은 `handled` 라서 자기 동작이 있는 요소가 첫 탭에 죽지 않는다', () => {
      renderTimeline(rowActions(), bridge);
      // `never` 로 바꾸면 자판이 올라와 있는 동안 링크·칩·길게 누르기가 첫 탭을 스크롤뷰에 뺏긴다(`Timeline` 의 `keyboardShouldPersistTaps` 주석).
      expect(list().props.keyboardDismissMode).toBe('none');
      expect(list().props.keyboardShouldPersistTaps).toBe('handled');
    });

    it('판정은 터치를 **관찰만** 한다 — 목록에 응답자를 걸지 않는다(응답자를 잡으면 아래 요소들의 탭이 죽는다)', () => {
      renderTimeline(rowActions(), bridge);
      const props = list().props as Record<string, unknown>;
      for (const name of [
        'onStartShouldSetResponder',
        'onStartShouldSetResponderCapture',
        'onMoveShouldSetResponder',
        'onMoveShouldSetResponderCapture',
      ]) {
        expect(props[name]).toBeUndefined();
      }
      // 대조: 관찰하는 터치 처리기는 실제로 걸려 있다 — 위 「없음」이 목록을 못 찾아서 통과한 것이 아니다.
      for (const name of ['onTouchStart', 'onTouchMove', 'onTouchEnd', 'onTouchCancel']) {
        expect(typeof props[name]).toBe('function');
      }
    });
  });

  // -----------------------------------------------------------------------------
  // 요소별 「같이 내리나」 표 (#4614) — 기본은 **내림**이다(링크·첨부는 화면이 바뀌고, 나머지도 「한 번의 탭 = 한 가지 일」보다 「한 번의 탭 = 자기 동작 + 쉬기」가 덜 낯설다).
  // 각 줄: 요소를 누르면 **자기 동작이 그대로 돌고**, 같은 탭의 끝(목록의 손 뗌)에서 자판이 내려가고 입력창이 쉰다. 자기 동작이 없는 요소(말풍선 본문·빈 곳·날짜 알약·보내는 중인 메아리)는
  // 요소가 없으니 이 표 밖이다 — 그 길(행 `onRowPress`·`ScrollView` 의 손 뗌)은 `messageTap.test.tsx` 와 시뮬레이터 기록이 잰다.
  // -----------------------------------------------------------------------------

  describe('요소별 표 — 자기 동작은 그대로, 같은 탭의 끝에서 목록이 나머지를 거둔다', () => {
    const rows: {
      name: string;
      testID: string;
      own: (actions: Actions) => jest.Mock | jest.SpyInstance;
    }[] = [
      {name: '링크', testID: 'message-link', own: () => Linking.openURL as unknown as jest.SpyInstance},
      {name: '아바타', testID: 'profile-avatar-target', own: actions => actions.onOpenProfile},
      // 이름 줄은 문이 아니다(#4666) — 프로필 문은 얼굴과 멘션뿐이다.
      {name: '멘션', testID: 'message-mention', own: actions => actions.onOpenProfile},
      {name: '스레드 롤업', testID: 'thread-rollup', own: actions => actions.onOpenThread},
      {name: '답글 표식', testID: 'reply-marker', own: actions => actions.onOpenThread},
      {name: '반응 칩', testID: 'reaction-chip-👍', own: actions => actions.onToggleReaction},
    ];

    it.each(rows)('$name', ({testID, own}) => {
      const actions = rowActions();
      renderTimeline(actions, bridge);
      const target = screen.getAllByTestId(testID)[0];
      expect(target).toBeTruthy(); // 전제: 이 요소가 실제로 그려졌다 — 없으면 아래 단정은 아무것도 안 잰다.

      fireEvent.press(target);
      expect(own(actions)).toHaveBeenCalledTimes(1);
      // 요소를 누른 것만으로는(터치가 목록에 닿기 전) 자판을 건드리지 않는다 — 내리는 것은 목록의 판정이다.
      expect(dismiss).not.toHaveBeenCalled();

      tap();
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(rest).toHaveBeenCalledTimes(1);
      // 판정이 자기 동작을 되풀이시키지도 지우지도 않는다.
      expect(own(actions)).toHaveBeenCalledTimes(1);
    });
  });
});

// =============================================================================
// 합친 시험: 원래 conversationTapRest4614.test.tsx (#4614)
// =============================================================================
describe('conversationTapRest (#4614)', () => {
  // =============================================================================
  // 대화 화면의 **한 틀**(`ConversationLayout`) 안에서 이어 보는 목록 탭 → 입력창 쉬기 (#4614).
  //
  // `listTapDismiss` 묶음(이 파일)은 목록만, `composer.test.tsx` 의 `composerRest` 묶음은 입력창만 따로 잰다 — 둘을 잇는 다리(`dockFollow.rest`)는 각자 시험에서 손으로 만든 것이다. 여기서는 **진짜 틀이 놓은 다리**로
  // 둘을 잇는다: 실제 `ConversationLayout` 이 목록 자리의 `Timeline` 과 도크 자리의 `Composer` 에 같은 다리를 주고, 목록을 누르면 입력창이 쉰다.
  //
  // 스레드 판(`ThreadPanel`)도 같은 틀·같은 `Timeline`·같은 `Composer` 를 쓴다 — 그래서 이 연결이 곧 스레드 판의 규칙이다(시뮬레이터에서 스레드 판을 따로 열어 재지는 않았다: 코드상 같은 구조).
  // 작업 대화(`WorkConversation`)는 같은 틀을 쓰지만 목록이 `Timeline` 이 아니라 이 규칙 밖이다(planner 결정, 후속).
  // =============================================================================

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

  afterEach(async () => {
    await drainRender();
    cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /**
   * 포커스를 쥔 채 글을 쓴 입력창을 펼친 끝값에 앉힌다 — 아래 「접힌다」 단정은 이 전제 없이도 통과하지 않도록 먼저 펼침을 확인한다. 「동작 줄이기」·「투명도 줄이기」 질문의 답(프라미스)이 도착할 때까지
   * 진짜 타이머로 기다린 뒤 가짜 타이머로 돌아온다(`composer.test.tsx` 의 `mountSettled` 와 같은 이유).
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

    it('탭이 아닌 끌기(10pt)는 입력창도 자판도 건드리지 않는다 — 48pt 에는 못 미친다(문턱은 `timelineDragRest.test.tsx`)', async () => {
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
});

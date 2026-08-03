import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Keyboard} from 'react-native';

import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// 탭 하나에 규칙이 **둘** 걸려 있다 (goal RN-U1 결함 1 × 결함 2).
//
// 성재, iPhone 17, Release 빌드:
//   결함 1 "채팅창은 여는 건 성공했는데, 그냥 다시 닫을 때는 어떻게 해야 해?"
//   결함 2 "채팅을 일단 클릭하면 스레드처럼 거기서 바로 답글을 달 수 있게 해주고"
//
// 두 요구가 **같은 제스처**를 가리킨다. 하나로 정하지 않으면 둘 다 안 된다:
// 탭에 스레드만 주면 키보드는 영영 안 닫히고, 탭에 닫기만 주면 스레드로 가는 길이
// 다시 롤업 버튼 하나로 줄어든다(그 버튼은 **답글이 없는 메시지에는 아예 없다**).
//
// 정한 규칙, 그리고 이 파일이 그것을 못 박는다:
//
//   키보드가 올라와 있다  →  첫 탭은 **닫기**. 그 이상 아무것도 아니다.
//   키보드가 내려가 있다  →  탭은 이 행이 이미 그리고 있는 **스레드**를 연다.
//
// 왜 이 축인가. 모드를 고르는 것이 숨은 상태가 아니라 화면의 절반을 차지하고 있는
// 키보드 자체라서, 사람은 자기가 어느 규칙 안에 있는지 **보면서** 누른다. 그리고
// 실수의 대가가 최소다 — 닫으려던 탭이 화면을 열어 버리면 대가는 「길을 잃음」이지만,
// 열려던 탭이 키보드를 닫으면 대가는 「한 번 더 누르기」다. iOS 전체가 쓰는 관습이기도
// 하다.
//
// 시트의 「답글 달기」에는 이 판정이 **없다**. 메뉴에서 고른 것은 탭이 아니라 선택이고,
// 고른 것을 "키보드를 닫으라는 뜻이었겠지"로 되해석하는 화면은 거짓말을 한다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
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

/** 답글이 하나도 없는 루트 — 롤업 버튼이 없으므로 탭 말고는 길이 없던 바로 그 행. */
const LONE = message({id: ROOT_ID, seq: 10});
const REPLY = message({
  id: 'reply-1',
  seq: 11,
  rootId: ROOT_ID,
  authorMemberId: SELF,
  body: '금요일 좋습니다.',
  createdAtMs: BASE_MS + 60_000,
});

/**
 * 채널이 행에 주는 것. `openThread` 를 밖에서 만들어 넘기는 것은 취향이 아니라
 * 타입 때문이다 — 스레드 패널을 흉내 내려면 이 자리가 `undefined` 여야 하고, 그러면
 * 호출 기록을 읽을 곳이 사라진다.
 */
function actions(openThread: jest.Mock | undefined) {
  return {
    myMemberId: SELF,
    onToggleReaction: jest.fn().mockResolvedValue(undefined),
    onEdit: jest.fn().mockResolvedValue(undefined),
    onDelete: jest.fn().mockResolvedValue(undefined),
    onOpenThread: openThread,
  };
}

function renderTimeline(
  messages: Message[],
  rowActions: ReturnType<typeof actions>,
  over: Partial<React.ComponentProps<typeof Timeline>> = {},
) {
  return render(
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={BASE_MS + 120_000}
      actions={rowActions}
      {...over}
    />,
  );
}

/** 행을 누른다. `message-press` 가 행의 Pressable 이다. */
function tapRow(index = 0) {
  fireEvent.press(screen.getAllByTestId('message-press')[index]);
}

/** 길게 눌러 시트를 연다 — 코어의 10px 게이트를 통과하도록 down 부터. */
function longPressRow(index = 0) {
  fireEvent(screen.getAllByTestId('message-row')[index], 'touchStart', {
    nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
  });
  fireEvent(screen.getAllByTestId('message-press')[index], 'longPress');
}

let keyboardUp: jest.SpyInstance<boolean, []>;
let dismiss: jest.SpyInstance<void, []>;

beforeEach(() => {
  keyboardUp = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  cleanup();
});

// -----------------------------------------------------------------------------

describe('키보드가 내려가 있으면 탭은 스레드를 연다', () => {
  it('답글이 하나도 없는 메시지도 열린다 — 그 행에는 롤업 버튼이 없다', () => {
    // 결함 2 그 자체. 이 행에는 「답글 N개」가 없으므로, 이 탭이 없으면 새 스레드를
    // 시작하는 길은 보이지 않는 제스처(길게 누르기) 하나뿐이다.
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([LONE], row);
    expect(screen.queryByTestId('thread-rollup')).toBeNull();

    tapRow();
    expect(openThread).toHaveBeenCalledTimes(1);
    expect(openThread.mock.calls[0][0].id).toBe(ROOT_ID);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('답글을 탭하면 그 답글이 달린 스레드로 간다 — 답글의 스레드가 아니라', () => {
    // 한 단계 규칙. 답글을 루트로 삼는 것은 서버가 "thread root must be a
    // top-level message" 로 거절하는 동작이므로, 화면이 그것을 제안하지 않는다.
    // 목적지는 ↳ 표식이 가는 곳과 **같은 곳**이다 — 한 행이 두 군데로 가지 않는다.
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([LONE, REPLY], row);

    tapRow(1);
    expect(openThread).toHaveBeenCalledTimes(1);
    expect(openThread.mock.calls[0][0].id).toBe(ROOT_ID);
  });

  it('루트를 못 불러온 답글은 아무 데도 가지 않는다 — 모르면 모른다고 말한다', () => {
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([REPLY], row);

    tapRow();
    expect(openThread).not.toHaveBeenCalled();
  });

  it('스레드 패널 안에서는 탭이 아무 데도 안 간다', () => {
    // 그 화면은 `onOpenThread` 를 주지 않는다(모든 행이 이미 스레드 안이다).
    const row = actions(undefined);
    renderTimeline([LONE, REPLY], row, {markReplies: false});

    tapRow();
    tapRow(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('묘비는 스레드를 열지 않는다', () => {
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([message({id: ROOT_ID, seq: 10, state: 'deleted'})], row);

    tapRow();
    expect(openThread).not.toHaveBeenCalled();
  });
});

describe('키보드가 올라와 있으면 첫 탭은 닫기다', () => {
  it('스레드는 열리지 않는다 — 닫으려던 탭이 화면을 열면 안 된다', () => {
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([LONE], row);
    keyboardUp.mockReturnValue(true);

    tapRow();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(openThread).not.toHaveBeenCalled();
  });

  it('닫힌 뒤의 다음 탭은 스레드를 연다 — 두 규칙이 순서대로 성립한다', () => {
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([LONE], row);

    keyboardUp.mockReturnValue(true);
    tapRow();
    keyboardUp.mockReturnValue(false); // 키보드가 실제로 내려갔다
    tapRow();

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledTimes(1);
  });

  it('묘비를 눌러도 키보드는 내려간다 — 대화 한가운데의 죽은 자리를 만들지 않는다', () => {
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([message({id: ROOT_ID, seq: 10, state: 'deleted'})], row);
    keyboardUp.mockReturnValue(true);

    tapRow();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

describe('길게 누르기와 다투지 않는다', () => {
  it('시트를 연 손가락을 떼며 따라 울리는 탭은 스레드를 열지 않는다', () => {
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([LONE], row);

    longPressRow();
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    tapRow(); // 떼면서 따라오는 탭
    expect(openThread).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // 결함 3 — "꾹 누르면 거기에도 답글 버튼이 있게 해줘"
  //
  // 시트의 「답글 달기」는 RN-C5 부터 있었다(`MessageActionSheet` `sheet-reply`,
  // `availability.reply`). 없던 것은 그 항목이 아니라 **탭**이었고, 위의 describe 가
  // 그것이다. 여기서 못 박는 것은 그 항목이 실제로 스레드로 **이어져 있다**는 것 —
  // 지금까지 시트가 열린다는 것만 검사했지, 눌렀을 때 어디로 가는지는 아무도 재지
  // 않았다.
  // ===========================================================================
  it('시트의 「답글 달기」는 그 메시지의 스레드를 연다', () => {
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([LONE], row);

    longPressRow();
    fireEvent.press(screen.getByTestId('sheet-reply'));

    expect(openThread).toHaveBeenCalledTimes(1);
    expect(openThread.mock.calls[0][0].id).toBe(ROOT_ID);
  });

  it('메뉴에서 고른 것은 키보드가 올라와 있어도 되해석되지 않는다', () => {
    // 탭에는 판정이 붙지만 선택에는 붙지 않는다. 「답글 달기」를 누른 사람에게
    // 키보드를 닫아 주고 마는 화면은, 그 사람이 한 말을 못 들은 척하는 것이다.
    const openThread = jest.fn();
    const row = actions(openThread);
    renderTimeline([LONE], row);

    longPressRow();
    keyboardUp.mockReturnValue(true);
    fireEvent.press(screen.getByTestId('sheet-reply'));

    expect(openThread).toHaveBeenCalledTimes(1);
  });
});

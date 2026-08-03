import {ApiError} from '@momo/core/lib/api';
import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {MOVE_TOLERANCE_PX} from '@momo/core/features/timeline/longPressModel';
import type {ReactionChip} from '@momo/core/features/timeline/reactions';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';

// =============================================================================
// 메시지 액션의 규칙, 화면에서.
//
// 코어는 이미 순수 함수로 자기 몫을 증명한다(`longPressModel.test.ts` 13개,
// `actionCopy.test.ts`, `messageActions.test.ts`). 이 파일이 증명하는 것은 **그
// 규칙들이 실제로 배선돼 있는가** 하나다. 웹 배치가 정확히 그 자리에서 무너졌기
// 때문이다: 규칙은 훌륭하게 적혀 있었고, 그것을 호출하는 코드가 죽어 있었다.
//
// 그래서 여기서는 순수 함수를 다시 부르지 않는다. 컴포넌트에 진짜 터치 이벤트를
// 흘려보내고 화면이 무엇을 했는지만 본다.
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

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: SELF,
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
    onToggleReaction: jest.fn().mockResolvedValue(undefined),
    onEdit: jest.fn().mockResolvedValue(undefined),
    onDelete: jest.fn().mockResolvedValue(undefined),
    onOpenThread: jest.fn(),
    ...over,
  };
}

function renderRow({
  msg = message(),
  chips = [] as ReactionChip[],
  rowActions = actions(),
}: {
  msg?: Message;
  chips?: ReactionChip[];
  rowActions?: MessageRowActions | undefined;
} = {}) {
  render(
    <MessageRow
      message={msg}
      startsGroup
      directory={DIRECTORY}
      chips={chips}
      nowMs={BASE_MS}
      actions={rowActions}
    />,
  );
  return rowActions;
}

/** One touch, at a point, in PAGE coordinates — the ones the row measures. */
function touch(x: number, y: number) {
  return {nativeEvent: {pageX: x, pageY: y, locationX: x, locationY: y}};
}

/**
 * The gesture that opens the sheet, as a phone actually delivers it: a finger
 * lands, holds (the platform's timer fires), and the row decides.
 */
function longPress(jitterPx = 0) {
  const row = screen.getByTestId('message-row');
  fireEvent(row, 'touchStart', touch(100, 200));
  if (jitterPx > 0) fireEvent(row, 'touchMove', touch(100 + jitterPx, 200));
  fireEvent(screen.getByTestId('message-press'), 'longPress');
}

afterEach(cleanup);

describe('길게 누르기 — 스크롤은 누르기가 아니다', () => {
  // **이 테스트가 이 파일의 이유다.** 웹 1라운드는 이 방어를 주석으로 적어 두고
  // 실행하지 못했다: `origin`을 채운 직후 그것을 지워서 거리 판정이 한 번도 돌지
  // 않았고, 남은 방어는 브라우저가 스크롤을 확정했을 때뿐이었다. 그 임계 아래에서
  // 천천히 끌다 멈추는 손가락에는 아무 방어도 없었다 — 읽으려고 문지른 화면이
  // 시트를 열었다.
  it('한 번에 조금씩 40px을 끌면 시트가 열리지 않는다', () => {
    renderRow();
    const row = screen.getByTestId('message-row');

    fireEvent(row, 'touchStart', touch(100, 200));
    // 5회 × 8px = 40px. **직전 위치 기준이면 매번 8px이라 전부 통과한다** —
    // 이것이 이 방어를 우회하는 정확한 경로이고, 웹의 캡처 게이트가 실제 터치
    // 시퀀스로 재현한 수치 그대로다. 시작점 기준으로 재야만 3번째에서 걸린다.
    for (let step = 1; step <= 5; step++) {
      fireEvent(row, 'touchMove', touch(100 + step * 8, 200));
    }
    fireEvent(screen.getByTestId('message-press'), 'longPress');

    expect(screen.queryByTestId('message-action-sheet')).toBeNull();
  });

  // 경계를 양쪽에서 못 박는다. 한쪽만 재면 임계를 0으로 바꿔도, 무한대로 바꿔도
  // 테스트는 여전히 초록이다.
  it('임계 바로 위는 거부한다', () => {
    renderRow();
    longPress(MOVE_TOLERANCE_PX + 1);
    expect(screen.queryByTestId('message-action-sheet')).toBeNull();
  });

  it('임계 바로 아래는 연다', () => {
    renderRow();
    longPress(MOVE_TOLERANCE_PX - 1);
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
  });

  it('손을 뗐다가 다시 누르면 이전 제스처가 남아 있지 않다', () => {
    renderRow();
    const row = screen.getByTestId('message-row');
    fireEvent(row, 'touchStart', touch(100, 200));
    fireEvent(row, 'touchEnd', touch(100, 200));
    // 무장이 풀린 뒤 도착한 타이머는 아무것도 열지 않는다.
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    expect(screen.queryByTestId('message-action-sheet')).toBeNull();
  });

  it('스크롤이 제스처를 가져가면(touchCancel) 시트는 열리지 않는다', () => {
    renderRow();
    const row = screen.getByTestId('message-row');
    fireEvent(row, 'touchStart', touch(100, 200));
    fireEvent(row, 'touchCancel', touch(100, 200));
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    expect(screen.queryByTestId('message-action-sheet')).toBeNull();
  });

  it('가만히 누르면 열린다', () => {
    renderRow();
    longPress();
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
  });
});

describe('행이 내놓는 것 — 서버 규칙을 화면이 되풀이하지 않는다', () => {
  it('답글에는 「답글 달기」가 없다 (한 단계 스레드)', () => {
    // 서버가 "thread root must be a top-level message"로 거절하는 요청이므로,
    // 내놓으면 언제나 실패하는 버튼이 된다.
    renderRow({msg: message({rootId: 'root-1'})});
    longPress();
    expect(screen.queryByTestId('sheet-reply')).toBeNull();
  });

  it('남의 메시지에는 고치기·지우기가 없다', () => {
    renderRow({msg: message({authorMemberId: OTHER})});
    longPress();
    expect(screen.queryByTestId('sheet-edit')).toBeNull();
    expect(screen.queryByTestId('sheet-delete')).toBeNull();
    // 반응은 채널 멤버 누구나 할 수 있다.
    expect(screen.getByTestId('quick-reactions')).toBeTruthy();
  });

  it('삭제된 메시지에는 아무 액션도 없고 제스처 자체가 무장하지 않는다', () => {
    renderRow({msg: message({state: 'deleted', body: undefined})});
    longPress();
    expect(screen.queryByTestId('message-action-sheet')).toBeNull();
    expect(screen.getByTestId('tombstone')).toBeTruthy();
  });

  it('시트에는 보이는 닫기 경로가 있다', () => {
    renderRow();
    longPress();
    expect(screen.getByTestId('sheet-close')).toBeTruthy();
  });
});

describe('행당 접근성 요소는 하나다', () => {
  // 웹은 행마다 최대 6개의 탭 스톱을 깔았다가 Blocker 급으로 되돌렸다. iOS 에서
  // 같은 판정은 "행이 하나의 요소로 묶여 있는가"이고, 그 답은 컨테이너의
  // `accessible` 이다 — 묶이면 자식 Pressable 들은 VoiceOver 가 따로 세지 않는다.
  it('칩과 스레드 앵커가 있어도 행은 하나로 묶인다', () => {
    renderRow({
      msg: message({thread: {reply_count: 3, last_reply_seq: 9, last_reply_at: BASE_MS}}),
      chips: [
        {emoji: '👍', count: 2, mine: true},
        {emoji: '🎉', count: 1, mine: false},
      ],
    });
    const row = screen.getByTestId('message-row');
    expect(row.props.accessible).toBe(true);
    // 그리고 묶었으면 액션이 로터로 갈 곳이 있어야 한다 — 묶기만 하고 길을 내지
    // 않으면 그건 접근성을 없앤 것이다.
    const names = (row.props.accessibilityActions ?? []).map(
      (entry: {name: string}) => entry.name,
    );
    expect(names).toContain('momoActions');
    expect(names).toContain('momoThread');
  });

  it('로터의 액션이 실제로 시트를 연다', () => {
    renderRow();
    fireEvent(screen.getByTestId('message-row'), 'accessibilityAction', {
      nativeEvent: {actionName: 'momoActions'},
    });
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
  });
});

describe('낙관적 되돌림은 그 행에서 보인다', () => {
  it('반응이 실패하면 이유가 행에 남는다 — 토스트가 아니라', async () => {
    const rowActions = actions({
      onToggleReaction: jest.fn().mockRejectedValue(new ApiError(409, 'boom')),
    });
    renderRow({
      chips: [{emoji: '👍', count: 1, mine: false}],
      rowActions,
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('reaction-chip-👍'));
    });

    expect(rowActions.onToggleReaction).toHaveBeenCalled();
    const failure = screen.getByTestId('message-action-error');
    expect(failure).toBeTruthy();
  });

  it('409는 한도를 숫자로 말하고 다음 행동까지 말한다', async () => {
    renderRow({
      chips: [{emoji: '👍', count: 1, mine: false}],
      rowActions: actions({
        onToggleReaction: jest.fn().mockRejectedValue(new ApiError(409, 'limit')),
      }),
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('reaction-chip-👍'));
    });
    // 코어의 문구를 그대로 쓰는지 본다. 화면에서 문장을 새로 지으면 웹과 두 벌이 된다.
    expect(screen.getByText(/200개를 넘었습니다/)).toBeTruthy();
    expect(screen.getByText(/다시 눌러 보세요/)).toBeTruthy();
  });

  it('와이어 문장은 화면에 닿지 않는다', async () => {
    renderRow({
      chips: [{emoji: '👍', count: 1, mine: false}],
      rowActions: actions({
        onToggleReaction: jest
          .fn()
          .mockRejectedValue(new ApiError(403, 'not a member of this channel')),
      }),
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('reaction-chip-👍'));
    });
    expect(screen.queryByText(/not a member/)).toBeNull();
    expect(screen.getByText('이 채널의 멤버만 반응할 수 있습니다.')).toBeTruthy();
  });

  it('삭제가 실패하면 확인 시트가 닫히고 이유가 행에 남는다', async () => {
    const rowActions = actions({
      onDelete: jest.fn().mockRejectedValue(new ApiError(403, 'only the author')),
    });
    renderRow({rowActions});
    longPress();
    fireEvent.press(screen.getByTestId('sheet-delete'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('delete-confirm-button'));
    });
    expect(screen.queryByTestId('message-action-sheet')).toBeNull();
    expect(screen.getByText('내가 보낸 메시지만 지울 수 있습니다.')).toBeTruthy();
  });
});

describe('삭제는 확인을 거치고, 무엇이 남는지 먼저 말한다', () => {
  it('「지우기」는 바로 지우지 않는다', () => {
    const rowActions = actions();
    renderRow({rowActions});
    longPress();
    fireEvent.press(screen.getByTestId('sheet-delete'));
    expect(rowActions.onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-confirm')).toBeTruthy();
    // 누르기 전에 알아야 하는 두 가지.
    expect(screen.getByText(/되돌릴 수 없습니다/)).toBeTruthy();
    expect(screen.getByText(/반응도 함께 지워집니다/)).toBeTruthy();
  });

  it('확인을 눌러야 지워진다', async () => {
    const rowActions = actions();
    renderRow({rowActions});
    longPress();
    fireEvent.press(screen.getByTestId('sheet-delete'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('delete-confirm-button'));
    });
    expect(rowActions.onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('길게 눌러 연 뒤의 탭은 칩의 것이 아니다', () => {
  it('시트를 연 손가락을 떼도 반응이 토글되지 않는다', () => {
    const rowActions = actions();
    renderRow({chips: [{emoji: '👍', count: 1, mine: false}], rowActions});

    const row = screen.getByTestId('message-row');
    fireEvent(row, 'touchStart', touch(100, 200));
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    // 손을 떼면서 칩 위에서 press 가 울린다.
    fireEvent.press(screen.getByTestId('reaction-chip-👍'));

    expect(rowActions.onToggleReaction).not.toHaveBeenCalled();
  });
});

describe('tombstone 은 자리를 지키고 무게를 내려놓는다', () => {
  it('본문 크기가 아니라 메타 크기로 그린다', () => {
    render(
      <MessageRow
        message={message({state: 'deleted', body: undefined})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    const tombstone = screen.getByTestId('tombstone');
    const flat = Array.isArray(tombstone.props.style)
      ? Object.assign({}, ...tombstone.props.style.filter(Boolean))
      : tombstone.props.style;
    // 웹 R2 M5: 본문 크기로 두면 색만으로 본문과 갈리고, 흘깃 보면 내용으로 읽힌다.
    expect(flat.fontSize).toBeLessThan(16);
  });
});

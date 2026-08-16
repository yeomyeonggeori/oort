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

import {MessageBody} from '../src/features/conversation/MessageBody';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';

// =============================================================================
// 텍스트를 꺼낼 수 있는가 — BL-2 · H-9 (goal U4-b / #1049).
//
// ## 무엇이 없었나
//
// 폰에서 메시지 텍스트를 꺼낼 방법이 **하나도 없었다**. 선택은
// `selectable={!actionable}` 로 꺼져 있었고(액션이 하나라도 있는 행 = 사실상 모든
// 메시지), 시트에도 복사가 없었다. 에이전트가 준 명령어·해시·경로를 화면을 보고
// **손으로 옮겨 적어야** 했다.
//
// ## 이 파일이 지키는 것은 「무엇이 클립보드에 들어갔는가」다
//
// 「복사 버튼이 눌린다」는 쉽고 거의 틀리지 않는다. 틀리는 것은 **페이로드**다:
//
//   * 화면에 그려진 모양을 복사하면 → 마크다운 기호가 사라진 채로 붙는다.
//     사람이 꺼내려는 것은 저자가 친 원문이다.
//   * 코드 블록 복사에 펜스 마커가 따라가면 → 터미널에 ``` 가 붙는다.
//   * 시트의 복사와 코드 블록의 복사가 같은 것을 주면 → 둘 중 하나가 쓸모없다.
//     답 전체를 터미널에 붙이면 산문까지 따라간다.
//
// 그래서 클립보드를 스파이가 아니라 **상자**로 두었다(`jest.setup.js`): 무엇이
// 들어갔는지 물어볼 수 있어야 이 단정들이 성립한다.
// =============================================================================

const clipboard = jest.requireMock('expo-clipboard') as {
  __box: {value: string | null};
};

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

const ANSWER = [
  '**결론**: 재시작이 필요합니다',
  '',
  '```sh',
  'systemctl restart momo-relay',
  '```',
].join('\n');

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: ANSWER,
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
    ...over,
  };
}

/** 폰이 실제로 보내는 제스처. */
function longPress() {
  const point = {
    nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
  };
  fireEvent(screen.getByTestId('message-row'), 'touchStart', point);
  fireEvent(screen.getByTestId('message-press'), 'longPress');
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  clipboard.__box.value = null;
});
afterEach(cleanup);

describe('BL-2 — 메시지에서 텍스트가 나온다', () => {
  it('시트의 복사는 **저자가 친 원문**을 준다 — 그려진 모양이 아니라', async () => {
    // 사람이 붙여 넣을 곳은 대개 마크다운을 아는 자리가 아니라 터미널이고,
    // 그래도 원문이 맞다: 별표를 지운 채 붙이면 저자가 쓴 것과 달라진다.
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    longPress();
    fireEvent.press(screen.getByTestId('sheet-copy'));
    await flush();
    expect(clipboard.__box.value).toBe(ANSWER);
  });

  it('묘비는 복사를 제안하지 않는다 — 꺼낼 내용이 없다', () => {
    render(
      <MessageRow
        message={message({state: 'deleted', body: undefined})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({onQuote: jest.fn(), onOpenThread: () => {}})}
      />,
    );
    longPress();
    expect(screen.queryByTestId('sheet-copy')).toBeNull();
  });

  it('내용 없는 메시지도 복사를 제안하지 않는다', () => {
    // 빈 문자열을 클립보드에 넣는 것은 「복사했다」는 거짓말이다.
    render(
      <MessageRow
        message={message({body: ''})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({onOpenThread: () => {}})}
      />,
    );
    longPress();
    expect(screen.queryByTestId('sheet-copy')).toBeNull();
  });

  it('공백만 있는 본문도 마찬가지다 (#1478)', () => {
    // 공백을 클립보드에 넣는 것은 빈 문자열을 넣는 것과 같은 거짓말이다. 이 행이
    // 본문 칸을 만들지 말지 정하는 판정(코어 `hasRenderableBody`)과 **같은 판정**을
    // 쓴다 — 한 파일 안에서 같은 물음에 두 답을 두지 않는다.
    render(
      <MessageRow
        message={message({body: '   \n  '})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({onOpenThread: () => {}})}
      />,
    );
    longPress();
    expect(screen.queryByTestId('sheet-copy')).toBeNull();
  });
});

describe('H-9 — 코드 블록은 자기 복사를 갖는다', () => {
  it('상자 안의 코드만 준다 — 펜스도 산문도 따라오지 않는다', async () => {
    render(<MessageBody body={ANSWER} />);
    fireEvent.press(screen.getByTestId('code-copy'));
    await flush();
    expect(clipboard.__box.value).toBe('systemctl restart momo-relay');
    // 이 셋이 이 단정의 전부다.
    expect(clipboard.__box.value).not.toContain('```');
    expect(clipboard.__box.value).not.toContain('결론');
  });

  it('시트의 복사와 다른 것을 준다 — 둘 다 있을 이유가 그것이다', async () => {
    render(<MessageBody body={ANSWER} />);
    fireEvent.press(screen.getByTestId('code-copy'));
    await flush();
    expect(clipboard.__box.value).not.toBe(ANSWER);
  });

  it('누르면 한 순간 그렇게 말하고, 되돌아온다', async () => {
    jest.useFakeTimers();
    render(<MessageBody body={ANSWER} />);
    const button = screen.getByTestId('code-copy');
    expect(button.props.accessibilityLabel).toBe('코드 복사하기');

    fireEvent.press(button);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('code-copy').props.accessibilityLabel).toBe(
      '코드 복사됨',
    );

    // 안 되돌리면 그 상자는 영원히 「복사됨」이라고 말하는 상자가 된다.
    act(() => {
      jest.advanceTimersByTime(1_600);
    });
    expect(screen.getByTestId('code-copy').props.accessibilityLabel).toBe(
      '코드 복사하기',
    );
    jest.useRealTimers();
  });

  it('코드가 없으면 복사 버튼도 없다', () => {
    render(<MessageBody body={'그냥 한 줄'} />);
    expect(screen.queryByTestId('code-copy')).toBeNull();
  });
});

describe('선택 정책 — 모든 행에 길이 정확히 하나', () => {
  it('시트가 있는 행은 시트로 꺼낸다 — 선택은 끈다', () => {
    // iOS 의 선택은 그 자체가 길게 누르기라 시트와 같은 제스처를 다툰다.
    render(
      <MessageRow
        message={message({body: '평문입니다'})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    expect(screen.getByText('평문입니다').props.selectable).toBe(false);
    // 대신 시트에 길이 있다.
    longPress();
    expect(screen.getByTestId('sheet-copy')).toBeTruthy();
  });

  it('시트가 없는 행은 선택으로 꺼낸다', () => {
    // 읽기 전용 표면(측정 하네스·검색 미리보기). 여기에는 다툴 제스처가 없다.
    render(
      <MessageRow
        message={message({body: '평문입니다'})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    expect(screen.getByText('평문입니다').props.selectable).toBe(true);
  });
});

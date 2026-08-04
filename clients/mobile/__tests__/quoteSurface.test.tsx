import type {Message, RosterMember} from '@momo/core/lib/api';
import {
  QUOTE_ACTION_LABEL,
  QUOTE_DELETED_TEXT,
  QUOTE_NESTED_MARK,
  quoteDraftFor,
  type QuoteBlock as QuoteBlockModel,
} from '@momo/core/features/timeline/quote';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import {
  QuoteBlock,
  QuoteDraftBar,
  quoteAccessibilityPhrase,
} from '../src/features/conversation/Quote';

// =============================================================================
// 인용 표면 — 스레드와 **다른 장치로 읽히는가**, 그리고 정직한가.
//
// ADR-0148 이 만든 위험은 기능이 안 되는 것이 아니라 **둘이 섞이는 것**이다.
// 스레드는 대화를 옆으로 치우고 인용은 본류에 둔다 — 화면이 그 차이를 못 그리면
// 사람은 둘 중 하나를 안 쓰게 되고, 그러면 배치가 산 것은 아무것도 없다.
//
// 그래서 이 파일이 묻는 것은 「인용이 그려지는가」가 아니라:
//
//   1. 지워진 원본을 **지워졌다고 말하는가** (규칙 3 — 사본으로 우회하지 않는다)
//   2. **아직 못 푼 인용을 삭제로 부르지 않는가** ← 가장 위험한 자리다
//   3. 인용의 인용을 **펼치지 않는가** (규칙 4 — 계단을 만들지 않는다)
//   4. 갈 곳이 없을 때 **문을 그리지 않는가**
//   5. 낱말과 자름을 **폰이 지어내지 않는가** (코어가 정본)
//
// 2번은 실시간 경로에서만 나타난다: `message.new` 프레임에는 `reply_to` 가 없고
// (본문을 실으면 그것이 곧 금지된 스냅샷이다) `reply_to_id` 만 온다. 코어의
// `resolveQuote` 가 화면에 있는 행에서 못 찾으면 `unresolved` 를 돌려주는데, 그
// 갈래를 `deleted` 로 접으면 **멀쩡한 메시지를 지워졌다고 말하는 화면**이 된다.
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
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
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
    body: '그건 배포 뒤에 봅시다',
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

/** 코어가 만드는 블록만 쓴다 — 손으로 지은 블록은 코어가 안 만드는 모양일 수 있다. */
function readyBlock(over: Partial<Message> = {}): QuoteBlockModel {
  const draft = quoteDraftFor(
    message({id: 'orig-1', seq: 4, body: '배포 로그 확인했습니다', ...over}),
  );
  if (draft === null) throw new Error('fixture must be quotable');
  return draft.block;
}

const DELETED_BLOCK: QuoteBlockModel = {
  kind: 'deleted',
  targetId: 'orig-1',
  targetSeq: 4,
  authorMemberId: OTHER,
};

const UNRESOLVED_BLOCK: QuoteBlockModel = {
  kind: 'unresolved',
  targetId: 'orig-1',
  targetSeq: null,
};

afterEach(cleanup);

describe('인용 블록', () => {
  it('지워진 원본을 「삭제된 메시지」로 말한다 — 코어의 낱말로', () => {
    render(<QuoteBlock block={DELETED_BLOCK} directory={DIRECTORY} />);
    expect(screen.getByTestId('quote-tombstone').props.children).toBe(
      QUOTE_DELETED_TEXT,
    );
    expect(screen.queryByTestId('quote-body')).toBeNull();
  });

  it('아직 못 푼 인용을 삭제라고 부르지 않는다', () => {
    // 실시간으로 도착한 인용 답글의 자리. 「인용했다」는 참이므로 지우지 않고,
    // 「무엇을」은 모르므로 말하지 않는다. 이 둘을 접으면 화면이 거짓말한다.
    render(<QuoteBlock block={UNRESOLVED_BLOCK} directory={DIRECTORY} />);
    expect(screen.getByTestId('quote-unresolved')).toBeTruthy();
    expect(screen.queryByTestId('quote-tombstone')).toBeNull();
    expect(screen.queryByText(QUOTE_DELETED_TEXT)).toBeNull();
  });

  it('못 푼 인용에는 갈 곳이 없다 — onJump 가 있어도', () => {
    const onJump = jest.fn();
    render(
      <QuoteBlock
        block={UNRESOLVED_BLOCK}
        directory={DIRECTORY}
        onJump={onJump}
      />,
    );
    const block = screen.getByTestId('quote-block');
    expect(block.props.accessibilityRole).toBeUndefined();
    fireEvent.press(block);
    expect(onJump).not.toHaveBeenCalled();
  });

  it('지워진 원본에는 갈 수 있다 — 묘비는 그 자리에 남아 있다', () => {
    // 삭제와 미해결의 갈림이 여기서도 갈린다: 지워진 메시지는 **그 자리에**
    // 묘비로 남으므로 이동할 곳이 있고, 못 푼 것은 어디 있는지조차 모른다.
    const onJump = jest.fn();
    render(
      <QuoteBlock block={DELETED_BLOCK} directory={DIRECTORY} onJump={onJump} />,
    );
    fireEvent.press(screen.getByTestId('quote-block'));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('원본이 로드돼 있지 않으면 문장이다', () => {
    render(<QuoteBlock block={readyBlock()} directory={DIRECTORY} />);
    expect(
      screen.getByTestId('quote-block').props.accessibilityRole,
    ).toBeUndefined();
  });

  it('인용의 인용은 코어의 표시만 남기고 펼치지 않는다', () => {
    render(
      <QuoteBlock
        block={readyBlock({replyToId: 'deeper-1'})}
        directory={DIRECTORY}
      />,
    );
    expect(screen.getByTestId('quote-nested').props.children).toBe(
      QUOTE_NESTED_MARK,
    );
    expect(screen.getAllByTestId('quote-block')).toHaveLength(1);
  });

  it('원본이 수정됐으면 그렇게 말한다 — 인용은 참조라 따라 바뀐다', () => {
    render(
      <QuoteBlock block={readyBlock({state: 'edited'})} directory={DIRECTORY} />,
    );
    expect(screen.getByTestId('quote-edited')).toBeTruthy();
  });

  it('발췌는 코어가 자른 그대로 그린다 — 두 번째 자름을 만들지 않는다', () => {
    const block = readyBlock({body: '한 줄\n두 줄\n세 줄\n네 줄'});
    if (block.kind !== 'ready') throw new Error('ready');
    render(<QuoteBlock block={block} directory={DIRECTORY} />);
    expect(screen.getByTestId('quote-body').props.children).toEqual([
      block.lines.join('\n'),
      '…',
    ]);
    expect(block.truncated).toBe(true);
    // 여기서 `numberOfLines` 를 또 걸면 잘림이 두 곳에서 결정되고, 화면과
    // `truncated` 플래그가 어긋나는 순간이 생긴다.
    expect(screen.getByTestId('quote-body').props.numberOfLines).toBeUndefined();
  });

  it('본문이 공백뿐인 원본을 빈 칸으로 두지 않는다', () => {
    // 코어의 `normalizeLines` 가 빈 줄을 버리므로 줄이 하나도 없는 `ready`
    // 블록이 나온다. 묘비가 **아니므로** 삭제라 말할 수 없고, 빈 칸으로 두면
    // 블록이 이유 없이 자리만 차지한다.
    const block = readyBlock({body: '   \n\n  '});
    if (block.kind !== 'ready') throw new Error('ready');
    expect(block.lines).toHaveLength(0);
    render(<QuoteBlock block={block} directory={DIRECTORY} />);
    expect(screen.getByTestId('quote-body').props.children).toEqual([
      '내용 없는 메시지',
      '',
    ]);
    expect(screen.queryByTestId('quote-tombstone')).toBeNull();
    expect(quoteAccessibilityPhrase(block, DIRECTORY)).toBe(
      '김인턴 인용, 내용 없는 메시지',
    );
  });

  it('에이전트의 긴 출력은 종류 이름으로 대신한다', () => {
    const block = readyBlock({type: 'tool_call', body: '{"huge":"payload"}'});
    if (block.kind !== 'ready') throw new Error('ready');
    render(<QuoteBlock block={block} directory={DIRECTORY} />);
    expect(screen.getByTestId('quote-body').props.children).toEqual([
      '도구 실행',
      '',
    ]);
  });

  it('VoiceOver 문장은 「인용」이라고 말하고 「답글」이라 하지 않는다', () => {
    expect(quoteAccessibilityPhrase(readyBlock(), DIRECTORY)).toBe(
      '김인턴 인용, 배포 로그 확인했습니다',
    );
    expect(quoteAccessibilityPhrase(DELETED_BLOCK, DIRECTORY)).toBe(
      `김인턴 인용, ${QUOTE_DELETED_TEXT}`,
    );
    expect(quoteAccessibilityPhrase(readyBlock(), DIRECTORY)).not.toContain(
      '답글',
    );
  });
});

describe('컴포저의 인용 초안', () => {
  it('나오는 길이 있다 — 44pt 를 깔고 앉은 취소', () => {
    const onCancel = jest.fn();
    render(
      <QuoteDraftBar
        block={readyBlock()}
        directory={DIRECTORY}
        onCancel={onCancel}
      />,
    );
    const cancel = screen.getByTestId('quote-draft-cancel');
    const style = Array.isArray(cancel.props.style)
      ? Object.assign({}, ...cancel.props.style.filter(Boolean))
      : cancel.props.style;
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    fireEvent.press(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('한 줄이다 — 키보드가 올라온 폰에서 입력창을 밀어내지 않는다', () => {
    render(
      <QuoteDraftBar
        block={readyBlock({body: '한 줄\n두 줄\n세 줄'})}
        directory={DIRECTORY}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('quote-draft-body').props.numberOfLines).toBe(1);
  });

  it('인용해 둔 원본이 그 사이 지워지면 초안도 그렇게 말한다', () => {
    render(
      <QuoteDraftBar
        block={DELETED_BLOCK}
        directory={DIRECTORY}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('quote-draft-body').props.children).toBe(
      QUOTE_DELETED_TEXT,
    );
  });
});

// -----------------------------------------------------------------------------
// 행 위에서 — 스레드와 **함께 서도** 구별되는가
// -----------------------------------------------------------------------------

describe('행 위의 인용', () => {
  it('본문 위에 그려지고, 아무것도 조회하지 않는다', () => {
    // 재조회 금지가 이 배치의 하드 규칙이다: 서버가 페이지에 원문을 동봉하므로
    // (message.rs LEFT JOIN) 행이 따로 물어볼 이유가 없고, 물어보기 시작하면
    // 스크롤 한 번이 요청 폭풍이 된다. `projectShape.test.ts` 가 `src/` 안의
    // 직접 fetch 를 이미 금지하므로, 여기서 0 이면 코어를 경유한 조회도 없다.
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        quote={readyBlock()}
      />,
    );
    expect(screen.getByTestId('quote-block')).toBeTruthy();
    expect(screen.getByTestId('quote-body').props.children).toEqual([
      '배포 로그 확인했습니다',
      '',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('스레드 표식과 함께 서도 서로 다른 것으로 읽힌다', () => {
    // ADR-0148 규칙 1: 한 메시지가 둘 다 가질 수 있다. 그때가 가장 위험한
    // 순간이므로, 둘이 같은 행에 있을 때를 못박는다.
    render(
      <MessageRow
        message={message({rootId: 'root-1'})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        replyParent={message({id: 'root-1', seq: 1, body: '루트'})}
        quote={readyBlock()}
      />,
    );
    expect(screen.getByTestId('reply-marker')).toBeTruthy();
    expect(screen.getByTestId('quote-block')).toBeTruthy();
    // 표식은 「답글」이라 하고 블록은 그러지 않는다. 둘이 같은 낱말을 쓰기
    // 시작하면 화면에는 두 장치가 있지만 사람에게는 하나만 있다.
    expect(screen.getByText(/답글$/)).toBeTruthy();
    expect(screen.queryByText(/인용.*답글|답글.*인용/)).toBeNull();
  });

  it('묘비에는 인용을 붙이지 않는다', () => {
    render(
      <MessageRow
        message={message({state: 'deleted', body: undefined})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        quote={readyBlock()}
      />,
    );
    expect(screen.getByTestId('tombstone')).toBeTruthy();
    expect(screen.queryByTestId('quote-block')).toBeNull();
  });

  it('원본이 로드된 범위 안에 있을 때만 눌린다', () => {
    const onJumpToQuoted = jest.fn();
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        quote={readyBlock()}
        quoteReachable={false}
        actions={actions({onJumpToQuoted})}
      />,
    );
    fireEvent.press(screen.getByTestId('quote-block'));
    expect(onJumpToQuoted).not.toHaveBeenCalled();
  });

  it('로드돼 있으면 그 행을 들고 원본으로 보낸다', () => {
    const onJumpToQuoted = jest.fn();
    const row = message();
    render(
      <MessageRow
        message={row}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        quote={readyBlock()}
        quoteReachable
        actions={actions({onJumpToQuoted})}
      />,
    );
    fireEvent.press(screen.getByTestId('quote-block'));
    // 행은 자기 자신을 돌려준다 — 무엇이 로드돼 있는지는 페이지를 든 쪽만 안다.
    expect(onJumpToQuoted).toHaveBeenCalledWith(row);
  });

  it('VoiceOver 는 인용을 본문보다 **먼저** 듣는다', () => {
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        quote={readyBlock()}
      />,
    );
    const label: string = screen.getByTestId('message-row').props
      .accessibilityLabel;
    expect(label).toContain('김인턴 인용, 배포 로그 확인했습니다');
    expect(label.indexOf('인용')).toBeLessThan(label.indexOf('그건 배포 뒤에'));
  });
});

describe('인용 진입 — 액션 시트', () => {
  /** 폰이 실제로 보내는 제스처. `messageActions.test.tsx` 와 같은 모양이다. */
  function openSheet(over: Partial<MessageRowActions> = {}, msg = message()) {
    render(
      <MessageRow
        message={msg}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions(over)}
      />,
    );
    const point = {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    };
    fireEvent(screen.getByTestId('message-row'), 'touchStart', point);
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    // 시트가 실제로 열렸다는 것부터 확인한다 — 안 열린 화면에서
    // 「항목이 없다」는 아무것도 증명하지 못하는 초록이다.
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
  }

  it('낱말은 코어의 것이고, 답글과 나란히 선다', () => {
    const onQuote = jest.fn();
    const onOpenThread = jest.fn();
    openSheet({onQuote, onOpenThread});
    expect(screen.getByTestId('sheet-reply')).toBeTruthy();
    const quoteRow = screen.getByTestId('sheet-quote');
    expect(quoteRow.props.accessibilityLabel).toBe(QUOTE_ACTION_LABEL);
    fireEvent.press(quoteRow);
    expect(onQuote).toHaveBeenCalledTimes(1);
    // 인용은 스레드를 열지 않는다. 여기서 새면 두 장치가 하나가 된다.
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('이미 답글인 행도 인용할 수 있다 — 두 축은 독립이다', () => {
    // 코어 `model.ts` 가 이 문장을 적어 두었다. 답글이 불가능한 행에서 인용까지
    // 사라지면 ADR 이 나눈 두 장치가 UI 에서 다시 합쳐진 것이다.
    openSheet(
      {onQuote: jest.fn(), onOpenThread: () => {}},
      message({rootId: 'root-1'}),
    );
    expect(screen.queryByTestId('sheet-reply')).toBeNull();
    expect(screen.getByTestId('sheet-quote')).toBeTruthy();
  });

  it('핸들러가 없으면 항목이 아예 없다', () => {
    openSheet({onOpenThread: () => {}});
    expect(screen.queryByTestId('sheet-quote')).toBeNull();
  });

  it('묘비는 인용 진입을 제안하지 않는다 — 시트 자체가 열리지 않는다', () => {
    // `canQuoteMessage` 가 묘비를 뺀다(코어). 그 행에는 할 수 있는 일이 하나도
    // 남지 않으므로 시트는 아예 뜨지 않는다 — 눌러도 아무 일이 없는 제스처보다
    // 제스처가 없는 편이 낫다는, 이 파일 계열이 이미 고른 규칙이다.
    render(
      <MessageRow
        message={message({state: 'deleted', body: undefined})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({onQuote: jest.fn()})}
      />,
    );
    const point = {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    };
    fireEvent(screen.getByTestId('message-row'), 'touchStart', point);
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    expect(screen.queryByTestId('message-action-sheet')).toBeNull();
    expect(screen.queryByTestId('sheet-quote')).toBeNull();
  });
});

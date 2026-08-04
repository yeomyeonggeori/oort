import type {Message, RosterMember} from '@momo/core/lib/api';
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
  QUOTE_PREVIEW_LINES,
  quoteAccessibilityPhrase,
  type QuotePreview,
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
//   2. 인용의 인용을 **펼치지 않는가** (규칙 4 — 계단을 만들지 않는다)
//   3. 갈 곳이 없을 때 **문을 그리지 않는가** (없는 방으로 가는 문 금지)
//   4. 인용을 걸어 놓고 **나올 길이 있는가** (ADR 미결 3 · 성재의 "나오는 길")
//
// 코어 바인딩(`Message.replyTo`)은 B3W 가 랜딩한다. 이 파일은 그 값이 무엇이든
// **화면이 지킬 약속**을 먼저 못박는다 — 바인딩이 붙을 때 이 단정들이 그대로
// 서 있어야 한다.
// =============================================================================

function quote(over: Partial<QuotePreview> = {}): QuotePreview {
  return {authorLabel: '김인턴', body: '배포 로그 확인했습니다', deleted: false, ...over};
}

afterEach(cleanup);

describe('인용 블록', () => {
  it('지워진 원본을 「삭제된 메시지」로 말하고, 본문을 되살리지 않는다', () => {
    // 규칙 3 의 핵심: 스냅샷으로 굳히면 지운 사람의 의사를 우회하는 사본이 된다.
    // 그러므로 `deleted` 가 서면 `body` 가 함께 와도 그것을 그리면 안 된다.
    render(<QuoteBlock quote={quote({deleted: true, body: '지워진 원문'})} />);
    expect(screen.getByTestId('quote-tombstone')).toBeTruthy();
    expect(screen.queryByText('지워진 원문')).toBeNull();
    expect(screen.queryByTestId('quote-body')).toBeNull();
  });

  it('지워진 원본에는 문을 그리지 않는다 — onJump 가 있어도', () => {
    const onJump = jest.fn();
    render(<QuoteBlock quote={quote({deleted: true})} onJump={onJump} />);
    const block = screen.getByTestId('quote-block');
    // 묘비로 이동하는 것은 아무 데도 이동하지 않는 것이다. 눌리는 것처럼 보이면
    // 안 되고(역할 없음), 눌러도 아무 일이 없어야 한다.
    expect(block.props.accessibilityRole).toBeUndefined();
    fireEvent.press(block);
    expect(onJump).not.toHaveBeenCalled();
  });

  it('원본이 이 화면에 로드돼 있지 않으면 문장이다', () => {
    // 없는 방으로 가는 문은 방이 저기 있다고 말하는 문장보다 나쁘다.
    render(<QuoteBlock quote={quote()} />);
    expect(screen.getByTestId('quote-block').props.accessibilityRole).toBeUndefined();
  });

  it('원본이 로드돼 있으면 그리로 가는 버튼이다', () => {
    const onJump = jest.fn();
    render(<QuoteBlock quote={quote()} onJump={onJump} />);
    const block = screen.getByTestId('quote-block');
    expect(block.props.accessibilityRole).toBe('button');
    fireEvent.press(block);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('인용의 인용은 표시만 하고 펼치지 않는다', () => {
    render(<QuoteBlock quote={quote({quotesAnother: true})} />);
    expect(screen.getByTestId('quote-nested')).toBeTruthy();
    // 한 겹뿐이다. 블록 안에 또 다른 블록이 서면 계단이 시작된다.
    expect(screen.getAllByTestId('quote-block')).toHaveLength(1);
  });

  it('긴 원본은 잘리고, 그 임계는 이 파일이 아는 값이다', () => {
    render(
      <QuoteBlock
        quote={quote({body: '한 줄\n두 줄\n세 줄\n네 줄\n다섯 줄'})}
      />,
    );
    // 자르는 것은 `numberOfLines` 이지 문자열 절단이 아니다 — 문자열을 자르면
    // 접근성 트리에도 잘린 본문이 남고, 그것은 읽어 주는 쪽에 거짓말이 된다.
    expect(screen.getByTestId('quote-body').props.numberOfLines).toBe(
      QUOTE_PREVIEW_LINES,
    );
    expect(QUOTE_PREVIEW_LINES).toBeLessThan(5);
  });

  it('본문이 없는 원본을 빈 칸으로 두지 않는다', () => {
    render(<QuoteBlock quote={quote({body: '   '})} />);
    expect(screen.getByTestId('quote-body').props.children).toBe(
      '내용 없는 메시지',
    );
  });

  it('VoiceOver 문장은 「인용」이라고 말하고 본문을 들고 간다', () => {
    expect(quoteAccessibilityPhrase(quote())).toBe(
      '김인턴 인용, 배포 로그 확인했습니다',
    );
    expect(quoteAccessibilityPhrase(quote({deleted: true}))).toBe(
      '김인턴 인용, 삭제된 메시지',
    );
    // 「답글」이라는 낱말은 여기 오면 안 된다. 그것은 스레드의 것이고, 두 장치를
    // 같은 말로 부르는 순간 어휘 경계가 무너진다.
    expect(quoteAccessibilityPhrase(quote())).not.toContain('답글');
  });
});

describe('컴포저의 인용 초안', () => {
  it('나오는 길이 있다 — 44pt 를 깔고 앉은 취소', () => {
    const onCancel = jest.fn();
    render(<QuoteDraftBar quote={quote()} onCancel={onCancel} />);
    const cancel = screen.getByTestId('quote-draft-cancel');
    const style = Array.isArray(cancel.props.style)
      ? Object.assign({}, ...cancel.props.style.filter(Boolean))
      : cancel.props.style;
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    fireEvent.press(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('한 줄이다 — 키보드가 올라온 폰에서 입력창을 밀어내지 않는다', () => {
    render(<QuoteDraftBar quote={quote({body: '한 줄\n두 줄\n세 줄'})} onCancel={() => {}} />);
    expect(screen.getByTestId('quote-draft-body').props.numberOfLines).toBe(1);
  });

  it('인용해 둔 원본이 그 사이 지워지면 초안도 그렇게 말한다', () => {
    render(<QuoteDraftBar quote={quote({deleted: true})} onCancel={() => {}} />);
    expect(screen.getByTestId('quote-draft-body').props.children).toBe(
      '삭제된 메시지',
    );
  });
});

// -----------------------------------------------------------------------------
// 행 위에서 — 스레드와 **함께 서도** 구별되는가
// -----------------------------------------------------------------------------

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

describe('행 위의 인용', () => {
  it('본문 위에 그려지고, 아무것도 조회하지 않는다', () => {
    // 재조회 금지가 이 배치의 하드 규칙이다: 서버가 페이지에 원문을 동봉하므로
    // (message.rs LEFT JOIN) 행이 따로 물어볼 이유가 없고, 물어보기 시작하면
    // 스크롤 한 번이 요청 폭풍이 된다. 이 클라이언트에서 그것을 셀 수 있는 자리는
    // 전역 `fetch` 하나뿐이다 — `src/` 안에서 fetch 를 직접 부르는 것은
    // `projectShape.test.ts` 가 이미 금지하고 있으므로, 여기서 0 이면 코어를
    // 경유한 조회도 없다.
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        quote={quote()}
      />,
    );
    expect(screen.getByTestId('quote-block')).toBeTruthy();
    expect(screen.getByTestId('quote-body').props.children).toBe(
      '배포 로그 확인했습니다',
    );
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
        quote={quote()}
      />,
    );
    const marker = screen.getByTestId('reply-marker');
    const block = screen.getByTestId('quote-block');
    expect(marker).toBeTruthy();
    expect(block).toBeTruthy();
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
        quote={quote()}
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
        quote={quote()}
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
        quote={quote()}
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
        quote={quote()}
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

  it('핸들러가 오면 「인용해서 답하기」가 서고, 답글과 나란히 있다', () => {
    const onQuote = jest.fn();
    const onOpenThread = jest.fn();
    openSheet({onQuote, onOpenThread});
    expect(screen.getByTestId('sheet-reply')).toBeTruthy();
    const quoteRow = screen.getByTestId('sheet-quote');
    // 두 낱말이 **어디로 가는지**까지 말해야 폰에서 구별된다.
    expect(quoteRow.props.accessibilityLabel).toBe('인용해서 답하기');
    fireEvent.press(quoteRow);
    expect(onQuote).toHaveBeenCalledTimes(1);
    // 인용은 스레드를 열지 않는다. 여기서 새면 두 장치가 하나가 된다.
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('핸들러가 없으면 항목이 아예 없다', () => {
    openSheet({onOpenThread: () => {}});
    expect(screen.queryByTestId('sheet-quote')).toBeNull();
  });

  it('묘비는 인용 진입을 제안하지 않는다 — 시트 자체가 열리지 않는다', () => {
    // 인용만 걸어 두면 묘비도 길게 눌러 열리는 행이 되어 버린다. `canQuote` 가
    // 묘비를 빼기 때문에 그 행에는 할 수 있는 일이 하나도 남지 않고, 그러면
    // 시트는 아예 뜨지 않는다 — 눌러도 아무 일이 없는 제스처보다 제스처가 없는
    // 편이 낫다는, 이 파일 계열이 이미 고른 규칙이다.
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

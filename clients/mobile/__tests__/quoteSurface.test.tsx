import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

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

import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Text} from 'react-native';

import {Composer} from '../src/features/conversation/Composer';
import type {QuotePreview} from '../src/features/conversation/Quote';

// =============================================================================
// 컴포저가 새로 낸 두 개의 이음매 — 그리고 **한글이 아직 조합되는가**.
//
// 이 파일이 지키는 것은 기능이 아니라 **순서**다. `Composer.tsx` 머리말이 이
// 클라이언트에서 가장 비싸게 산 사실을 적어 두었다: 값 쓰기가 한 틱이라도 늦으면
// iOS 의 조합 세션이 끊기고 「안녕하세요」가 「ㅇㅏㄴㄴㅕㅇ…」이 된다. 성재의
// 아이폰에서 실측된 것이고, 고쳐서 아는 것이 아니라 겪어서 아는 것이다.
//
// 「작성 중」은 **키스트로크마다** 도는 신호다 — 즉 그 결함을 되살리기에 가장 좋은
// 모양을 하고 있다. 그래서 여기서 묻는 것은 "신호가 나가는가"가 아니라:
//
//   값이 먼저 쓰였는가. 신호는 그 **뒤에** 왔는가.
//
// 그리고 인용 초안 쪽은 하나만 묻는다: **나가는 길이 없으면 들어오는 길도 없다.**
// =============================================================================

const EMPTY = makeDirectory([]);

const QUOTE: QuotePreview = {
  authorLabel: '김인턴',
  body: '배포 로그 확인했습니다',
  deleted: false,
};

/** 부모가 신호를 실제로 받았는지 세는 자리. */
function TypingTicks({value}: {value: number}): React.JSX.Element {
  return <Text testID="typing-ticks">{value}</Text>;
}

function composer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <Composer
      channelLabel="배포"
      directory={EMPTY}
      onSend={() => {}}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe('작성 중 신호 — 값보다 늦게, 값을 건드리지 않고', () => {
  it('신호를 받은 화면이 **다시 그려져도** 조합이 살아남는다', () => {
    // 이것이 이 파일의 중심 단정이고, 실제 사용처의 모양 그대로다: 「작성 중」을
    // 받은 화면은 grant 를 잡고 타이머를 돌리며 **자기 상태를 바꾼다.** 그 상태
    // 변경은 컴포저를 다시 그리고, 다시 그려진 입력창이 옛 값을 들고 오면 그
    // 순간 조합이 끊긴다 — 값을 부모로 끌어올린 구현, 또는 `key` 가 흔들리는
    // 구현이 정확히 여기서 죽는다.
    //
    // 부모가 키스트로크마다 상태를 하나 올리는 것으로 그 압력을 만든다.
    function Host(): React.JSX.Element {
      const [ticks, setTicks] = React.useState(0);
      return (
        <>
          <Composer
            channelLabel="배포"
            directory={EMPTY}
            onSend={() => {}}
            onTyping={() => setTicks(current => current + 1)}
          />
          <TypingTicks value={ticks} />
        </>
      );
    }
    render(<Host />);
    const input = screen.getByTestId('composer-input');
    for (const value of ['ㅇ', '아', '안', '안ㄴ', '안녀', '안녕']) {
      fireEvent.changeText(input, value);
      expect(screen.getByTestId('composer-input').props.value).toBe(value);
    }
    // 그리고 신호는 실제로 부모까지 갔다 — 여섯 번.
    expect(screen.getByTestId('typing-ticks').props.children).toBe(6);
  });

  it('한 글자에 한 번이다 — 더도 덜도 아니다', () => {
    const onTyping = jest.fn();
    composer({onTyping});
    const input = screen.getByTestId('composer-input');
    for (const value of ['ㅇ', '아', '안', '안ㄴ', '안녀', '안녕']) {
      fireEvent.changeText(input, value);
    }
    expect(onTyping).toHaveBeenCalledTimes(6);
  });

  it('신호를 달아도 조합이 끊기지 않는다', () => {
    // `composerHangul.test.tsx` 가 값만으로 지키는 계약을, 신호가 붙은 채로 한 번
    // 더 통과시킨다. 실기기에서 잰 10-key 전이(꼬리가 두 글자인 구간 포함)를
    // 그대로 태운다.
    composer({onTyping: () => {}});
    const input = screen.getByTestId('composer-input');
    const keystrokes = [
      'ㅇ',
      '아',
      '안',
      '안ㄴ',
      '안녀',
      '안녕',
      '안녕ㅎ',
      '안녕하',
      '안녕핫',
      '안녕하ㅅ·',
      '안녕하서',
      '안녕하세',
      '안녕하셍',
      '안녕하세ㅇ·',
      '안녕하세요',
    ];
    for (const value of keystrokes) {
      fireEvent.changeText(input, value);
      // act() flush 없이, 그 자리에서. 늦게 쓰는 구현은 여기서 죽는다.
      expect(screen.getByTestId('composer-input').props.value).toBe(value);
    }
    expect(screen.getByTestId('composer-input').props.value).toBe('안녕하세요');
  });

  it('아무도 치지 않으면 아무 신호도 없다', () => {
    // 화면을 여는 것만으로 「작성 중」이 나가면, 채널을 훑어보는 사람이 전부
    // 치고 있는 것으로 보인다.
    const onTyping = jest.fn();
    composer({onTyping});
    expect(onTyping).not.toHaveBeenCalled();
  });

  it('신호를 안 받는 화면도 그대로 동작한다', () => {
    // 스레드 컴포저처럼 이 신호를 안 쓰는 자리가 있다. 없다고 터지면 안 된다.
    composer();
    const input = screen.getByTestId('composer-input');
    fireEvent.changeText(input, '안녕');
    expect(screen.getByTestId('composer-input').props.value).toBe('안녕');
  });
});

describe('인용 초안 — 나가는 길이 없으면 들어오는 길도 없다', () => {
  it('인용을 걸면 입력창 위에 뜨고, 취소가 함께 있다', () => {
    const onCancelQuote = jest.fn();
    composer({quote: QUOTE, onCancelQuote});
    expect(screen.getByTestId('quote-draft')).toBeTruthy();
    fireEvent.press(screen.getByTestId('quote-draft-cancel'));
    expect(onCancelQuote).toHaveBeenCalledTimes(1);
  });

  it('무를 방법이 없으면 초안을 그리지 않는다', () => {
    // ADR-0148 미결 3 · 성재 "채팅창 닫는 UX가 미흡". 취소 없는 인용은 사람을
    // 가둔다 — 그럴 바에는 걸리지 않은 것으로 보이는 편이 정직하다.
    composer({quote: QUOTE});
    expect(screen.queryByTestId('quote-draft')).toBeNull();
  });

  it('인용이 없으면 자리도 없다', () => {
    composer({quote: null, onCancelQuote: () => {}});
    expect(screen.queryByTestId('quote-draft')).toBeNull();
  });

  it('인용을 걸어도 보내기는 본문만 검사한다', () => {
    // 인용만 걸고 빈 채로 보내는 것은 「이 메시지를 가리키는 빈 메시지」다.
    // 서버는 받아 주겠지만 대화에 남는 것은 아무 말도 아닌 줄 하나다.
    const onSend = jest.fn();
    composer({quote: QUOTE, onCancelQuote: () => {}, onSend});
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByTestId('composer-input'), '확인했습니다');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith('확인했습니다');
  });
});

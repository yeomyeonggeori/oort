import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {Composer} from '../src/features/conversation/Composer';

// =============================================================================
// 입력하는 동안 햅틱이 울리지 않는다 (#4331)
//
// 실기(3053): 「채팅을 치면 진동하면서 …」. 대화 화면에서 햅틱을 부르는 코드는 `Composer` 의 **첨부 + 누름** 하나뿐이다
// (`haptics.light()`, 누르는 순간 한 번). 글자를 치고 줄을 바꾸고 보내는 길에는 없다 — 그래서 입력 중의 진동은 앱이 낸 것이 아니라
// iOS 의 키보드 햅틱(설정 ▸ 소리 및 햅틱 ▸ 키보드 피드백)이거나 화면 떨림이다.
//
// 이 시험은 그 사실을 **빨개질 수 있게** 잠근다: 같은 대역(`expo-haptics`)이 첨부 누름에서는 정확히 한 번 울리는 것을 먼저 보인 뒤,
// 치고·줄을 바꾸고·보내는 동안에는 한 번도 울리지 않음을 단정한다. 입력 길에 햅틱 호출이 생기면 붉어진다.
// =============================================================================

const hapticCalls = (jest.requireMock('expo-haptics') as {__calls: string[]}).__calls;

function mount(onSend: (body: string) => void = () => {}) {
  return render(
    <Composer
      recipient="place"
      channelLabel="배포"
      directory={makeDirectory([])}
      attachmentTarget={{workspaceId: 'ws', channelId: 'ch'}}
      onSend={onSend}
    />,
  );
}

beforeEach(() => {
  hapticCalls.length = 0;
});

afterEach(cleanup);

describe('입력 길의 햅틱은 전이와 보내기뿐이다 (#4331 → #4305)', () => {
  it('대조: 첨부 + 를 누르면 햅틱이 정확히 한 번 울린다 — 이 대역이 울림을 셀 수 있다', () => {
    mount();
    fireEvent.press(screen.getByTestId('composer-attach'));
    expect(hapticCalls).toHaveLength(1);
  });

  it('치고 · 줄을 바꾸고 · 지우고 · 보내는 동안 — 접힘 전이(selection)와 보내기(light) 말고는 울리지 않는다', () => {
    const sent: string[] = [];
    mount(body => sent.push(body));
    const input = screen.getByTestId('composer-input');
    // #4305: 비었다 → 글이 생기는 **그 한 번**만 selection(펼침). 펼친 채 치는 글자·줄바꿈·지움은 0번이다 —
    // 「입력 중 진동」의 원인이던 글자마다의 호출은 여전히 없다.
    fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요');
    expect(hapticCalls).toEqual(['selection']);
    fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요\n그 전에 시안부터 확인해 주세요');
    fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요\n그 전에 시안부터 확인해 주세요\n끝나면 여기에 남겨 둘게요');
    fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요');
    fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요\n한 줄 더');
    expect(hapticCalls).toEqual(['selection']);
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(sent).toEqual(['금요일 배포는 오후로 미룰게요\n한 줄 더']);
    // 보내기 = light 한 번. 접힘으로 돌아오는 전이는 selection 을 또 울리지 않는다.
    expect(hapticCalls).toEqual(['selection', 'impact:light']);
  });
});

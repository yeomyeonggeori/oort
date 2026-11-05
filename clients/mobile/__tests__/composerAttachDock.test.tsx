import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';

import {Composer} from '../src/features/conversation/Composer';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 입력창 첨부 (#5325, owner 11-05 폰 캡처 둘)
//
//   ① 자판이 올라온 채 + 가 안 눌린다. 원인(시뮬레이터 실측): 펼침(= 자판이 올라온 상태)에서만 서는 도구 줄(`composer-tools`)이 알약 폭 전체이고, 알약 바닥에 절대 배치된
//      + 원(`composer-attach`)보다 **뒤**에 그려져 그 위를 덮었다 — 그 줄이 + 위의 터치를 삼켰다. 보내기·표현 단추는 도구 줄 뒤에 있어 멀쩡했다.
//      Maestro `tapOn id: composer-attach` 는 COMPLETED 인데 메뉴(`attachment-pick-camera`)가 안 열렸고, 도구 줄에 `pointerEvents="box-none"` 한 줄로 열렸다.
//   ② 고른 사진의 미리보기가 입력창 **밖**(알약 위)에 섰다 → 알약 안, 글 줄 위의 작은 썸네일 줄로.
//   ③ 미리보기의 ✕ 가 너무 컸다(28pt 면) → 작은 원(보이는 크기를 줄이고 눌리는 면은 hitSlop 으로 44pt).
//
// jest 는 화면을 그리지도 터치를 맞히지도 않는다. 아래 단정은 렌더 결과(속성·트리 포함 관계·스타일 값)를 읽고, **실제로 눌리는가**는 Maestro 흐름
// (`maestro/5325-attach-in-pill.yaml`)이 잰다. 사보타주 표는 PR 본문.
// =============================================================================

const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | string | undefined>;

const TARGET = {workspaceId: 'ws-1', channelId: 'channel-1'};

function mount() {
  return render(
    <Composer
      recipient="place"
      channelLabel="general"
      directory={makeDirectory([])}
      attachmentTarget={TARGET}
      onSend={jest.fn()}
    />,
  );
}

const input = () => screen.getByTestId('composer-input');

beforeEach(() => {
  installAppClock();
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() => Promise.resolve(false));
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('자판이 올라온 채 + (#5325 ①)', () => {
  it('펼침(포커스)의 도구 줄은 터치를 삼키지 않는다 — 「@」 자식만 받는다(`box-none`)', () => {
    mount();
    // 접힘에는 도구 줄이 없다(대조): + 위를 덮을 것이 아예 없다.
    expect(screen.queryByTestId('composer-tools')).toBeNull();
    fireEvent(input(), 'focus');
    const tools = screen.getByTestId('composer-tools');
    // `pointerEvents` 가 `box-none` 이 아니면 이 줄이 + 원의 터치를 가로챈다.
    expect(tools.props.pointerEvents).toBe('box-none');
    // 그 줄 안의 「@」 는 여전히 눌린다(자식은 터치를 받는다).
    expect(screen.getByTestId('composer-tool-mention')).toBeTruthy();
    // + 원은 같은 알약 안에 있고 접힘·펼침 모두 눌릴 수 있다(`disabled` 아님).
    expect(flat(screen.getByTestId('composer-attach').props.style).position).toBe('absolute');
    expect(screen.getByTestId('composer-attach').props.accessibilityState).toMatchObject({disabled: false});
  });
});

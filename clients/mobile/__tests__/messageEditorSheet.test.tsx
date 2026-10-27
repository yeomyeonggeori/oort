import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet, TextInput} from 'react-native';

import {ds2Radius, lightPalette} from '../src/design/tokens';
import {MessageEditorSheet} from '../src/features/conversation/MessageEditorSheet';
import {describeCloseContract} from './fixtures/sheetContract';

// =============================================================================
// 메시지 고치기 시트 (#4458: 자체 Modal → 공용 시트). 입력 값이 동기인 규칙(한글 조합)은 컴포저와 같고,
// 옛 「취소」「저장」 글자 단추 행은 머리의 왼쪽 ✓(저장)와 오른쪽 원형 X(고치기 취소)가 됐다.
// =============================================================================

afterEach(() => {
  cleanup();
});

const cancel = jest.fn();
const save = jest.fn();
beforeEach(() => {
  cancel.mockReset();
  save.mockReset();
});

function mount(props: Partial<React.ComponentProps<typeof MessageEditorSheet>> = {}) {
  return render(
    <MessageEditorSheet
      initialBody="안녕하세요"
      onCancel={cancel}
      onSave={save}
      {...props}
    />,
  );
}

describe('머리의 ✓ = 저장', () => {
  it('바뀐 것이 없으면 회색이고 눌러도 저장하지 않는다', () => {
    mount();
    const confirm = screen.getByTestId('editor-save');
    expect(confirm.props.accessibilityLabel).toBe('저장');
    expect(confirm.props.accessibilityState).toMatchObject({disabled: true});
    fireEvent.press(confirm);
    expect(save).not.toHaveBeenCalled();
  });

  it('비우면(공백뿐) 다시 회색이고, 고치면 켜져서 앞뒤 공백을 뗀 글을 보낸다', () => {
    mount();
    fireEvent.changeText(screen.getByTestId('editor-input'), '   ');
    expect(screen.getByTestId('editor-save').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    fireEvent.changeText(screen.getByTestId('editor-input'), '  안녕하세요, 이도현 님  ');
    expect(screen.getByTestId('editor-save').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    fireEvent.press(screen.getByTestId('editor-save'));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('안녕하세요, 이도현 님');
  });

  it('저장하는 동안은 이름이 「저장 중」이고 잠기며, ✓ 자리의 스피너와 한 줄이 진행을 말한다', () => {
    mount({pending: true});
    fireEvent.changeText(screen.getByTestId('editor-input'), '다른 글');
    const confirm = screen.getByTestId('editor-save');
    expect(confirm.props.accessibilityLabel).toBe('저장 중');
    expect(confirm.props.accessibilityState).toMatchObject({disabled: true, busy: true});
    expect(screen.getByTestId('editor-save-busy')).toBeTruthy();
    expect(screen.getByTestId('editor-pending')).toHaveTextContent('저장 중');
    fireEvent.press(confirm);
    expect(save).not.toHaveBeenCalled();
  });

  it('실패 문장은 입력 아래에서 알림 역할로 선다', () => {
    mount({error: '지금은 고칠 수 없어요.'});
    const failure = screen.getByTestId('editor-error');
    expect(failure).toHaveTextContent('지금은 고칠 수 없어요.');
    expect(failure.props.accessibilityRole).toBe('alert');
  });
});

describe('입력', () => {
  it('값은 동기다 — onChangeText 한 번에 그 글이 그대로 선다(한글 조합이 끊기지 않는다)', () => {
    mount();
    const input = screen.getByTestId('editor-input');
    expect(input.props.value).toBe('안녕하세요');
    fireEvent.changeText(input, 'ㅇㅏㄴ');
    expect(screen.getByTestId('editor-input').props.value).toBe('ㅇㅏㄴ');
  });

  it('여러 줄이고 어절 단위로 줄바꿈하며, 입력 그릇만 선을 든다(textFaint 3:1) — 알약이 아니라 입력 반경이다', () => {
    mount();
    const input = screen.getByTestId('editor-input');
    expect(input.props.multiline).toBe(true);
    expect(input.props.lineBreakStrategyIOS).toBe('hangul-word');
    const style = StyleSheet.flatten(input.props.style);
    expect(style.borderColor).toBe(lightPalette.textFaint);
    expect(style.borderRadius).toBe(ds2Radius.row);
    expect(screen.UNSAFE_getAllByType(TextInput)).toHaveLength(1);
  });

  it('옛 「취소」「저장」 글자 단추는 없다', () => {
    mount();
    expect(screen.queryByText('취소')).toBeNull();
    expect(screen.queryByText('저장')).toBeNull();
    expect(screen.queryByText('닫기')).toBeNull();
  });
});

describe('그릇', () => {
  it('입력이 하나인 짧은 시트라 중간 단이다 — 키보드는 그릇이 피한다', () => {
    mount();
    const sheet = StyleSheet.flatten(screen.getByTestId('page-sheet').props.style);
    expect(sheet.top).toBeUndefined();
    expect(sheet.height).toBeGreaterThan(0);
  });
});

describeCloseContract({
  name: 'MessageEditorSheet',
  open: () => {
    mount();
  },
  closedCount: () => cancel.mock.calls.length,
  closeTestID: 'editor-cancel',
  closeLabel: '메시지 고치기 닫기',
  scrimTestID: 'editor-backdrop',
  scrimLabel: '고치기 취소',
});

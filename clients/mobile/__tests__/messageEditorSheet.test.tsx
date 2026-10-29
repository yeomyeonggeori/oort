import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {ActionSheetIOS, StyleSheet, TextInput} from 'react-native';

import {ds2Radius, lightPalette} from '../src/design/tokens';
import {MessageEditorSheet} from '../src/features/conversation/MessageEditorSheet';
import {
  FAR_SLOW_DRAG,
  describeCloseContract,
  dragBody,
  dragHeader,
  releaseReduceMotion,
  setReduceMotion,
} from './fixtures/sheetContract';

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

// 저장 안 한 입력(#4612): 고쳐 둔 채 닫으면 쓴 글이 사라진다 — 시트가 닫기 전에 「버릴까요?」를 묻는다(iOS isModalInPresentation).
describe('저장 안 한 입력 — 닫기 전에 「버릴까요?」', () => {
  beforeEach(async () => {
    await setReduceMotion(true); // 슬라이드 없이 바로 닫혀 「닫혔다」가 동기 단정이 된다
  });
  afterEach(() => {
    releaseReduceMotion();
  });

  const edit = (text: string) => {
    fireEvent.changeText(screen.getByTestId('editor-input'), text);
  };
  const askedOnce = (show: jest.SpyInstance) => show.mock.calls.length === 1;
  /** 묻는 액션 시트의 선택지 중 `index` 를 고른 것으로 한다(0 = 버리기, 1 = 계속 편집). */
  const choose = (show: jest.SpyInstance, index: number) => {
    act(() => {
      show.mock.calls[show.mock.calls.length - 1][1](index);
    });
  };

  it('고치지 않았으면 X·스크림·escape 가 묻지 않고 바로 닫는다 — 대조', () => {
    const show = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    mount();
    fireEvent.press(screen.getByTestId('editor-cancel'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
  });

  it('고친 뒤 X 는 닫지 않고 「버릴까요?」를 묻는다 — 「계속 편집」이면 그대로, 「버리기」면 닫는다', () => {
    const show = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    mount();
    edit('안녕하세요, 이도현 님');
    fireEvent.press(screen.getByTestId('editor-cancel'));
    expect(askedOnce(show)).toBe(true);
    expect(show.mock.calls[0][0]).toMatchObject({title: '버릴까요?', options: ['버리기', '계속 편집']});
    expect(cancel).not.toHaveBeenCalled();
    choose(show, 1);
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('editor-input').props.value).toBe('안녕하세요, 이도현 님'); // 쓴 글은 그대로
    fireEvent.press(screen.getByTestId('editor-cancel'));
    choose(show, 0);
    expect(cancel).toHaveBeenCalledTimes(1);
    show.mockRestore();
  });

  it('스크림·VoiceOver escape·머리 끌기·본문 끌기도 같은 문이다 — 닫지 않고 묻는다', () => {
    const show = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    mount();
    edit('다른 글');
    fireEvent.press(screen.getByTestId('editor-backdrop', {includeHiddenElements: true}));
    act(() => {
      screen.getByTestId('page-sheet').props.onAccessibilityEscape();
    });
    expect(dragHeader(FAR_SLOW_DRAG)).toBe(true);
    expect(dragBody(FAR_SLOW_DRAG)).toBe(true);
    expect(show).toHaveBeenCalledTimes(4);
    expect(cancel).not.toHaveBeenCalled();
    show.mockRestore();
  });

  // 한 마운트에서 X 를 두 번 누르지 않는다 — 첫 누름이 시트를 닫는 중으로 만들어 둘째는 무시된다.
  it('원문으로 되돌리면 고친 것이 아니다 — 묻지 않는다', () => {
    const show = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    mount();
    edit('다른 글');
    edit('안녕하세요');
    fireEvent.press(screen.getByTestId('editor-cancel'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
  });

  it('앞뒤 공백만 다르면 고친 것이 아니다 — 묻지 않는다(✓ 가 회색인 조건과 같다)', () => {
    const show = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    mount();
    edit('  안녕하세요  ');
    expect(screen.getByTestId('editor-save').props.accessibilityState).toMatchObject({disabled: true});
    fireEvent.press(screen.getByTestId('editor-cancel'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
  });

  it('전부 지워도 고친 것이다 — 저장은 막혀도 쓴 글이 사라지므로 묻는다', () => {
    const show = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    mount();
    edit('');
    expect(screen.getByTestId('editor-save').props.accessibilityState).toMatchObject({disabled: true});
    fireEvent.press(screen.getByTestId('editor-cancel'));
    expect(askedOnce(show)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    show.mockRestore();
  });

  it('저장하는 동안(pending)은 묻지 않는다 — 보내는 중이라 「저장하지 않은 내용」이 아니다', () => {
    const show = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    mount({pending: true});
    edit('다른 글');
    fireEvent.press(screen.getByTestId('editor-cancel'));
    expect(show).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    show.mockRestore();
  });

  it('✓ 저장은 묻지 않는다 — 저장은 닫는 길의 문이 아니라 행동이다', () => {
    const show = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    mount();
    edit('안녕하세요, 이도현 님');
    fireEvent.press(screen.getByTestId('editor-save'));
    expect(save).toHaveBeenCalledWith('안녕하세요, 이도현 님');
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
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

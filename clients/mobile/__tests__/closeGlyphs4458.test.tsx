import {cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {Image} from 'react-native';

import {NoticeBlock} from '../src/design/atoms';
import {SHEET_ICONS} from '../src/design/icons';

// =============================================================================
// 시트가 아닌 닫기(고지·카드)는 **같은 글리프만** 맞춘다 (#4458). 원형·그림자는 시트 머리의 것이고, 배너·카드는 글자 「닫기」
// 대신 시트와 같은 X(`SHEET_ICONS.close`)를 쓴다. 이름·testID·누름은 그대로다(소비자가 여섯 곳이다).
// 카드 둘(요약 카드·AI 연결 카드)은 각자의 시험 파일(`memoryUi`·`aiConnectCard`)이 잰다.
// =============================================================================

afterEach(cleanup);

describe('NoticeBlock 의 닫기', () => {
  it('글자 「닫기」가 아니라 시트와 같은 X 글리프이고, 이름·testID·누름은 그대로다', () => {
    const onDismiss = jest.fn();
    render(<NoticeBlock headline="검색 결과로 이동했어요" onDismiss={onDismiss} testID="notice" />);
    const dismiss = screen.getByTestId('notice-dismiss');
    expect(dismiss.props.accessibilityRole).toBe('button');
    expect(dismiss.props.accessibilityLabel).toBe('닫기');
    expect(within(dismiss).UNSAFE_getByType(Image).props.source).toBe(SHEET_ICONS.close);
    expect(screen.queryByText('닫기')).toBeNull();
    fireEvent.press(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('onDismiss 가 없으면 닫기가 없다 — 서버가 못 하는 일을 말하는 고지는 닫을 수 없다', () => {
    render(<NoticeBlock headline="이 서버는 아직 하지 않아요" testID="notice" />);
    expect(screen.queryByTestId('notice-dismiss')).toBeNull();
  });
});

import {act, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import {CONFIRM_ARM_MS, ConfirmStep} from '../src/design/sheetParts';

// =============================================================================
// 시트 안의 확인 단계: `confirmArmMs` 를 주면 위험 단추는 서고 나서 그 시간 동안 눌림을 받지 않는다(#5818 검수 High).
// 목록 줄을 누른 자리에 위험 단추가 서면 더블탭의 둘째 누름(250~400ms 뒤)이 읽기 전에 확정을 누르기 때문이다.
// 취소는 처음부터 받고, 시간을 주지 않은 단계(다른 확인 단계)는 지금까지처럼 바로 받는다.
// =============================================================================

function step(confirmArmMs: number | undefined, onConfirm: () => void, onCancel: () => void = () => undefined) {
  return render(
    <ConfirmStep
      headline="이 채널에서 나갈까요?"
      detail="design-lab 채널이 사이드바에서 사라져요."
      confirmLabel="채널 나가기"
      pendingLabel="나가는 중…"
      confirmArmMs={confirmArmMs}
      onCancel={onCancel}
      onConfirm={onConfirm}
      cancelTestID="cancel"
      confirmTestID="confirm"
    />,
  );
}

describe('ConfirmStep 의 확정 지연', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('서고 나서 500ms 안의 누름(0·250·400·499ms)은 확정을 누르지 못하고, 500ms 부터 받는다', () => {
    const onConfirm = jest.fn();
    step(CONFIRM_ARM_MS, onConfirm);
    for (const at of [0, 250, 150, 99]) {
      act(() => {
        jest.advanceTimersByTime(at);
      });
      fireEvent.press(screen.getByTestId('confirm'));
    }
    // 0 + 250 + 150 + 99 = 499ms 까지 누른 네 번.
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    fireEvent.press(screen.getByTestId('confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('취소는 처음부터 받는다', () => {
    const onCancel = jest.fn();
    step(CONFIRM_ARM_MS, jest.fn(), onCancel);
    fireEvent.press(screen.getByTestId('cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('시간을 주지 않은 확인 단계는 바로 받는다(다른 쓰임은 그대로)', () => {
    const onConfirm = jest.fn();
    step(undefined, onConfirm);
    fireEvent.press(screen.getByTestId('confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('모양은 그대로다: 지연 동안에도 단추는 잠긴 표시가 없다', () => {
    step(CONFIRM_ARM_MS, jest.fn());
    const state = screen.getByTestId('confirm').props.accessibilityState;
    expect(state.disabled).toBe(false);
  });
});

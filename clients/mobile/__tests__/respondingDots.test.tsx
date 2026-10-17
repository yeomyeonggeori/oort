import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Animated} from 'react-native';

import {RespondingDots} from '../src/features/agents/RespondingDots';

// #4020 — 「답하는 중」 점. 동작 줄이기가 켜져 있으면(모를 때도) 점이 움직이지 않는다.

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

async function mount(reduce: boolean) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduce);
  render(<RespondingDots />);
  // `useReduceMotion`의 첫 답이 한 틱 안에 온다.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('RespondingDots', () => {
  it('동작 줄이기가 꺼져 있으면 점 셋이 움직인다', async () => {
    const loop = jest.spyOn(Animated, 'loop');
    await mount(false);
    // 점마다 시계가 하나씩 돈다.
    expect(loop).toHaveBeenCalledTimes(3);
    const dots = screen.getAllByTestId('responding-dot-moving', {includeHiddenElements: true});
    expect(dots).toHaveLength(3);
    expect(screen.queryAllByTestId('responding-dot-still', {includeHiddenElements: true})).toHaveLength(0);
  });

  it('동작 줄이기가 켜져 있으면 점이 멈춘 채 선다', async () => {
    const loop = jest.spyOn(Animated, 'loop');
    await mount(true);
    // 표지만이 아니라 실제 시계가 돌지 않는다.
    expect(loop).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('responding-dot-still', {includeHiddenElements: true})).toHaveLength(3);
    expect(screen.queryAllByTestId('responding-dot-moving', {includeHiddenElements: true})).toHaveLength(0);
  });

  it('보조기술에는 나가지 않는다(문장이 상태를 말한다)', async () => {
    await mount(false);
    const row = screen.getByTestId('responding-dots', {includeHiddenElements: true});
    expect(row.props.accessibilityElementsHidden).toBe(true);
    expect(row.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});

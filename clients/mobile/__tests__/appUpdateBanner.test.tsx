import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import {
  AppUpdateBanner,
  AppUpdateSheet,
  updateDestination,
} from '../src/features/appUpdate/AppUpdateBanner';
import type {AppUpdateOffer} from '../src/features/appUpdate/feed';
import {TOUCH_TARGET} from '../src/design/tokens';
import {StyleSheet} from 'react-native';

const TF: AppUpdateOffer = {version: '0.1.29', latestBuild: 3036, currentBuild: 3035, testflight: true};
const STORE: AppUpdateOffer = {...TF, testflight: false};

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('배너', () => {
  it('새 버전과 지금 빌드를 말하고 「업데이트」 하나만 있다(닫기·나중에 없음)', () => {
    const onPress = jest.fn();
    render(<AppUpdateBanner offer={TF} onPress={onPress} testID="b" />);
    expect(screen.getByText('새 버전 0.1.29')).toBeTruthy();
    expect(screen.getByText('지금 쓰는 빌드는 3035이에요')).toBeTruthy();
    const action = screen.getByTestId('b-action');
    expect(action.props.accessibilityRole).toBe('button');
    expect(action.props.accessibilityLabel).toBe('업데이트, 새 버전 0.1.29');
    expect(screen.queryByText('닫기')).toBeNull();
    expect(screen.queryByText('나중에')).toBeNull();
    fireEvent.press(action);
    expect(onPress).toHaveBeenCalledTimes(1);
    // 누르는 면은 44pt 이상.
    const flat = StyleSheet.flatten(action.props.style);
    expect(flat.minHeight).toBe(TOUCH_TARGET);
  });
});

describe('시트', () => {
  it('TestFlight 판: 안내 문장과 [TestFlight 열기] 가 itms-beta:// 를 연다', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    render(<AppUpdateSheet offer={TF} onClose={jest.fn()} />);
    expect(screen.getByText('새 버전 0.1.29 (3036)')).toBeTruthy();
    expect(
      screen.getByText(
        'TestFlight 앱에서 업데이트를 눌러 주세요. 받은 뒤 oort를 다시 열면 새 버전이에요.',
      ),
    ).toBeTruthy();
    fireEvent.press(screen.getByText('TestFlight 열기'));
    expect(open).toHaveBeenCalledWith('itms-beta://');
  });

  it('스토어 판: 스토어 주소를 연다(자리표시 상수)', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    render(<AppUpdateSheet offer={STORE} onClose={jest.fn()} />);
    fireEvent.press(screen.getByText('App Store 열기'));
    expect(open).toHaveBeenCalledWith(updateDestination(STORE).url);
    expect(screen.queryByText('TestFlight 열기')).toBeNull();
  });

  it('열지 못하면 이유와 다음 행동을 한 줄로 말한다', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('nope'));
    render(<AppUpdateSheet offer={TF} onClose={jest.fn()} />);
    expect(screen.queryByTestId('app-update-sheet-failure')).toBeNull();
    fireEvent.press(screen.getByText('TestFlight 열기'));
    await waitFor(() => expect(screen.getByTestId('app-update-sheet-failure')).toBeTruthy());
    expect(screen.getByTestId('app-update-sheet-failure').props.children).toContain('직접 열어 주세요');
  });

  it('[닫기] 와 배경이 시트만 닫는다', () => {
    const onClose = jest.fn();
    render(<AppUpdateSheet offer={TF} onClose={onClose} />);
    fireEvent.press(screen.getByTestId('app-update-close'));
    fireEvent.press(
      screen.getByTestId('app-update-sheet-backdrop', {includeHiddenElements: true}),
    );
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import {
  AppUpdateBanner,
  AppUpdateSheet,
  updateDestination,
} from '../src/features/appUpdate/AppUpdateBanner';
import type {AppUpdateOffer} from '../src/features/appUpdate/feed';
import {OutlineButton, PrimaryButton} from '../src/design/atoms';
import {SHEET_ICONS} from '../src/design/icons';
import {GroupCard} from '../src/design/sheetParts';
import {TOUCH_TARGET} from '../src/design/tokens';
import {StyleSheet} from 'react-native';
import {describeCloseContract, imageSources} from './fixtures/sheetContract';

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

  it('안쪽은 공용 부품이다 — 안내 카드와 행동 행이고, 옛 채움·외곽선 글자 단추는 없다 (#4458)', () => {
    render(<AppUpdateSheet offer={TF} onClose={jest.fn()} />);
    expect(screen.UNSAFE_getAllByType(GroupCard)).toHaveLength(2);
    // 행동은 행 하나다 — **그려진** 모양으로 본다: 이름이 곧 이동처(「TestFlight 열기」)이고 오른쪽에 셰브론이 선다.
    const open = screen.getByTestId('app-update-open');
    expect(within(open).getByText('TestFlight 열기')).toBeTruthy();
    expect(imageSources(open)).toEqual([SHEET_ICONS.chevron]);
    expect(open.props.accessibilityRole).toBe('button');
    expect(screen.UNSAFE_queryAllByType(PrimaryButton)).toHaveLength(0);
    expect(screen.UNSAFE_queryAllByType(OutlineButton)).toHaveLength(0);
  });

  it('행동 행은 시트를 닫지 않는다 — 다른 앱으로 넘어갔다 돌아와도 안내가 남아 있다', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const onClose = jest.fn();
    render(<AppUpdateSheet offer={TF} onClose={onClose} />);
    fireEvent.press(screen.getByTestId('app-update-open'));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(onClose).not.toHaveBeenCalled();
  });
});

const closed = jest.fn();
beforeEach(() => closed.mockReset());

describeCloseContract({
  name: 'AppUpdateSheet',
  open: () => {
    render(<AppUpdateSheet offer={TF} onClose={closed} />);
  },
  closedCount: () => closed.mock.calls.length,
  closeTestID: 'app-update-close',
  closeLabel: '업데이트 안내 닫기',
  scrimTestID: 'app-update-sheet-backdrop',
  scrimLabel: '업데이트 안내 닫기',
});

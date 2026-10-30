import {execFileSync} from 'child_process';
import {mkdtempSync, readdirSync, rmdirSync, unlinkSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import React from 'react';
import {Dimensions, StyleSheet, View} from 'react-native';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {FixedScheme} from '../src/design/theme';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';

// Jest에는 레이아웃이 없다. 앱에 포함된 Yoga를 단독 실행해 onLayout 입력과 배치 결과를 얻는다.
// 글자 실측은 하지 않는다. AX3에서 줄이 자란 경우까지 줄 높이 fixture로 준다.
// iOS 앱·시뮬레이터·Xcode 빌드 없이 시험 전용 임시 디렉터리에서만 실행한다.
let binary: string;
let directory: string;
const windowBefore = Dimensions.get('window');
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'oort-4839-layout-'));
  binary = path.join(directory, 'layout');
  const yoga = path.resolve(__dirname, '../node_modules/react-native/ReactCommon/yoga');
  const sources = readdirSync(path.join(yoga, 'yoga'), {recursive: true})
    .filter(name => String(name).endsWith('.cpp')).map(name => path.join(yoga, 'yoga', String(name)));
  execFileSync('c++', ['-std=c++20', '-O0', `-I${yoga}`,
    path.resolve(__dirname, '../measure/header-banner-layout.cpp'), ...sources, '-o', binary], {timeout: 60_000});
}, 70_000);
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  Dimensions.set({window: windowBefore, screen: windowBefore});
});
afterAll(() => {
  if (binary) unlinkSync(binary);
  if (directory) rmdirSync(directory);
});

function layout(paddingTop: number, rowHeight: number, summary: number, top: unknown): {
  headerHeight: number; rowBottom: number; bannerTop: number;
} {
  return JSON.parse(execFileSync(binary, [String(paddingTop), String(rowHeight), String(summary), String(top)], {encoding: 'utf8'}));
}

it.each(['light', 'dark'] as const)('머리 아래에서 띠가 시작한다 — Yoga 배치 + onLayout, 기본·AX3 (%s)', scheme => {
  jest.spyOn(jest.requireMock('react-native-safe-area-context'), 'useSafeAreaInsets')
    .mockReturnValue({top: 62, bottom: 34, left: 0, right: 0});
  for (const fontScale of [1, 3.12]) {
    const window = {...windowBefore, width: 393, fontScale};
    Dimensions.set({window, screen: window});
    const mounted = render(
      <FixedScheme scheme={scheme}>
        <ConversationHeader title="대화" kind="dm" directory={makeDirectory([])} onBack={() => {}} railStatus="disconnected">
          <View />
        </ConversationHeader>
      </FixedScheme>,
    );
    const header = screen.getByTestId('conversation-header');
    const paddingTop = StyleSheet.flatten(header.props.style).paddingTop;
    const rowMinimum = StyleSheet.flatten(screen.getByTestId('conversation-header-row').props.style).minHeight;
    const rowHeight = fontScale === 1 ? rowMinimum : rowMinimum + 14;
    for (const summary of [0, 48]) {
      const measured = layout(paddingTop, rowHeight, summary, 0);
      fireEvent(header, 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 393, height: measured.headerHeight}}});
      const bannerStyle = StyleSheet.flatten(screen.getByTestId('connection-banner-layer').props.style);
      const placed = layout(paddingTop, rowHeight, summary, bannerStyle.top);
      // Yoga가 출력한 배치 좌표를 비교한다. 옛 top:'100%'로 되돌리면 빨개진다.
      expect(placed.bannerTop).toBeGreaterThanOrEqual(placed.rowBottom);
      expect(placed.bannerTop).toBe(measured.headerHeight);
      // 대조군: 같은 엔진·부모·자식에서 옛 위치는 안전 영역만큼 겹친다.
      expect(layout(paddingTop, rowHeight, summary, '100%').bannerTop).toBeLessThan(placed.rowBottom + summary);
    }
    mounted.unmount();
  }
});

// #5329 — 두 + 메뉴(홈 `PlusMenu` · 대화 `AttachMenu`)가 고른 테마를 따른다.
//
// 결함: 두 메뉴가 **주 행동 색**(`primary`/`onPrimary`, 잉크 반전)을 그릇에 썼다. 다크에서 primary 는 밝은 잉크라
// 어두운 화면 위에 흰 판이 떴고, 라이트에서는 반대로 검은 판이 떴다. 판단 기준은 값이 아니라 **방향**이다:
// 어두운 모드의 그릇은 어둡고(글자보다 어둡고) 밝은 모드의 그릇은 밝다. 잉크 반전이면 두 모드 모두 방향이 뒤집혀 붉다.
//
// 이 시험이 재는 것: 렌더된 스타일의 색(그릇·행·글자·아이콘·그림자)이 테마 토큰 그대로인가, 그리고 그 방향.
// 못 재는 것: 흐림(`expo-blur`)이 실제로 뒤를 비치는 모습과 유리 위 글자의 실제 대비 — 시뮬레이터 캡처의 몫이다
// (아래 최악 합성은 순흑·순백 위 상한일 뿐 렌더 대비가 아니다).

import {contrast, luminance} from '@momo/core/design/color';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, StyleSheet, type View} from 'react-native';

import {DS2_COMBOS} from '../src/design/ds2Tokens';
import {resetBlurSupportForTests} from '../src/design/glass';
import {FixedScheme} from '../src/design/theme';
import {paletteFrom, type Palette} from '../src/design/tokens';
import {AttachMenu} from '../src/features/attachments/AttachMenu';
import {PlusMenu, type PlusMenuItem} from '../src/shell/PlusMenu';
import {installAppClock} from './fixtures/fakeClock';

/** WCAG 대비가 같아지는 휘도 — 순흑에 더 가까운가 순백에 더 가까운가를 가르는 중간. */
const MID_LUMINANCE = 0.179;

type Style = Record<string, unknown>;

const flat = (testID: string): Style =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style) as Style;
const textStyle = (label: string): Style =>
  StyleSheet.flatten(screen.getByText(label).props.style) as Style;

/** 합성 `Pressable` 의 style 함수를 눌림 상태로 불러 읽는다(`shellChrome.test.tsx` 와 같은 길). */
function pressedFill(testID: string): unknown {
  const pressable = screen
    .UNSAFE_getAllByProps({testID})
    .find(node => typeof node.props.style === 'function');
  return StyleSheet.flatten(pressable!.props.style({pressed: true})).backgroundColor;
}

/** `#rrggbbaa` 를 불투명한 `#rrggbb` 위에 합성한다(`shellChrome.test.tsx` 의 `over` 와 같은 산수). */
function over(layer: string, base: string): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const alpha = parseInt(layer.slice(7, 9), 16) / 255;
  return (
    '#' +
    [0, 1, 2]
      .map(i =>
        Math.round(alpha * channel(layer, i) + (1 - alpha) * channel(base, i))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** 그릇이 모드의 방향을 지키는가: 다크는 순흑 쪽, 라이트는 순백 쪽이고 글자와는 반대편에 선다. */
function expectPlateFollowsMode(p: Palette, plate: string, label: string) {
  const plateLuminance = luminance(plate);
  const labelLuminance = luminance(label);
  if (p.mode === 'dark') {
    expect(plateLuminance).toBeLessThan(MID_LUMINANCE);
    expect(plateLuminance).toBeLessThan(labelLuminance);
  } else {
    expect(plateLuminance).toBeGreaterThan(MID_LUMINANCE);
    expect(plateLuminance).toBeGreaterThan(labelLuminance);
  }
}

const reduceTransparency = AccessibilityInfo as unknown as {
  isReduceTransparencyEnabled: jest.Mock;
  isReduceMotionEnabled: jest.Mock;
};

beforeEach(() => {
  installAppClock();
  reduceTransparency.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
  reduceTransparency.isReduceTransparencyEnabled.mockImplementation(() =>
    Promise.resolve(false),
  );
});

afterEach(() => {
  cleanup();
  resetBlurSupportForTests();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ---- 홈 + 메뉴 ---------------------------------------------------------------------

const ITEMS: PlusMenuItem[] = [
  {key: 'dm', icon: 'dm', label: '새 DM', hint: '사람을 골라요', onPress: jest.fn()},
  {key: 'channel', icon: 'channel', label: '새 채널', hint: '채널을 만들어요', onPress: jest.fn()},
  {key: 'ai', icon: 'agent', label: 'AI', hint: 'AI 를 열어요', onPress: jest.fn()},
  {key: 'work', icon: 'work', label: '작업', hint: '작업을 열어요', onPress: jest.fn()},
];

describe.each(DS2_COMBOS)('%s %s — 홈 + 메뉴(PlusMenu)가 테마를 따른다 (#5329)', (theme, mode) => {
  const p = paletteFrom(theme, mode);

  it('그릇은 surface · 행 타일은 text 8%(눌림 16%) · 글자와 아이콘은 text · 그림자는 elevationFloat 이다', () => {
    render(
      <FixedScheme theme={theme} scheme={mode}>
        <PlusMenu items={ITEMS} onClose={jest.fn()} />
      </FixedScheme>,
    );
    const menu = flat('plus-menu');
    expect(menu.backgroundColor).toBe(p.surface);
    expect(menu.boxShadow).toBe(p.elevationFloat);
    for (const item of ITEMS) {
      expect([item.key, flat(`plus-menu-${item.key}`).backgroundColor]).toEqual([
        item.key,
        `${p.text}14`,
      ]);
      expect([item.key, pressedFill(`plus-menu-${item.key}`)]).toEqual([item.key, `${p.text}29`]);
      expect([item.key, flat(`plus-menu-${item.key}-icon`).tintColor]).toEqual([item.key, p.text]);
      expect([item.key, textStyle(item.label).color]).toEqual([item.key, p.text]);
    }
  });

  it('어두운 모드의 그릇은 어둡고 밝은 모드의 그릇은 밝다 — 주 행동 색(잉크 반전)이면 방향이 뒤집힌다', () => {
    render(
      <FixedScheme theme={theme} scheme={mode}>
        <PlusMenu items={ITEMS} onClose={jest.fn()} />
      </FixedScheme>,
    );
    const plate = flat('plus-menu').backgroundColor as string;
    expectPlateFollowsMode(p, plate, textStyle('새 DM').color as string);
    // 글자는 행 타일(그릇 위 text 8%) 위에서도 읽힌다.
    for (const alpha of ['14', '29']) {
      const tile = over(`${p.text}${alpha}`, plate);
      expect([alpha, contrast(p.text, tile) >= 4.5]).toEqual([alpha, true]);
    }
  });
});

// ---- 대화 + 첨부 메뉴 --------------------------------------------------------------------

/** 측정이 바로 답하는 + 원 대역(`attachMenu.test.tsx` 의 `fakeAnchor` 와 같다). */
function fakeAnchor() {
  return {
    current: {
      props: {accessibilityLabel: '파일 첨부'},
      measureInWindow: (done: (x: number, y: number, w: number, h: number) => void) =>
        done(50, 801.5, 35, 35),
    } as unknown as View,
  };
}

function renderAttach(theme: (typeof DS2_COMBOS)[number][0], mode: 'light' | 'dark') {
  return render(
    <FixedScheme theme={theme} scheme={mode}>
      <AttachMenu
        visible
        anchorRef={fakeAnchor()}
        onClose={jest.fn()}
        onPickCamera={jest.fn()}
        onPickPhoto={jest.fn()}
        onPickFile={jest.fn()}
      />
    </FixedScheme>,
  );
}

const ATTACH_ROWS = [
  ['attachment-pick-camera', '카메라'],
  ['attachment-pick-photo', '사진'],
  ['attachment-pick-file', '파일'],
] as const;

describe.each(DS2_COMBOS)('%s %s — 대화 + 첨부 메뉴(AttachMenu)가 테마를 따른다 (#5329)', (theme, mode) => {
  const p = paletteFrom(theme, mode);

  it('재질 세 갈래의 면은 대체 glassFallback · 흐림 glass · 불투명 surface 이고, 글자·아이콘·눌림은 text 다', async () => {
    // 흐림 모듈이 없는 판(기본): 대체.
    const fallback = renderAttach(theme, mode);
    expect(flat('attach-menu-material-fallback').backgroundColor).toBe(p.glassFallback);
    for (const [row, label] of ATTACH_ROWS) {
      expect([row, textStyle(label).color]).toEqual([row, p.text]);
      expect([row, flat(`${row}-icon`).tintColor]).toEqual([row, p.text]);
      expect([row, pressedFill(row)]).toEqual([row, `${p.text}29`]);
    }
    expect(flat('attach-menu').boxShadow).toBe(p.elevationFloat);
    fallback.unmount();

    // 흐림이 있는 판: 흐림 위에 유리 틴트, 흐림의 틴트는 앱 스킴을 따른다.
    resetBlurSupportForTests(true);
    const blur = renderAttach(theme, mode);
    expect(flat('attach-menu-material-blur').backgroundColor).toBe(p.glass);
    expect(screen.getByTestId('blur-view')).toHaveProp('tint', p.mode);
    blur.unmount();

    // 투명도 줄이기: 흐림이 있어도 불투명 surface.
    reduceTransparency.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(true));
    renderAttach(theme, mode);
    await act(async () => {});
    expect(screen.queryByTestId('blur-view')).toBeNull();
    expect(flat('attach-menu-material-opaque').backgroundColor).toBe(p.surface);
  });

  it('어두운 모드의 면은 어둡고 밝은 모드의 면은 밝다 — 유리는 순흑·순백 위 최악 합성에서도 글자가 4.5:1 을 넘는다', () => {
    // 세 면의 바탕색(유리·대체는 알파를 뗀 색)이 모드의 방향을 지킨다.
    expectPlateFollowsMode(p, p.glass.slice(0, 7), p.text);
    expectPlateFollowsMode(p, p.glassFallback.slice(0, 7), p.text);
    expectPlateFollowsMode(p, p.surface, p.text);
    // 최악 합성: 면을 글자 쪽으로 가장 멀리 밀어내는 뒤는 어두운 모드에서 순백, 밝은 모드에서 순흑이다.
    const worstBackdrop = p.mode === 'dark' ? '#ffffff' : '#000000';
    for (const [where, plate] of [
      ['glass', over(p.glass, worstBackdrop)],
      ['glassFallback', over(p.glassFallback, worstBackdrop)],
      ['surface', p.surface],
    ] as const) {
      expect([where, contrast(p.text, plate) >= 4.5]).toEqual([where, true]);
    }
  });
});

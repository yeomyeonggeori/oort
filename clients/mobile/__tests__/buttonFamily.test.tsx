import {contrast} from '@momo/core/design/color';
import {render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {ActivityIndicator, StyleSheet} from 'react-native';

import {resolveAppearance} from '../src/design/appearanceState';
import {
  BUTTON_MAX_SCALE,
  buttonInk,
  DangerButton,
  OutlineButton,
  PrimaryButton,
  QuietButton,
  type ButtonKind,
  type ButtonProps,
} from '../src/design/atoms';
import {DS2_COMBOS} from '../src/design/ds2Tokens';
import {circleLook} from '../src/design/sheetModel';
import {FixedScheme} from '../src/design/theme';
import {
  BUTTON,
  DISABLED_OPACITY,
  font,
  PRESSED_OPACITY,
  radius,
  TOUCH_TARGET,
  type Palette,
} from '../src/design/tokens';

// =============================================================================
// 폰 단추 네 종류의 규격 표 (#6075) — `docs/design-system/components.md` 「폰 단추」 절.
//
// 이 파일이 그 절의 주인 시험이다. 종류 4 × 상태 4(쉼 · 눌림 · 잠김 · 진행 중) × 크기 2 를 **그려서** 렌더된 style 을 규격 표와
// 맞댄다 — 소스의 이름이 아니라 값이다. 테마 3 × 모드 2 위에서 돈다(채움 · 글자색은 팔레트 역할이라 조합마다 다른 값이다).
//
// 지키는 것과 그것을 깨는 그럴듯한 뒷걸음:
//   · 알약 모서리 · 높이 44/38 · 옆 여백 20/16 — 한 종류만 반경 14 로 돌아가거나 작게가 30 으로 줄면 빨갛다.
//   · 눌림 0.6 · 잠김 0.55 이고 **채움을 갈아 끼우지 않는다** — 잠김에 옛 옅은 칸(`circleLook` 채움)을 되살리면 빨갛다.
//   · 진행 중은 채움 그대로 + 표시기 + 낱말, 흐리지 않는다 — `busy` 에 잠김 흐림을 입히면 빨갛다.
//   · 누르는 자리 44 — 작게(38)에서 슬롭을 빼면 빨갛다.
//   · 낱말의 큰 글자 상한 — 상한을 빼면 빨갛다.
// 주 단추가 잉크이고 신호색이 칠하지 않는다는 것(48 조합)은 `primaryButton.test.tsx` 가 잰다.
// =============================================================================

type Style = Record<string, unknown>;

const FACES: ReadonlyArray<readonly [ButtonKind, (buttonProps: ButtonProps) => React.JSX.Element]> = [
  ['primary', PrimaryButton],
  ['secondary', OutlineButton],
  ['quiet', QuietButton],
  ['danger', DangerButton],
];

/** 규격 표의 채움 — 종류마다 팔레트 역할 하나. 조용한 단추는 채움이 없다. */
function specFill(palette: Palette, kind: ButtonKind): unknown {
  switch (kind) {
    case 'primary':
      return palette.primary;
    case 'secondary':
      return circleLook(palette).fill;
    case 'quiet':
      return undefined;
    case 'danger':
      return palette.dangerFill;
  }
}

/** 규격 표의 글자색. */
function specInk(palette: Palette, kind: ButtonKind): string {
  return kind === 'primary' ? palette.onPrimary : kind === 'danger' ? palette.onDangerFill : palette.text;
}

const COMBOS = DS2_COMBOS.map(([theme, mode]) => ({
  key: `${theme}/${mode}`,
  theme,
  mode,
  palette: resolveAppearance(theme, mode, null).palette,
}));

function pressableStyle(testID: string, pressed: boolean): Style {
  type Node = {props: Record<string, any>; parent: Node | null};
  let node: Node | null = screen.getByTestId(testID) as unknown as Node;
  while (node !== null && typeof node.props.style !== 'function') node = node.parent;
  if (node === null) throw new Error(`${testID}: Pressable style 함수를 찾지 못했다`);
  return StyleSheet.flatten(node.props.style({pressed})) as Style;
}

function labelOf(testID: string, text: string) {
  return within(screen.getByTestId(testID)).getByText(text);
}

describe('폰 단추 네 종류 — 규격 표 (#6075)', () => {
  it('쉼 · 눌림 · 잠김 · 진행 중이 규격 값이다 — 종류 4 × 조합 6', () => {
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      for (const [kind, Face] of FACES) {
        const tag = `${combo.key} · ${kind}`;
        const view = render(
          <FixedScheme scheme={combo.mode} theme={combo.theme}>
            <Face label="저장" onPress={() => {}} testID="rest" />
            <Face label="저장" disabled onPress={() => {}} testID="locked" />
            <Face label="저장" busy busyLabel="저장 중" onPress={() => {}} testID="busy" />
            <Face label="저장" busy busyLabel="저장 중" disabled onPress={() => {}} testID="busyLocked" />
          </FixedScheme>,
        );
        const rest = pressableStyle('rest', false);
        const pressed = pressableStyle('rest', true);
        const locked = pressableStyle('locked', false);
        const lockedPressed = pressableStyle('locked', true);
        const fill = specFill(combo.palette, kind);
        const ink = specInk(combo.palette, kind);
        // 쉼
        if (rest.backgroundColor !== fill) wrong.push(`${tag}: 쉼 채움 ${String(rest.backgroundColor)} ≠ ${String(fill)}`);
        if (rest.opacity !== undefined) wrong.push(`${tag}: 쉼이 흐림 ${String(rest.opacity)} 을 입는다`);
        if (rest.borderRadius !== radius.pill) wrong.push(`${tag}: 모서리 ${String(rest.borderRadius)} ≠ 알약`);
        if (rest.minHeight !== BUTTON.height || BUTTON.height !== TOUCH_TARGET) wrong.push(`${tag}: 높이 ${String(rest.minHeight)} ≠ 44`);
        if (rest.paddingHorizontal !== BUTTON.padX) wrong.push(`${tag}: 옆 여백 ${String(rest.paddingHorizontal)} ≠ ${BUTTON.padX}`);
        const restLabel = StyleSheet.flatten(labelOf('rest', '저장').props.style) as Style;
        if (restLabel.color !== ink) wrong.push(`${tag}: 글자 ${String(restLabel.color)} ≠ ${ink}`);
        if (restLabel.fontSize !== font.body || restLabel.fontWeight !== '600') {
          wrong.push(`${tag}: 글자 ${String(restLabel.fontSize)}/${String(restLabel.fontWeight)} ≠ body/600`);
        }
        if (buttonInk(combo.palette, kind) !== ink) wrong.push(`${tag}: buttonInk 가 규격 글자색과 다르다`);
        // 눌림 — 채움은 그대로, 흐림만
        if (pressed.opacity !== PRESSED_OPACITY || pressed.backgroundColor !== rest.backgroundColor) {
          wrong.push(`${tag}: 눌림 ${String(pressed.opacity)} · 채움 ${String(pressed.backgroundColor)}`);
        }
        // 잠김 — 같은 채움을 흐리게, 눌러도 모양이 안 변하고, 보조기술에 잠김
        if (locked.opacity !== DISABLED_OPACITY || locked.backgroundColor !== rest.backgroundColor) {
          wrong.push(`${tag}: 잠김 ${String(locked.opacity)} · 채움 ${String(locked.backgroundColor)}`);
        }
        if (lockedPressed.opacity !== locked.opacity) wrong.push(`${tag}: 잠긴 단추가 눌림 모양을 입는다`);
        if (screen.getByTestId('locked').props.accessibilityState?.disabled !== true) wrong.push(`${tag}: 잠김이 보조기술에 안 닿는다`);
        if (locked.borderWidth !== rest.borderWidth) wrong.push(`${tag}: 잠글 때 가장자리 두께가 바뀐다`);
        // 진행 중 — 채움 그대로, 흐리지 않고, 표시기와 낱말이 그 종류의 글자색. disabled 를 같이 줘도 진행이 이긴다.
        for (const id of ['busy', 'busyLocked']) {
          const busy = pressableStyle(id, false);
          if (busy.backgroundColor !== rest.backgroundColor || busy.opacity !== undefined) {
            wrong.push(`${tag} · ${id}: 진행 중 채움 ${String(busy.backgroundColor)} · 흐림 ${String(busy.opacity)}`);
          }
          if (pressableStyle(id, true).opacity !== undefined) wrong.push(`${tag} · ${id}: 진행 중인 단추가 눌림 모양을 입는다`);
          const spinners = within(screen.getByTestId(id)).UNSAFE_queryAllByType(ActivityIndicator);
          if (spinners.length !== 1 || spinners[0].props.color !== ink) wrong.push(`${tag} · ${id}: 표시기 ${spinners.length}개`);
          const word = StyleSheet.flatten(labelOf(id, '저장 중').props.style) as Style;
          if (word.color !== ink) wrong.push(`${tag} · ${id}: 진행 낱말 색 ${String(word.color)}`);
          const state = screen.getByTestId(id).props.accessibilityState;
          if (state?.busy !== true || state?.disabled !== true) wrong.push(`${tag} · ${id}: 보조기술 상태 ${JSON.stringify(state)}`);
          if (screen.getByTestId(id).props.accessibilityLabel !== '저장 중') wrong.push(`${tag} · ${id}: 진행 중 낭독 이름`);
        }
        view.unmount();
      }
    }
    expect(wrong).toEqual([]);
  });

  it('보조의 옅은 채움이 바닥 · 시트와 갈린다 — 조용한 단추와 같은 모양으로 돌아가지 않는다', () => {
    // 시안이 적은 `surfaceMuted` 는 라이트 흑연 · 노을에서 바닥 · 시트와 1.000:1 이다(보조가 조용한 단추처럼 섰다). 바닥 1.05 는
    // #5170 L1 이 잠긴 주 단추에서 같은 함정을 잡던 값이다 — 「충분히 크다」가 아니라 「바탕과 같은 색으로 돌아가지 않는다」의 바닥이다.
    const FLOOR = 1.05;
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      const view = render(
        <FixedScheme scheme={combo.mode} theme={combo.theme}>
          <OutlineButton label="취소" onPress={() => {}} testID="b" />
        </FixedScheme>,
      );
      const fill = String(pressableStyle('b', false).backgroundColor);
      for (const [name, ground] of [['바닥', combo.palette.bg], ['시트', combo.palette.sheet]] as const) {
        const ratio = contrast(fill, ground);
        if (!(ratio >= FLOOR)) wrong.push(`${combo.key} · ${name}: 채움 대비 ${ratio.toFixed(3)} < ${FLOOR}`);
      }
      view.unmount();
    }
    expect(wrong).toEqual([]);
  });

  it('작게는 38 로 그려지고 누르는 자리는 44 다 — 기본은 슬롭 없이 44', () => {
    const wrong: string[] = [];
    for (const [kind, Face] of FACES) {
      const view = render(
        <FixedScheme scheme="light">
          <Face label="받기" onPress={() => {}} testID="regular" />
          <Face label="받기" size="small" onPress={() => {}} testID="small" />
        </FixedScheme>,
      );
      const small = pressableStyle('small', false);
      const slop = screen.getByTestId('small').props.hitSlop as {top?: number; bottom?: number} | undefined;
      if (small.minHeight !== BUTTON.smallHeight || BUTTON.smallHeight !== 38) wrong.push(`${kind}: 작게 높이 ${String(small.minHeight)}`);
      if (small.paddingHorizontal !== BUTTON.smallPadX) wrong.push(`${kind}: 작게 옆 여백 ${String(small.paddingHorizontal)}`);
      if (small.borderRadius !== radius.pill) wrong.push(`${kind}: 작게 모서리 ${String(small.borderRadius)}`);
      const reach = Number(small.minHeight) + (slop?.top ?? 0) + (slop?.bottom ?? 0);
      if (reach < TOUCH_TARGET) wrong.push(`${kind}: 작게의 누르는 자리 ${reach} < 44`);
      const smallLabel = StyleSheet.flatten(labelOf('small', '받기').props.style) as Style;
      if (smallLabel.fontSize !== font.label) wrong.push(`${kind}: 작게 글자 ${String(smallLabel.fontSize)}`);
      const regular = pressableStyle('regular', false);
      if (Number(regular.minHeight) < TOUCH_TARGET) wrong.push(`${kind}: 기본 높이 ${String(regular.minHeight)} < 44`);
      view.unmount();
    }
    expect(wrong).toEqual([]);
  });

  it('낱말은 큰 글자 상한에서 멈추고, 상한은 바 컨트롤과 같은 끝이다', () => {
    render(
      <FixedScheme scheme="light">
        {FACES.map(([kind, Face]) => (
          <Face key={kind} label={kind} onPress={() => {}} testID={kind} />
        ))}
      </FixedScheme>,
    );
    const caps = FACES.map(([kind]) => labelOf(kind, kind).props.maxFontSizeMultiplier);
    expect(caps).toEqual(FACES.map(() => BUTTON_MAX_SCALE));
    expect(BUTTON_MAX_SCALE).toBeGreaterThan(1);
  });

  it('막대 끝의 조용한 단추(flush)는 여백을 걷고 그쪽 끝에 붙되 44 아래로 좁아지지 않는다', () => {
    render(
      <FixedScheme scheme="light">
        <QuietButton flush="start" label="뒤로" onPress={() => {}} testID="start" />
        <QuietButton flush="end" label="한국어" accessory="expand" onPress={() => {}} testID="end" />
      </FixedScheme>,
    );
    const start = pressableStyle('start', false);
    const end = pressableStyle('end', false);
    expect([start.paddingHorizontal, start.justifyContent, start.minWidth]).toEqual([0, 'flex-start', TOUCH_TARGET]);
    expect([end.paddingHorizontal, end.justifyContent, end.minWidth]).toEqual([0, 'flex-end', TOUCH_TARGET]);
    expect(Number(start.minHeight)).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });
});

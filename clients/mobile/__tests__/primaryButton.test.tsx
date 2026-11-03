import 'react-native-url-polyfill/auto';
import {contrast} from '@momo/core/design/color';
import type {SignalChoice} from '@momo/core/design/appearance';
import {SIGNAL_PRESET_IDS} from '@momo/core/design/signal';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {ActivityIndicator, AppState, StyleSheet} from 'react-native';

import {ExpressionPhotoSurface} from '../measure/expressionPhoto';
import {resolveAppearance} from '../src/design/appearanceState';
import {PrimaryButton} from '../src/design/atoms';
import {DEFAULT_THEME_ID, DS2_COMBOS} from '../src/design/ds2Tokens';
import {FixedScheme, type ColorScheme} from '../src/design/theme';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// 셸 주 단추(`PrimaryButton`)는 잉크이고, 잠겨도 라벨이 읽힌다 (#5100, 검증 줄 2회차 화면 M3).
//
// 옛 판은 두 가지가 거짓이었다:
//
//   ① 주 행동을 신호색(`accent`)으로 칠했다. 같은 앱의 첫 화면·로그인·승인 알약은 잉크(`primary`)라
//      주 행동이 갈렸고, 커스텀 강조색(ADR-0174)을 고르면 이 부품의 단추만 그 색으로 바뀌었다
//      (ADR-0189 D3 「주 버튼 검정」이 막으려던 바로 그것).
//   ② 잠기면 `border` 칸 위 흰 글자였다 — 라이트 1.26:1·다크 1.36:1 로 「팀 보관함에 등록」이 사라졌다.
//
// 형제 `OnboardingButton`(채움 `primary`, 잠김 `surfaceMuted` + 글자 `textMuted`, 진행 중에는 잉크 유지)이
// 답을 이미 갖고 있었다. 아래는 그 답을 **그려진 값**으로 잰다 — 소스의 이름이 아니라 렌더된 style 의
// 색 역할·글자 대비·눌림 흐림이다. 앞 넷은 부품만 테마 3 × 모드 2 × 신호 8 = 48조합으로 돌고(커스텀
// 강조색이 이 단추를 못 칠한다는 증거가 여기서 나온다), 마지막은 검수가 캡처한 **바로 그 장면**
// (`measure/expressionPhoto.tsx` — 열 소비처 중 세 자리)을 jest 가 그려서 같은 숫자를 잰다.
//
// 이 파일이 재지 못하는 것: 실제 화면의 픽셀(채움이 시트 위에서 보이는 정도 등) — 캡처와 design-review 의 몫이다.
// 잠긴 채움 `surfaceMuted` 는 시트 위에서 1.0:1 에 가깝다(`docs/design-system/README.md` §3.3: 보조 채움은 채움 대비를
// 재지 않고 글자 라벨이 컨트롤을 식별시킨다) — 그래서 이 파일은 **라벨**의 대비를 잰다.
// =============================================================================

type Style = Record<string, unknown>;

/** 본문 글자 AA. 잠긴 컨트롤은 WCAG 1.4.3 의 예외지만 이 앱은 「못 누르는 버튼도 라벨은 읽혀야 한다」를 정했다. */
const MIN = 4.5;

const SIGNALS: ReadonlyArray<readonly [string, SignalChoice]> = [
  ['기본', null],
  ...SIGNAL_PRESET_IDS.map(id => [`프리셋 ${id}`, {preset: id}] as const),
  ['커스텀 #3A6BD8', {custom: '#3A6BD8'}],
  ['커스텀 #FFFFFF(보정)', {custom: '#FFFFFF'}],
  ['커스텀 #FFE600(순노랑)', {custom: '#FFE600'}],
];

const COMBOS = DS2_COMBOS.flatMap(([theme, mode]) =>
  SIGNALS.map(([signalLabel, signal]) => ({
    key: `${theme}/${mode} · ${signalLabel}`,
    group: `${theme}/${mode}`,
    theme,
    mode,
    signal,
    palette: resolveAppearance(theme, mode, signal).palette,
  })),
);

/** 렌더된 Pressable 의 style 함수를 찾아 `pressed` 로 부른다(`approvalDecisionContrast.test.tsx` 와 같은 길). */
function pressableStyle(testID: string, pressed: boolean): Style {
  type Node = {props: Record<string, any>; parent: Node | null};
  let node: Node | null = screen.getByTestId(testID) as unknown as Node;
  while (node !== null && typeof node.props.style !== 'function') {
    node = node.parent;
  }
  if (node === null) throw new Error(`${testID}: Pressable style 함수를 찾지 못했다`);
  return StyleSheet.flatten(node.props.style({pressed})) as Style;
}

function labelStyle(testID: string): Style {
  const text = within(screen.getByTestId(testID)).getByText(/./);
  return StyleSheet.flatten(text.props.style) as Style;
}

/** 진행 표시기가 하나 서 있으면 그 색, 아니면 `undefined`. */
function spinnerColor(testID: string): unknown {
  const spinners = within(screen.getByTestId(testID)).UNSAFE_queryAllByType(ActivityIndicator);
  return spinners.length === 1 ? spinners[0].props.color : undefined;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').slice(0, 6);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** 흐림을 바탕 위에 합성한다. RN 은 opacity 를 자식까지 한 장으로 합성한다. */
function over(top: string, under: string, alpha: number): string {
  const a = rgb(top);
  const b = rgb(under);
  const mixed = [0, 1, 2].map(i => Math.round(a[i] * alpha + b[i] * (1 - alpha)));
  return `#${mixed.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 바탕 위에 선 단추에서 글자와 채움이 실제로 만드는 대비(흐림 포함). */
function seenContrast(button: Style, ink: unknown, backdrop: string): number {
  const alpha = typeof button.opacity === 'number' ? button.opacity : 1;
  return contrast(
    over(String(ink), backdrop, alpha),
    over(String(button.backgroundColor), backdrop, alpha),
  );
}

interface Drawn {
  rest: Style;
  pressed: Style;
  label: Style;
  spinner: unknown;
  state: {disabled?: boolean; busy?: boolean} | undefined;
}

/** `PrimaryButton` 하나를 한 조합에서 그려 읽는다. */
function drawn(
  combo: (typeof COMBOS)[number],
  props: {disabled?: boolean; busy?: boolean; busyLabel?: string},
): Drawn {
  const view = render(
    <FixedScheme scheme={combo.mode} theme={combo.theme} signal={combo.signal}>
      <PrimaryButton label="다음" onPress={() => {}} testID="btn" {...props} />
    </FixedScheme>,
  );
  const out: Drawn = {
    rest: pressableStyle('btn', false),
    pressed: pressableStyle('btn', true),
    label: labelStyle('btn'),
    spinner: spinnerColor('btn'),
    state: screen.getByTestId('btn').props.accessibilityState,
  };
  view.unmount();
  return out;
}

describe('PrimaryButton — 주 행동은 잉크, 잠겨도 라벨이 읽힌다 (#5100)', () => {
  it('① 주 행동은 잉크다 — 신호색도 커스텀 강조색도 이 단추를 칠하지 않는다', () => {
    const wrong: string[] = [];
    const accents = new Map<string, Set<string>>();
    for (const combo of COMBOS) {
      const {palette} = combo;
      const {rest, label} = drawn(combo, {});
      if (rest.backgroundColor !== palette.primary) {
        wrong.push(`${combo.key}: 채움 ${String(rest.backgroundColor)} ≠ primary ${palette.primary}`);
      }
      if (rest.backgroundColor === palette.accent) {
        wrong.push(`${combo.key}: 채움이 신호색(accent) ${palette.accent}`);
      }
      if (label.color !== palette.onPrimary) {
        wrong.push(`${combo.key}: 글자 ${String(label.color)} ≠ onPrimary ${palette.onPrimary}`);
      }
      accents.set(combo.group, (accents.get(combo.group) ?? new Set()).add(palette.accent));
    }
    expect(wrong).toEqual([]);
    // 이 걸음이 헛돌지 않는다: 신호를 바꾸면 accent 는 실제로 움직였다. 움직인 조합들에서도 채움은 그대로였다.
    expect([...accents].filter(([, seen]) => seen.size < 2).map(([group]) => group)).toEqual([]);
  });

  it('② 잠기면 옅은 칸 위에서도 라벨이 읽힌다 — `surfaceMuted` 채움 + `textMuted` 글자', () => {
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      const {palette} = combo;
      const {rest, pressed, label, state} = drawn(combo, {disabled: true});
      if (rest.backgroundColor !== palette.surfaceMuted) {
        wrong.push(`${combo.key}: 채움 ${String(rest.backgroundColor)} ≠ surfaceMuted ${palette.surfaceMuted}`);
      }
      if (label.color !== palette.textMuted) {
        wrong.push(`${combo.key}: 글자 ${String(label.color)} ≠ textMuted ${palette.textMuted}`);
      }
      const ratio = contrast(String(label.color), String(rest.backgroundColor));
      if (!(ratio >= MIN)) wrong.push(`${combo.key}: 라벨 대비 ${ratio.toFixed(2)} < ${MIN}`);
      if (state?.disabled !== true) wrong.push(`${combo.key}: 보조기술에 잠김이 아니다`);
      // 눌러도 소용없는 단추는 눌림 모양도 입지 않는다.
      if (pressed.opacity !== rest.opacity || pressed.backgroundColor !== rest.backgroundColor) {
        wrong.push(`${combo.key}: 잠긴 단추가 눌림 모양을 입는다`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('③ 진행 중이면 잉크 채움이 남아 표시기와 낱말이 읽힌다 — `disabled` 를 같이 줘도 진행이 이긴다', () => {
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      const {palette} = combo;
      for (const props of [
        {busy: true, busyLabel: '저장 중'},
        {busy: true, busyLabel: '저장 중', disabled: true},
      ]) {
        const tag = `${combo.key} (${props.disabled ? 'busy+disabled' : 'busy'})`;
        const {rest, pressed, label, spinner, state} = drawn(combo, props);
        if (rest.backgroundColor !== palette.primary) {
          wrong.push(`${tag}: 채움 ${String(rest.backgroundColor)} ≠ primary ${palette.primary}`);
        }
        if (label.color !== palette.onPrimary) {
          wrong.push(`${tag}: 글자 ${String(label.color)} ≠ onPrimary ${palette.onPrimary}`);
        }
        if (spinner !== palette.onPrimary) {
          wrong.push(`${tag}: 표시기 ${String(spinner)} ≠ onPrimary ${palette.onPrimary}`);
        }
        const ratio = contrast(String(label.color), String(rest.backgroundColor));
        if (!(ratio >= MIN)) wrong.push(`${tag}: 낱말 대비 ${ratio.toFixed(2)} < ${MIN}`);
        if (state?.disabled !== true || state.busy !== true) {
          wrong.push(`${tag}: 보조기술 상태 ${JSON.stringify(state)}`);
        }
        if (pressed.opacity !== rest.opacity) wrong.push(`${tag}: 진행 중인 단추가 눌림 모양을 입는다`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('④ 눌리면 채움을 갈아 끼우지 않고 흐림만 낮춘다 — 바탕 위에 합성해도 글자가 읽힌다', () => {
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      const {palette} = combo;
      const {pressed, label} = drawn(combo, {});
      if (pressed.backgroundColor !== palette.primary) {
        wrong.push(`${combo.key}: 눌린 채움 ${String(pressed.backgroundColor)} ≠ primary ${palette.primary}`);
      }
      const alpha = pressed.opacity;
      if (typeof alpha !== 'number' || alpha >= 1 || alpha < 0.5) {
        wrong.push(`${combo.key}: 눌림 흐림 ${String(alpha)} 은 (0.5, 1) 밖이다`);
        continue;
      }
      for (const [name, backdrop] of [
        ['bg', palette.bg],
        ['surface', palette.surface],
        ['sheet', palette.sheet],
      ] as const) {
        const ratio = seenContrast(pressed, label.color, backdrop);
        if (!(ratio >= MIN)) wrong.push(`${combo.key} · ${name} 위: 대비 ${ratio.toFixed(2)} < ${MIN}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

// ---- 검수가 캡처한 장면 -----------------------------------------------------

describe('검수가 캡처한 장면을 그려서 같은 값을 잰다 (#5100)', () => {
  let release: (() => void) | undefined;

  /** `cleanup()` 은 비동기로 내려서 곧바로 `render` 하면 깨진다 — 한 번 진짜 타이머를 돌려 보낸다. */
  async function remount() {
    await act(async () => {});
    cleanup();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  beforeEach(async () => {
    release = await pinReduceMotion(true);
    AppState.currentState = 'active';
  });
  afterEach(async () => {
    jest.useRealTimers();
    await remount();
    release?.();
    release = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /**
   * 판정 M3 의 캡처 셋:
   *   · `EXPRESSIONPHOTO-failed-refused-*-scrolled` — 실패 뒤 「만들기」 채움이 신호색(#c2410c·#ff8a4c)
   *   · `EXPRESSIONPHOTO-busy-*-scrolled`            — 만드는 중 「만들기」 잠김, 1.26:1
   *   · `EXPRESSIONPHOTO-made-erased-*`              — 「팀 보관함에 등록」 잠김, 1.26:1(라이트)·1.36:1(다크)
   */
  const SCENES = [
    ['failed-refused', 'expression-photo-failure', 'expression-photo-submit', 'ink'],
    ['busy', 'expression-photo-busy', 'expression-photo-submit', 'locked'],
    ['made-erased', 'expression-photo-made', 'expression-draft-approve', 'locked'],
  ] as const;
  const VIEWS: ReadonlyArray<readonly [string, ColorScheme, SignalChoice]> = [
    ['라이트', 'light', null],
    ['다크', 'dark', null],
    ['라이트 · 커스텀 강조색', 'light', {custom: '#3A6BD8'}],
  ];

  it('실패 뒤 「만들기」는 잉크 채움이고, 만드는 중의 「만들기」와 「팀 보관함에 등록」은 잠겨도 라벨이 읽힌다', async () => {
    const wrong: string[] = [];
    for (const [viewLabel, scheme, signal] of VIEWS) {
      const palette = resolveAppearance(DEFAULT_THEME_ID, scheme, signal).palette;
      for (const [scene, landmark, button, expected] of SCENES) {
        const tag = `${viewLabel} · ${scene} · ${button}`;
        render(
          <FixedScheme scheme={scheme} signal={signal}>
            <ExpressionPhotoSurface which={scene} />
          </FixedScheme>,
        );
        await act(async () => {});
        await waitFor(() => expect(screen.queryByTestId(landmark)).not.toBeNull());
        const rest = pressableStyle(button, false);
        const label = labelStyle(button);
        const state = screen.getByTestId(button).props.accessibilityState as
          | {disabled?: boolean}
          | undefined;
        const locked = expected === 'locked';
        if ((state?.disabled === true) !== locked) {
          wrong.push(`${tag}: 장면이 바뀌었다 — 잠김 ${String(state?.disabled)} (기대 ${locked})`);
        }
        const fill = locked ? palette.surfaceMuted : palette.primary;
        const ink = locked ? palette.textMuted : palette.onPrimary;
        if (rest.backgroundColor !== fill) {
          wrong.push(`${tag}: 채움 ${String(rest.backgroundColor)} ≠ ${fill}`);
        }
        if (label.color !== ink) wrong.push(`${tag}: 글자 ${String(label.color)} ≠ ${ink}`);
        const ratio = contrast(String(label.color), String(rest.backgroundColor));
        if (!(ratio >= MIN)) wrong.push(`${tag}: 라벨 대비 ${ratio.toFixed(2)} < ${MIN}`);
        await remount();
      }
    }
    expect(wrong).toEqual([]);
  });
});

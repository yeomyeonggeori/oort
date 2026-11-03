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
import {circleLook} from '../src/design/sheetModel';
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
// #5170 L1 (검증 줄 3회차 화면 L1): 잠긴 칸을 `surfaceMuted` 로 두면 밝은 시트 위에서 칸이 시트와 같은 색이 된다(새벽하늘 1.009:1,
// 흑연·노을은 1.000:1 — 같은 값이다). 이 부품을 쓰는 곳 열 중 일곱이 시트 위라 잠긴 주 행동이 단추가 아니라 문장처럼 섰다. 답은 형제
// 알약(#5065·#5099)에 이미 있었다: 시트 위에 서는 알약은 시트 위 문법(`circleLook` 채움·가장자리 + `elevationRest` 그림자,
// `docs/design-system/phone-sheets.md` §4)으로 선다. ②는 잠긴 칸이 그 문법이라는 것을, ⑤는 그 칸이 **시트·바닥과 실제로 갈리는 숫자**
// (채움 대비)와 모양(가장자리·그림자·크기 불변)을 잰다.
//
// 이 파일이 재지 못하는 것: 실제 화면의 픽셀(그림자가 시트 위에서 읽히는 정도 등) — 캡처와 design-review 의 몫이다. 그림자는
// 대비 숫자로 안 잡히므로 채움 대비 바닥(`SHEET_FLOOR`)은 **그림자 없이도 옛 값을 잡는** 최소치로만 둔다.
// =============================================================================

type Style = Record<string, unknown>;

/** 본문 글자 AA. 잠긴 컨트롤은 WCAG 1.4.3 의 예외지만 이 앱은 「못 누르는 버튼도 라벨은 읽혀야 한다」를 정했다. */
const MIN = 4.5;

/**
 * 잠긴 칸의 채움이 시트·바닥과 갈리는 최소 대비(#5170 L1). 옛 값(`surfaceMuted`)은 라이트 세 테마에서 1.000~1.009 였다 — 칸이 없는 것과 같다.
 * 새 값(`circleLook` 채움)의 가장 낮은 곳은 흑연 라이트의 시트 위 1.083 이라, 바닥은 그 아래·옛 값 위인 1.05 로 둔다. 이 숫자는 「충분히
 * 크다」는 주장이 아니다 — 칸을 떠 보이게 하는 것은 그림자(`elevationRest`)와 다크의 가장자리 한 줄이고, 이 바닥은 **칸이 바탕과 같은 색으로
 * 돌아가는 일**만 막는다.
 */
const SHEET_FLOOR = 1.05;

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

  it('② 잠기면 시트 위 문법의 칸 위에서도 라벨이 읽힌다 — `circleLook` 채움 + `textMuted` 글자', () => {
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      const {palette} = combo;
      const look = circleLook(palette);
      const {rest, pressed, label, state} = drawn(combo, {disabled: true});
      if (rest.backgroundColor !== look.fill) {
        wrong.push(`${combo.key}: 채움 ${String(rest.backgroundColor)} ≠ circleLook.fill ${look.fill}`);
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

  it('⑤ 잠긴 칸이 시트와 바닥 위에서 실제로 보인다 — 채움이 바탕과 갈리고, 가장자리·그림자는 형제 알약과 같고, 잠가도 크기가 안 변한다 (#5170 L1)', () => {
    const wrong: string[] = [];
    for (const combo of COMBOS) {
      const {palette} = combo;
      const look = circleLook(palette);
      const locked = drawn(combo, {disabled: true}).rest;
      const open = drawn(combo, {}).rest;
      const fill = String(locked.backgroundColor);
      for (const [name, ground] of [
        ['시트', palette.sheet],
        ['바닥', palette.bg],
      ] as const) {
        const ratio = contrast(fill, ground);
        if (!(ratio >= SHEET_FLOOR)) {
          wrong.push(`${combo.key} · ${name} 위: 채움 대비 ${ratio.toFixed(3)} < ${SHEET_FLOOR}`);
        }
      }
      // 형제 알약(`ExpressionAddMenu`·`ExpressionChapter`)과 같은 문법: 가장자리 한 줄 + rest 그림자.
      if (locked.borderColor !== look.ring) {
        wrong.push(`${combo.key}: 가장자리 ${String(locked.borderColor)} ≠ circleLook.ring ${look.ring}`);
      }
      if (locked.boxShadow !== palette.elevationRest) {
        wrong.push(`${combo.key}: 그림자 ${String(locked.boxShadow)} ≠ elevationRest`);
      }
      // 잉크 채움(쉼)은 스스로 보인다 — 그림자를 입지 않고, 가장자리는 채움과 같은 잉크라 보이지 않는다.
      if (open.boxShadow !== undefined) wrong.push(`${combo.key}: 쉼 단추가 그림자를 입는다 ${String(open.boxShadow)}`);
      if (open.borderColor !== palette.primary || open.backgroundColor !== palette.primary) {
        wrong.push(
          `${combo.key}: 쉼 단추의 가장자리 ${String(open.borderColor)} · 채움 ${String(open.backgroundColor)} ≠ 둘 다 primary ${palette.primary}`,
        );
      }
      // 잠글 때 단추가 움직이지 않는다: 가장자리 두께가 두 상태에서 같다(없다가 생기면 높이가 0.66pt 뛴다).
      if (locked.borderWidth !== open.borderWidth || typeof locked.borderWidth !== 'number') {
        wrong.push(`${combo.key}: 가장자리 두께 잠김 ${String(locked.borderWidth)} ≠ 쉼 ${String(open.borderWidth)}`);
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
        const fill = locked ? circleLook(palette).fill : palette.primary;
        const ink = locked ? palette.textMuted : palette.onPrimary;
        if (rest.backgroundColor !== fill) {
          wrong.push(`${tag}: 채움 ${String(rest.backgroundColor)} ≠ ${fill}`);
        }
        if (locked) {
          // 검수가 본 바로 그 장면에서 잠긴 칸이 바탕(시트) 위에서 갈리는지 — 옛 값은 시트와 1.000~1.009 였다(#5170 L1).
          const onSheet = contrast(String(rest.backgroundColor), palette.sheet);
          if (!(onSheet >= SHEET_FLOOR)) wrong.push(`${tag}: 시트 위 채움 대비 ${onSheet.toFixed(3)} < ${SHEET_FLOOR}`);
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

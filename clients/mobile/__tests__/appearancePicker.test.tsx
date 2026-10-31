import React from 'react';
import {AccessibilityInfo, StyleSheet, Text} from 'react-native';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';

import {
  SIGNAL_ADJUSTED_COPY,
  SIGNAL_PRESET_IDS,
  SIGNAL_REJECTION_COPY,
  resolvePreset,
  resolveSignal,
} from '@momo/core/design/signal';
import {THEMES} from '@momo/core/design/themes';

import {ThemeControl} from '../src/design/ThemeControl';
import {BrandAppearance, FixedScheme, ThemeProvider, useStyles} from '../src/design/theme';
import {dividerIndent} from '../src/design/sheetModel';
import {ds2Radius, paletteFrom, type Palette} from '../src/design/tokens';
import {NON_SECRET_KEYS, __setNonSecretStore} from '../src/storage/kv';
import {DARK_CHOSEN_RECORD} from './fixtures/darkWorld';
import {sweepHangulWord} from './fixtures/hangulWord';

// =============================================================================
// #2719 — 테마와 강조색이 **끝까지** 바뀌고, 저장되고, 거절이 거절로 남는다.
//
// `themeSwitch.test.tsx` 가 스킴 왕복을 지킨다. 이 파일은 같은 성질을 새 두 축(테마,
// 강조색)에 건다. 핵심은 memo 를 통과하는 소비자다 — 스킴을 고정한 채 테마만 바꿔도
// 색을 읽는 컴포넌트가 새 팔레트를 봐야 한다(캐시 키가 스킴이던 때에는 여기서 옛 색이
// 남는다).
// =============================================================================

const buildProbe = (color: Palette) => ({
  ink: {color: color.text},
  accent: {color: color.accentText},
  fill: {color: color.accent},
});

const Probe = React.memo(function ProbeBody(): React.JSX.Element {
  const styles = useStyles(buildProbe);
  return (
    <>
      <Text testID="probe-ink" style={styles.ink}>
        글
      </Text>
      <Text testID="probe-accent" style={styles.accent}>
        강조
      </Text>
      <Text testID="probe-fill" style={styles.fill}>
        채움
      </Text>
    </>
  );
});

function colorOf(testID: string): unknown {
  const style = screen.getByTestId(testID).props.style;
  return (Array.isArray(style) ? Object.assign({}, ...style.flat()) : style).color;
}

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => map.delete(key),
  };
}

let store = memoryStore();
const saved = () => JSON.parse(store.map.get(NON_SECRET_KEYS.appearance) ?? 'null');

beforeEach(() => {
  store = memoryStore();
  __setNonSecretStore(store);
  // 이 파일은 다크에서 테마·강조색이 끝까지 가는지를 잰다. 폰의 기본이 라이트가 된 뒤(#4526,
  // ADR-0189 증보 5)에는 다크를 **고른** 폰으로 세운다 — 저장된 선택은 기본이 건드리지 않는다.
  store.map.set(NON_SECRET_KEYS.appearance, DARK_CHOSEN_RECORD);
});
afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
});

function mount() {
  return render(
    <ThemeProvider>
      <ThemeControl />
      <Probe />
    </ThemeProvider>,
  );
}

function pickTheme(id: string) {
  fireEvent.press(screen.getByTestId('appearance-theme-picker'));
  fireEvent.press(screen.getByTestId(`appearance-theme-${id}`));
  fireEvent.press(screen.getByTestId('theme-picker-done'));
}

describe('테마 — 스킴을 고정한 채 바꿔도 memo 소비자가 따라간다', () => {
  it('새벽하늘 → 흑연 → 노을띠, 다크에서 매번 본문 잉크가 그 테마의 것이다', () => {
    mount();
    // 다크를 고른 폰이다(위 beforeEach).
    const ink = (theme: 'dawnsky' | 'graphite' | 'noeul') =>
      paletteFrom(theme, 'dark').text;
    // 이 시험이 헛돌지 않으려면 세 값이 실제로 달라야 한다.
    expect(new Set([ink('dawnsky'), ink('graphite'), ink('noeul')]).size).toBe(3);

    expect(colorOf('probe-ink')).toBe(ink('dawnsky'));
    pickTheme('graphite');
    expect(colorOf('probe-ink')).toBe(ink('graphite'));
    pickTheme('noeul');
    expect(colorOf('probe-ink')).toBe(ink('noeul'));
    expect(saved()).toMatchObject({v: 2, scheme: 'dark', theme: 'noeul', signal: null});
  });

  it('고른 테마만 selected 이고 체크가 따라간다 — 셋 중 하나', () => {
    mount();
    fireEvent.press(screen.getByTestId('appearance-theme-picker'));
    const sel = () =>
      ['dawnsky', 'graphite', 'noeul'].map(
        id => screen.getByTestId(`appearance-theme-${id}`).props.accessibilityState?.selected,
      );
    expect(sel()).toEqual([true, false, false]);
    fireEvent.press(screen.getByTestId('appearance-theme-graphite'));
    expect(sel()).toEqual([false, true, false]);
    expect(screen.getByTestId('appearance-theme-graphite-check', {includeHiddenElements: true})).toBeTruthy();
    expect(screen.queryByTestId('appearance-theme-dawnsky-check')).toBeNull();
  });

  it('다음 실행이 고른 테마·신호로 첫 렌더를 한다', () => {
    store.map.set(
      NON_SECRET_KEYS.appearance,
      JSON.stringify({v: 2, scheme: 'dark', theme: 'noeul', signal: {preset: 'gamram'}, density: 'comfortable'}),
    );
    mount();
    expect(colorOf('probe-ink')).toBe(paletteFrom('noeul', 'dark').text);
    const solved = resolvePreset('gamram', 'noeul', 'dark');
    expect(solved.ok).toBe(true);
    if (solved.ok) expect(colorOf('probe-fill')).toBe(solved.values.signal.toLowerCase());
  });
});

describe('강조색 — 프리셋과 기본', () => {
  it('프리셋을 고르면 accent 계열만 바뀌고 본문 잉크는 그대로다', () => {
    mount();
    const inkBefore = colorOf('probe-ink');
    const fillBefore = colorOf('probe-fill');
    fireEvent.press(screen.getByTestId('appearance-signal-hongyeom'));
    const solved = resolvePreset('hongyeom', 'dawnsky', 'dark');
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(colorOf('probe-fill')).toBe(solved.values.signal.toLowerCase());
    expect(colorOf('probe-fill')).not.toBe(fillBefore);
    expect(colorOf('probe-ink')).toBe(inkBefore);
    expect(saved().signal).toEqual({preset: 'hongyeom'});

    fireEvent.press(screen.getByTestId('appearance-signal-default'));
    expect(colorOf('probe-fill')).toBe(fillBefore);
    expect(saved().signal).toBeNull();
  });

  it('프리셋 점은 지금 테마·모드에서 풀린 색이고, 테마를 바꾸면 따라간다', () => {
    mount();
    const dot = (id: string) =>
      (screen.getByTestId(`appearance-dot-${id}`, {includeHiddenElements: true}).props.style as unknown[])
        .flat()
        .reduce<Record<string, unknown>>((acc, part) => ({...acc, ...(part as object)}), {})
        .backgroundColor;
    for (const theme of ['dawnsky', 'noeul'] as const) {
      pickTheme(theme);
      const solved = resolvePreset('seongun', theme, 'dark');
      expect(solved.ok).toBe(true);
      if (solved.ok) expect(dot('seongun')).toBe(solved.values.signal);
      expect(dot('default')).toBe(THEMES[theme].dark.color.signal);
    }
  });
});

describe('강조색 — 직접 입력은 core 규칙을 그대로 따른다', () => {
  const type = (text: string) => {
    fireEvent.changeText(screen.getByTestId('appearance-signal-input'), text);
    fireEvent.press(screen.getByTestId('appearance-signal-apply'));
  };

  it('이미 통과하는 색은 그대로 저장되고 알림이 없다 (다크 노랑)', () => {
    mount();
    type('#ffe600');
    expect(saved().signal).toEqual({custom: '#FFE600'});
    expect(screen.queryByTestId('appearance-signal-notice')).toBeNull();
    expect(colorOf('probe-fill')).toBe('#ffe600');
  });

  it('보정되는 색은 「대비를 위해 조정됨」을 말하고, 저장은 입력 그대로다', () => {
    mount();
    type('#FFFFFF');
    expect(screen.getByTestId('appearance-signal-notice')).toHaveTextContent(
      SIGNAL_ADJUSTED_COPY,
    );
    // 보정값이 아니라 사람이 넣은 값을 저장한다 — 다른 모드에서 다시 풀기 위해.
    expect(saved().signal).toEqual({custom: '#FFFFFF'});
    expect(colorOf('probe-fill')).not.toBe('#ffffff');
  });

  it('형식이 틀리면 이유를 말하고 저장하지 않는다', () => {
    mount();
    type('파랑');
    expect(screen.getByTestId('appearance-signal-notice')).toHaveTextContent(
      SIGNAL_REJECTION_COPY['invalid-hex'],
    );
    expect(saved()?.signal ?? null).toBeNull();
  });

  it('에이전트 표시 색과 같은 입력은 거절하고 저장하지 않는다', () => {
    mount();
    const agent = THEMES.dawnsky.dark.color.agent;
    const before = colorOf('probe-fill');
    type(agent);
    expect(screen.getByTestId('appearance-signal-notice')).toBeTruthy();
    expect(saved()?.signal ?? null).toBeNull();
    expect(colorOf('probe-fill')).toBe(before);
  });

  it('여섯 자리 앞의 #은 없어도 받는다', () => {
    mount();
    type('3a6bd8');
    expect(saved().signal).toEqual({custom: '#3A6BD8'});
  });

  it('저장된 커스텀이 지금 테마에서 거절되면 기본 신호로 그리고, 상태를 문장으로 말한다', () => {
    // 흑연 다크의 에이전트 색은 흑연에서 거절되는 입력이다 — 다른 테마에서 고른 값이
    // 이 테마에서 못 쓰이는 경로를 손으로 저장해 재현한다.
    const agent = THEMES.graphite.dark.color.agent.toUpperCase();
    store.map.set(
      NON_SECRET_KEYS.appearance,
      JSON.stringify({v: 2, scheme: 'dark', theme: 'graphite', signal: {custom: agent}, density: 'comfortable'}),
    );
    mount();
    expect(colorOf('probe-fill')).toBe(paletteFrom('graphite', 'dark').accent);
    expect(screen.getByTestId('appearance-signal-state')).toHaveTextContent(/기본 색으로 보여요/);
    // 사람의 선택은 지우지 않는다 — 다른 테마로 돌아가면 다시 쓰인다.
    expect(saved()?.signal ?? {custom: agent}).toEqual({custom: agent});
  });
});

describe('직접 입력의 상태 표현 (design-review M-2·M-3·M-4)', () => {
  const type = (text: string) => {
    fireEvent.changeText(screen.getByTestId('appearance-signal-input'), text);
    fireEvent.press(screen.getByTestId('appearance-signal-apply'));
  };
  const style = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) ?? {};

  it('거절은 오류 톤이고 입력 테두리도 바뀌며, 보조기술에 읽어 준다', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    mount();
    const plain = style('appearance-signal-input').borderColor;
    type('파랑');
    const palette = paletteFrom('dawnsky', 'dark');
    expect(style('appearance-signal-notice').color).toBe(palette.dangerText);
    expect(style('appearance-signal-input').borderColor).toBe(palette.danger);
    expect(style('appearance-signal-input').borderColor).not.toBe(plain);
    expect(screen.getByTestId('appearance-signal-notice').props.accessibilityLiveRegion).toBe('polite');
    expect(announce).toHaveBeenCalledWith(SIGNAL_REJECTION_COPY['invalid-hex']);
    // 고치면 오류가 걷힌다.
    fireEvent.changeText(screen.getByTestId('appearance-signal-input'), '#3A6BD8');
    expect(screen.queryByTestId('appearance-signal-notice')).toBeNull();
  });

  it('보정 안내는 정보 톤이고, 다시 열어도 입력 아래 한 곳에만 남는다', () => {
    store.map.set(
      NON_SECRET_KEYS.appearance,
      JSON.stringify({v: 2, scheme: 'dark', theme: 'dawnsky', signal: {custom: '#FFFFFF'}, density: 'comfortable'}),
    );
    mount();
    expect(screen.getAllByText(SIGNAL_ADJUSTED_COPY)).toHaveLength(1);
    expect(screen.getByTestId('appearance-signal-notice')).toHaveTextContent(SIGNAL_ADJUSTED_COPY);
    expect(style('appearance-signal-notice').color).not.toBe(paletteFrom('dawnsky', 'dark').dangerText);
  });

  it('보정되는 색을 적용해도 같은 문장이 두 번 나오지 않는다', () => {
    mount();
    type('#FFFFFF');
    expect(screen.getAllByText(SIGNAL_ADJUSTED_COPY)).toHaveLength(1);
  });

  it('직접 입력을 쓰는 중이면 제목이 accent 톤·굵기로 바뀐다 — 체크 하나에 기대지 않는다', () => {
    mount();
    // 직접 입력 카드는 공용 묶음 카드 가족이다(반경 20) — 옛 반경 8 카드가 아니다(#4457).
    const card = style('appearance-signal-custom-group-card');
    expect(card.borderRadius).toBe(ds2Radius.card);
    expect(card.borderColor).toBeDefined();
    const label = () => StyleSheet.flatten(screen.getByText('직접 입력').props.style) ?? {};
    const plain = label();
    type('#3A6BD8');
    const used = label();
    const solved = resolveSignal('#3A6BD8', 'dawnsky', 'dark');
    expect(solved.ok).toBe(true);
    if (solved.ok) expect(used.color).toBe(solved.values['signal-text'].toLowerCase());
    expect(used.color).not.toBe(plain.color);
    expect(used.fontWeight).toBe('700');
  });
});

describe('카드 구분선은 앞 칸을 비켜 글자 열에서 시작한다 (#4457)', () => {
  const indentsOf = (cardTestID: string) =>
    within(screen.getByTestId(cardTestID))
      .getAllByTestId('group-divider')
      .map(divider => StyleSheet.flatten(divider.props.style).marginLeft);

  it('테마(견본)·강조색(점)은 같은 글자 열이고, 화면 모드(앞 표지 없음)는 앞 칸 없는 열이다', () => {
    mount();
    // 견본의 실제 폭을 읽는다 — 카드의 `inset` 이 그 폭과 같아야 선이 글자 열에 맞는다.
    const swatch = StyleSheet.flatten(
      screen.getByTestId('appearance-swatch-dawnsky', {includeHiddenElements: true}).props.style,
    ).width as number;
    expect(swatch).toBeGreaterThan(0);
    // 앞 표지가 있는 두 카드는 같은 폭의 앞 칸을 쓴다 — 글자 시작이 같다(design-review #4457 r1 H1: 세 카드가 모두 달랐다).
    const leadWidth = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style).width;
    expect(leadWidth('appearance-theme-picker-lead')).toBe(swatch);
    for (const id of ['default', ...SIGNAL_PRESET_IDS]) {
      expect(leadWidth(`appearance-signal-${id}-lead`)).toBe(swatch);
    }
    expect(within(screen.getByTestId('appearance-theme-list-card')).queryAllByTestId('group-divider')).toHaveLength(0);
    expect(new Set(indentsOf('appearance-signal-list-card'))).toEqual(new Set([dividerIndent(swatch)]));
    expect(new Set(indentsOf('theme-scheme-card'))).toEqual(new Set([dividerIndent('plain')]));
    // 대조군: 앞 칸 있는 열과 없는 열은 다르다 — 같으면 위 단정이 아무것도 가르지 못한다.
    expect(dividerIndent(swatch)).not.toBe(dividerIndent('plain'));
  });
});

describe('테마 타일 (design-review M-1)', () => {
  it('라이트·다크 두 반쪽을 모두 보인다 — 다크에서도 테마 차이가 보인다', () => {
    mount();
    fireEvent.press(screen.getByTestId('appearance-theme-picker'));
    for (const id of ['dawnsky', 'graphite', 'noeul'] as const) {
      for (const mode of ['light', 'dark'] as const) {
        const half = within(screen.getByTestId('theme-picker-grid')).getByTestId(`appearance-swatch-${id}-${mode}`, {includeHiddenElements: true});
        const image = (StyleSheet.flatten(half.props.style) ?? {}).experimental_backgroundImage;
        expect(String(image)).toContain(THEMES[id][mode].canvas[1]);
      }
    }
  });

  it('노을띠 행은 폰에서 띠가 없다는 사실을 말한다', () => {
    mount();
    fireEvent.press(screen.getByTestId('appearance-theme-picker'));
    expect(screen.getByText(/폰에서는 남색 띠 없이/)).toBeTruthy();
    expect(screen.getAllByText(/남색 띠/)).toHaveLength(1);
  });
});

describe('온보딩은 테마 영향 밖이다 (ADR-0174 D4)', () => {
  it('BrandAppearance 아래는 저장된 테마·신호와 무관하게 새벽하늘 기본이다', () => {
    store.map.set(
      NON_SECRET_KEYS.appearance,
      JSON.stringify({v: 2, scheme: 'dark', theme: 'noeul', signal: {preset: 'hongyeom'}, density: 'comfortable'}),
    );
    render(
      <ThemeProvider>
        <BrandAppearance>
          <Probe />
        </BrandAppearance>
      </ThemeProvider>,
    );
    const base = paletteFrom('dawnsky', 'dark');
    expect(colorOf('probe-ink')).toBe(base.text);
    expect(colorOf('probe-fill')).toBe(base.accent);
  });

  it('스킴은 사람의 선택을 따른다', () => {
    store.map.set(
      NON_SECRET_KEYS.appearance,
      JSON.stringify({v: 2, scheme: 'light', theme: 'noeul', signal: null, density: 'comfortable'}),
    );
    render(
      <ThemeProvider>
        <BrandAppearance>
          <Probe />
        </BrandAppearance>
      </ThemeProvider>,
    );
    expect(colorOf('probe-ink')).toBe(paletteFrom('dawnsky', 'light').text);
  });
});

describe('FixedScheme (하네스)', () => {
  it('테마·신호 인자로 여섯 조합을 같은 실행 안에서 찍을 수 있다', () => {
    render(
      <FixedScheme scheme="light" theme="graphite" signal={{preset: 'gamram'}}>
        <Probe />
      </FixedScheme>,
    );
    expect(colorOf('probe-ink')).toBe(paletteFrom('graphite', 'light').text);
    act(() => {});
  });
});

describe('AP-6 테마 고르기 페이지', () => {
  it('모드 필터·2열 격자·VoiceOver 라벨·선택 상태를 제공해요', () => {
    mount();
    fireEvent.press(screen.getByTestId('appearance-theme-picker'));
    expect(screen.getByTestId('theme-picker-grid').props).toMatchObject({accessibilityRole: 'radiogroup', accessibilityLabel: '테마 스타일'});
    const nord = screen.getByRole('radio', {name: 'Nord, 다크'});
    expect(nord.props.accessibilityState.selected).toBe(false);
    expect(StyleSheet.flatten(nord.props.style).width).toBe('48%');
    expect(within(screen.getByTestId('theme-picker-page')).getAllByRole('radio').length).toBe(43 + 3);
    fireEvent.press(screen.getByTestId('theme-picker-filter-system'));
    expect(screen.queryByTestId('appearance-theme-catalog:nord')).toBeNull();
    expect(within(screen.getByTestId('theme-picker-page')).getAllByRole('radio').length).toBe(19 + 3);
    fireEvent.press(screen.getByTestId('theme-picker-filter-light'));
    expect(within(screen.getByTestId('theme-picker-page')).getAllByRole('radio').length).toBe(20 + 3);
    expect(screen.getByRole('radio', {name: 'GitHub, 라이트·다크 짝'})).toBeTruthy();
  });

  it('바로 적용하고 되돌리기는 진입 당시 테마와 모드를 함께 복원해요', () => {
    mount();
    fireEvent.press(screen.getByTestId('appearance-theme-picker'));
    expect(screen.getByTestId('theme-picker-undo').props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByTestId('appearance-theme-catalog:nord'));
    expect(saved()).toMatchObject({theme: 'catalog:nord', scheme: 'dark'});
    expect(colorOf('probe-ink')).toBe(paletteFrom('catalog:nord', 'dark').text);
    fireEvent.press(screen.getByTestId('theme-picker-filter-light'));
    expect(saved()).toMatchObject({theme: 'dawnsky', scheme: 'light'});
    fireEvent.press(screen.getByTestId('theme-picker-undo'));
    expect(saved()).toMatchObject({theme: 'dawnsky', scheme: 'dark'});
    expect(colorOf('probe-ink')).toBe(paletteFrom('dawnsky', 'dark').text);
    fireEvent.press(screen.getByTestId('theme-picker-done'));
    expect(screen.queryByTestId('theme-picker-page')).toBeNull();
  });

  it('완료 후 다시 들어가면 새 스냅샷이고, 재실행도 카탈로그 테마로 시작해요', () => {
    const first = mount();
    pickTheme('catalog:nord');
    first.unmount();
    mount();
    expect(colorOf('probe-ink')).toBe(paletteFrom('catalog:nord', 'dark').text);
    fireEvent.press(screen.getByTestId('appearance-theme-picker'));
    fireEvent.press(screen.getByTestId('appearance-theme-graphite'));
    fireEvent.press(screen.getByTestId('theme-picker-undo'));
    expect(saved()).toMatchObject({theme: 'catalog:nord', scheme: 'dark'});
  });

  it('단일 모드 저장은 그 모드로 그리고, 시스템 필터에서는 짝 테마로 옮겨요', () => {
    store.map.set(NON_SECRET_KEYS.appearance, JSON.stringify({v: 2, theme: 'catalog:nord', scheme: 'light'}));
    mount();
    expect(colorOf('probe-ink')).toBe(paletteFrom('catalog:nord', 'dark').text);
    fireEvent.press(screen.getByTestId('appearance-theme-picker'));
    fireEvent.press(screen.getByTestId('theme-picker-filter-system'));
    expect(saved()).toMatchObject({theme: 'dawnsky', scheme: 'system'});
    expect(screen.getByTestId('theme-picker-notice')).toHaveTextContent(/한쪽 모드만 있어서/);
  });
});

// ---- 한국어 낱말 끊김 (#4982) ----------------------------------------------------------------------
// iOS 기본 줄바꿈은 한글을 글자 단위로 끊는다. 테마 화면(화면 모드·테마·강조색·배경·미리보기)과 「테마 고르기」 페이지의
// 한글 글자는 모두 `hangul-word` 여야 한다. 이름 허용 목록이 아니라 렌더 트리의 모든 글자 노드를 센다(`fixtures/hangulWord.ts`).
describe('한국어 낱말 끊김 - 테마', () => {
  it('테마 화면과 「테마 고르기」 페이지의 한글 글자는 모두 어절 우선이다 - 보정 알림·거절·배경 안내·되돌리기 단추까지', () => {
    mount();
    const area = () => sweepHangulWord(screen.getByTestId('appearance-control'));
    const first = area();
    expect(first.checked).toBeGreaterThan(20); // 머리글·모드·테마 행·강조색 이름·직접 입력·배경·미리보기가 다 세어졌다
    expect(first.missing).toEqual([]);
    // 알림·거절은 상태가 바뀌어야 서는 글자다.
    fireEvent.changeText(screen.getByTestId('appearance-signal-input'), '#FFFFFF');
    fireEvent.press(screen.getByTestId('appearance-signal-apply'));
    expect(screen.getByTestId('appearance-signal-notice')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('appearance-signal-input'), 'zzz');
    fireEvent.press(screen.getByTestId('appearance-signal-apply'));
    // 배경을 고르면 「기본으로」 단추와 반투명 면 안내가 선다.
    fireEvent.press(screen.getByTestId('appearance-background-preset-noeul'));
    expect(screen.getByTestId('appearance-background-reset')).toBeTruthy();
    const after = area();
    expect(after.checked).toBeGreaterThan(first.checked);
    expect(after.missing).toEqual([]);

    // 「테마 고르기」 페이지(머리·필터·안내·타일·되돌림 안내)도 같다.
    fireEvent.press(screen.getByTestId('appearance-theme-picker'));
    const page = () => sweepHangulWord(screen.getByTestId('theme-picker-page'));
    const opened = page();
    expect(opened.checked).toBeGreaterThan(8); // 되돌리기·제목·완료·필터 셋·안내·타일 이름·노을띠 설명
    expect(opened.missing).toEqual([]);
    fireEvent.press(screen.getByTestId('appearance-theme-graphite'));
    fireEvent.press(screen.getByTestId('theme-picker-undo'));
    expect(screen.getByTestId('theme-picker-notice')).toHaveTextContent('처음 고른 테마와 화면 모드로 되돌렸어요.');
    expect(page().missing).toEqual([]);
  });
});

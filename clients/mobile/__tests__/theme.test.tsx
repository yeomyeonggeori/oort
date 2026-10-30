// theme — 테마 기본값·키보드 모양 (design/theme)
// 합친 원본: themeDefault4526.test.tsx, keyboardAppearance4526.test.tsx
// 이슈 번호는 아래 묶음 `describe` 이름과 주석에 남아 있다.

import React from 'react';
import {Linking, StyleSheet, Text, useColorScheme} from 'react-native';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import {DEFAULT_APPEARANCE} from '@momo/core/design/appearance';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {ThemeControl} from '../src/design/ThemeControl';
import {
  BrandAppearance,
  DEFAULT_THEME_CHOICE,
  FixedScheme,
  MOBILE_DEFAULT_APPEARANCE,
  THEME_CHOICES,
  ThemeProvider,
  themeSummary,
  useKeyboardAppearance,
  useStyles,
  useTheme,
} from '../src/design/theme';
import {darkPalette, lightPalette, paletteFrom, type Palette} from '../src/design/tokens';
import ConnectScreen from '../src/screens/ConnectScreen';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetSessionStore} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';
import {InputPill} from '../src/design/sheetParts';
import {drainRender} from './testkit';

// ---- 아래 묶음들이 함께 쓰는 고정값·도구 (원래 파일마다 글자 그대로 같게 선언돼 있던 것)
// 목의 두 손잡이 (`jest.setup.js`). 훅 자체에 달려 있으므로 타입에는 없다.
const systemHandle = useColorScheme as unknown as {
  __setSystemColorScheme: (scheme: 'light' | 'dark') => void;
  __reset: () => void;
};
const setSystem = (scheme: 'light' | 'dark') =>
  act(() => systemHandle.__setSystemColorScheme(scheme));

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => map.delete(key),
  };
}

// =============================================================================
// 합친 시험: 원래 themeDefault4526.test.tsx (#4526)
// =============================================================================
describe('themeDefault (#4526)', () => {
  // =============================================================================
  // #4526 — 폰의 기본 색상 모드는 **라이트**다 (ADR-0189 증보 5 · owner 2026-10-25).
  //
  // 한 번도 고른 적 없는 폰은 라이트로 시작하고(로그인 전 화면 포함), 이미 고른 선택은
  // 시스템을 포함해 그대로이며, 고르는 순서는 라이트·시스템·다크이고, 프로바이더 밖의
  // 기본도 라이트다. 웹·데스크탑의 기본(시스템)은 바뀌지 않는다.
  //
  // 시험은 **다크 기기**에서 잰다(`jest.setup.js` 가 시스템을 다크로 둔다). 시스템이 라이트이면
  // 「기본 = 라이트」와 「기본 = 시스템」이 같은 화면을 내서 아무것도 가리지 못한다.
  //
  // red proof (이 파일이 지키는 것 — PR 본문의 사보타주 표에 실제 실행 결과가 있다):
  //   - 기본값(`DEFAULT_THEME_CHOICE`)을 'system' 으로 되돌리면 → 「한 번도 안 고른 폰은 라이트」
  //     묶음과 「기본이 첫 줄」·「폰 기본은 core 와 스킴만 다르다」가 붉다
  //   - `readStoredAppearance` 가 저장된 선택을 무시하거나 `system` 레코드를 라이트로 덮으면 →
  //     「이미 고른 선택은 그대로」 묶음이 붉다
  //   - 마운트가 기본을 저장소에 써 넣으면 → 「아무것도 쓰지 않는다」·「저장된 것을 건드리지 않는다」가 붉다
  //   - `THEME_CHOICES` 순서를 바꾸면 → 「순서」 묶음이 붉다(그려진 줄의 순서까지 잰다)
  //   - 프로바이더 밖 기본(`DETACHED`)을 시스템으로 되돌리면 → 「프로바이더 밖」 묶음이 붉다
  // =============================================================================

  let store = memoryStore();

  function record(patch: Record<string, unknown> = {}): string {
    return JSON.stringify({
      v: 2,
      scheme: 'system',
      theme: 'dawnsky',
      signal: null,
      density: 'comfortable',
      ...patch,
    });
  }

  beforeEach(() => {
    RENDERED.length = 0;
    store = memoryStore();
    __setNonSecretStore(store);
    __resetSessionStore();
    __resetServerBaseCache();
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  });

  afterEach(async () => {
    await drainRender();
    cleanup();
    jest.restoreAllMocks();
    __setNonSecretStore(null);
    act(() => systemHandle.__reset());
  });

  // ---- 화면에서 읽는 것 ---------------------------------------------------------

  const buildProbe = (color: Palette) => ({ink: {color: color.text}});

  /** 이 장의 본문 잉크 — 어느 팔레트가 서 있는지를 렌더 트리에서 읽는다. */
  function Probe(): React.JSX.Element {
    const styles = useStyles(buildProbe);
    return (
      <Text testID="probe-ink" style={styles.ink}>
        달무리 스튜디오
      </Text>
    );
  }

  /** 컨텍스트가 말하는 값: 고른 것 / 풀린 스킴 / 시스템이 지금 말하는 것. */
  function Who(): React.JSX.Element {
    const {choice, scheme, systemScheme, themeId} = useTheme();
    return (
      <>
        <Text testID="who">{`${choice}/${scheme}/${systemScheme}`}</Text>
        <Text testID="summary">{themeSummary(themeId, choice)}</Text>
      </>
    );
  }

  const HIDDEN = {includeHiddenElements: true} as const;

  /**
   * 프로바이더가 **렌더마다** 말한 스킴의 기록. 끝 상태(`render()` 가 돌려준 뒤의 화면)는 이펙트가 다 비워진
   * 뒤라서 「기본으로 한 번 그리고 이펙트에서 저장값으로 뒤집는」 회귀를 못 본다. 렌더 본문에서 적어야
   * 그 한 프레임이 남는다.
   */
  const RENDERED: string[] = [];

  function RenderLog(): React.JSX.Element {
    const {scheme} = useTheme();
    RENDERED.push(scheme);
    return <Text>{scheme}</Text>;
  }

  const ink = () => StyleSheet.flatten(screen.getByTestId('probe-ink').props.style).color;
  const who = () => screen.getByTestId('who').props.children as string;

  function mount(extra: React.ReactNode = null) {
    return render(
      <ThemeProvider>
        <Probe />
        <Who />
        {extra}
      </ThemeProvider>,
    );
  }

  // =============================================================================

  describe('한 번도 안 고른 폰은 라이트로 시작한다', () => {
    it('기기가 다크여도 라이트로 선다', () => {
      mount();
      expect(ink()).toBe(lightPalette.text);
      // 고른 것 · 풀린 스킴 · 시스템이 지금 말하는 것. 시스템은 다크라고 말하지만 화면은 라이트다.
      expect(who()).toBe('light/light/dark');
    });

    it('첫 렌더부터 라이트다 — 렌더가 본 스킴에 다크가 한 번도 없다', () => {
      render(
        <ThemeProvider>
          <RenderLog />
        </ThemeProvider>,
      );
      expect(RENDERED.length).toBeGreaterThan(0);
      expect(RENDERED).toEqual(RENDERED.map(() => 'light'));
    });

    it('첫 실행은 저장소에 아무것도 쓰지 않는다 — 「안 고름」이 안 고름으로 남는다', () => {
      mount(<ThemeControl />);
      // 마운트가 기본을 써 넣으면 그 폰은 다음 실행부터 「고른 폰」이 되어, 기본이 또 바뀌어도
      // 라이트에 붙박인다. 구별 가능한 것이 이 규칙의 전부다.
      expect(store.map.size).toBe(0);
    });

    it('설정의 고르기도 라이트에 체크가 서고, 「시스템」 줄은 지금 기기 값을 보조로 말한다', () => {
      mount(<ThemeControl />);
      expect(screen.getByTestId('theme-light-check')).toBeTruthy();
      expect(screen.queryByTestId('theme-system-check')).toBeNull();
      expect(screen.queryByTestId('theme-dark-check')).toBeNull();
      // 「시스템」 줄의 보조 문장은 그대로다(현행 유지) — 고른 것과 상관없이 기기의 사실을 말한다.
      expect(screen.getByText('지금 이 기기의 시스템은 다크예요.')).toBeTruthy();
      expect(screen.getByTestId('theme-system').props.accessibilityHint).toBe(
        '지금 이 기기의 시스템은 다크예요.',
      );
      // 설정 「테마」 줄의 값도 라이트다.
      expect(screen.getByTestId('summary').props.children).toBe('새벽하늘 · 라이트');
    });

    it('로그인 전 화면도 라이트다 — 다크 기기의 첫 실행에서 별이 없다', async () => {
      render(
        <ThemeProvider>
          <BrandAppearance>
            <ConnectScreen />
          </BrandAppearance>
        </ThemeProvider>,
      );
      // 환영 화면의 별은 다크에만 선다(`ConnectScreen` 의 `dark ? <Stars />`).
      expect(screen.getByTestId('connect-welcome')).toBeTruthy();
      // 별은 접근성에서 숨겨진 장식이라 숨김 요소를 포함해서 찾아야 한다 — 포함하지 않으면 이 단정은
      // 별이 있어도 통과한다(아래 다크 판이 그 사실을 잰다).
      expect(screen.queryByTestId('welcome-stars', HIDDEN)).toBeNull();
      await act(async () => {});
    });

    it('같은 화면이 다크를 고른 폰에서는 별이 선다 — 위 단정이 헛돌지 않는다', async () => {
      store.map.set(NON_SECRET_KEYS.appearance, record({scheme: 'dark'}));
      render(
        <ThemeProvider>
          <BrandAppearance>
            <ConnectScreen />
          </BrandAppearance>
        </ThemeProvider>,
      );
      expect(screen.getByTestId('welcome-stars', HIDDEN)).toBeTruthy();
      await act(async () => {});
    });

    it('두 키가 빈 문자열이어도 안 고른 폰이다 — core 읽기와 같은 기준', () => {
      // 비운 값은 저장이 아니다(core 는 `""` 를 키 없음으로 읽는다). 이것을 「남긴 흔적」으로 세면
      // 지워진 키가 폰을 영영 시스템에 붙들어 둔다.
      store.map.set(NON_SECRET_KEYS.appearance, '');
      store.map.set(NON_SECRET_KEYS.themeChoice, '');
      mount();
      expect(who()).toBe('light/light/dark');
      expect(ink()).toBe(lightPalette.text);
    });

    it('저장소를 읽을 수 없는 환경(MMKV 없음)에서도 라이트다', () => {
      __setNonSecretStore({
        getString: () => {
          throw new Error('no native module');
        },
        set: () => {
          throw new Error('no native module');
        },
        remove: () => false,
      });
      mount();
      expect(ink()).toBe(lightPalette.text);
      expect(who()).toBe('light/light/dark');
    });
  });

  describe('이미 고른 선택은 그대로다 — 시스템도 라이트로 덮이지 않는다', () => {
    // [이름, 저장소 내용, 시스템, 기대(고른 것/풀린 스킴), 테마]
    const CASES: ReadonlyArray<
      readonly [
        string,
        {current?: string; legacy?: string},
        'light' | 'dark',
        string,
        'dawnsky' | 'graphite',
      ]
    > = [
      ['새 키: 시스템 (다크 기기)', {current: record({scheme: 'system'})}, 'dark', 'system/dark', 'dawnsky'],
      ['새 키: 시스템 (라이트 기기)', {current: record({scheme: 'system'})}, 'light', 'system/light', 'dawnsky'],
      ['새 키: 라이트 (다크 기기)', {current: record({scheme: 'light'})}, 'dark', 'light/light', 'dawnsky'],
      ['새 키: 다크 (라이트 기기)', {current: record({scheme: 'dark'})}, 'light', 'dark/dark', 'dawnsky'],
      // 테마만 바꾼 폰도 레코드에 스킴 「시스템」이 적혀 있어 명시한 선택과 구별되지 않는다 — 그대로 둔다.
      [
        '새 키: 테마만 바꾼 폰(스킴 시스템)',
        {current: record({scheme: 'system', theme: 'graphite'})},
        'dark',
        'system/dark',
        'graphite',
      ],
      ['옛 키: 시스템 (다크 기기)', {legacy: 'system'}, 'dark', 'system/dark', 'dawnsky'],
      ['옛 키: 다크 (라이트 기기)', {legacy: 'dark'}, 'light', 'dark/dark', 'dawnsky'],
      // 읽을 수 없는 값은 「안 고름」(키 없음)이 아니다 — 전과 같이 시스템이다.
      ['깨진 새 키(JSON 아님)', {current: '{not json'}, 'dark', 'system/dark', 'dawnsky'],
      ['모르는 옛 값', {legacy: 'sepia'}, 'dark', 'system/dark', 'dawnsky'],
    ];

    it.each(CASES)('%s', (_name, stored, system, expected, theme) => {
      if (stored.current !== undefined) store.map.set(NON_SECRET_KEYS.appearance, stored.current);
      if (stored.legacy !== undefined) store.map.set(NON_SECRET_KEYS.themeChoice, stored.legacy);
      setSystem(system);
      mount();
      const [choice, scheme] = expected.split('/');
      expect(who().startsWith(`${choice}/${scheme}/`)).toBe(true);
      expect(ink()).toBe(paletteFrom(theme, scheme as 'light' | 'dark').text);
    });

    it('저장된 다크는 첫 렌더부터 다크다 — 기본(라이트)을 먼저 그리지 않는다', () => {
      // 기기는 라이트, 저장은 다크라 「다크」는 저장에서만 올 수 있다. 저장 읽기를 이펙트로 미루면
      // 첫 렌더가 기본(라이트)이라 기록의 앞에 'light' 가 남는다.
      store.map.set(NON_SECRET_KEYS.appearance, record({scheme: 'dark'}));
      setSystem('light');
      render(
        <ThemeProvider>
          <RenderLog />
        </ThemeProvider>,
      );
      expect(RENDERED.length).toBeGreaterThan(0);
      expect(RENDERED).toEqual(RENDERED.map(() => 'dark'));
    });

    it('마운트는 저장된 것을 건드리지 않는다 — 시스템 레코드가 그대로 남는다', () => {
      const seeded = record({scheme: 'system'});
      store.map.set(NON_SECRET_KEYS.appearance, seeded);
      mount(<ThemeControl />);
      expect(store.map.get(NON_SECRET_KEYS.appearance)).toBe(seeded);
      expect(store.map.size).toBe(1);
    });

    it('옛 키만 있어도 마운트가 새 키를 만들지 않는다 — 옛 키는 읽기 전용이다', () => {
      store.map.set(NON_SECRET_KEYS.themeChoice, 'system');
      mount();
      expect(store.map.has(NON_SECRET_KEYS.appearance)).toBe(false);
      expect(store.map.get(NON_SECRET_KEYS.themeChoice)).toBe('system');
    });

    it('기본에서 「시스템」을 골라 저장하면 다시 켜도 시스템이다 — 라이트로 돌아가지 않는다', () => {
      const first = mount(<ThemeControl />);
      expect(who()).toBe('light/light/dark');
      fireEvent.press(screen.getByTestId('theme-system'));
      expect(who()).toBe('system/dark/dark');
      expect(JSON.parse(store.map.get(NON_SECRET_KEYS.appearance) ?? 'null')).toMatchObject({
        scheme: 'system',
      });
      first.unmount();

      // 다음 실행: 새 프로바이더가 같은 저장소를 읽는다.
      mount();
      expect(who()).toBe('system/dark/dark');
      expect(ink()).toBe(darkPalette.text);
      // 시스템을 고른 폰은 시스템을 따른다.
      setSystem('light');
      expect(who()).toBe('system/light/light');
      expect(ink()).toBe(lightPalette.text);
    });

    it('안 고른 폰이 테마만 바꾸면 그때 보이던 기본(라이트)이 레코드에 같이 적힌다', () => {
      // `update` 가 레코드를 통째로 쓰기 때문이다. 이 폰은 이제 「고른 폰」이라 스킴은 기본을 따라가지
      // 않는다 — 기본이 또 바뀌어도 이 폰이 보던 모습은 그대로다.
      mount(<ThemeControl />);
      fireEvent.press(screen.getByTestId('appearance-theme-picker'));
      fireEvent.press(screen.getByTestId('appearance-theme-graphite'));
      fireEvent.press(screen.getByTestId('theme-picker-done'));
      expect(JSON.parse(store.map.get(NON_SECRET_KEYS.appearance) ?? 'null')).toMatchObject({
        scheme: 'light',
        theme: 'graphite',
      });
    });
  });

  describe('고르는 순서는 라이트 · 시스템 · 다크다', () => {
    it('기본(라이트)이 첫 줄이다', () => {
      expect([...THEME_CHOICES]).toEqual(['light', 'system', 'dark']);
      expect(THEME_CHOICES[0]).toBe(DEFAULT_THEME_CHOICE);
    });

    it('그려진 줄도 그 순서다 — 상수만 바꾸고 컴포넌트가 순서를 우회해도 잡는다', () => {
      mount(<ThemeControl />);
      const radios = within(screen.getByTestId('theme-control')).getAllByRole('radio');
      expect(radios.map(node => node.props.testID)).toEqual([
        'theme-light',
        'theme-system',
        'theme-dark',
      ]);
      expect(radios.map(node => node.props.accessibilityLabel)).toEqual(['라이트', '시스템', '다크']);
    });
  });

  describe('프로바이더 밖의 기본도 라이트다', () => {
    it('기기가 다크여도 라이트로 그린다', () => {
      render(
        <>
          <Probe />
          <Who />
        </>,
      );
      expect(ink()).toBe(lightPalette.text);
      // 고른 것 · 풀린 스킴은 라이트이고, 시스템이 지금 말하는 것은 기기의 사실 그대로다.
      expect(who()).toBe('light/light/dark');
    });

    it('시스템이 바뀌어도 따라가지 않는다 — 뒤집힌 뒤 새로 그려도 라이트다', () => {
      const view = render(<Probe />);
      expect(ink()).toBe(lightPalette.text);
      // 프로바이더 밖에는 구독이 없어 저절로는 다시 그려지지 않는다. 그래서 뒤집을 때마다 새로 그려
      // 「기본이 시스템이었다면 여기서 바뀌었을」 값을 실제로 읽는다.
      setSystem('light');
      view.rerender(<Probe />);
      expect(ink()).toBe(lightPalette.text);
      setSystem('dark');
      view.rerender(<Probe />);
      expect(ink()).toBe(lightPalette.text);
    });
  });

  describe('폰만 바뀌었다 — 웹·데스크탑의 기본은 시스템 그대로다', () => {
    it('core 의 기본(웹·데스크탑의 것)은 시스템이고, 폰의 기본은 스킴만 다르다', () => {
      expect(DEFAULT_APPEARANCE.scheme).toBe('system');
      expect(MOBILE_DEFAULT_APPEARANCE).toEqual({...DEFAULT_APPEARANCE, scheme: 'light'});
    });
  });
});

// =============================================================================
// 합친 시험: 원래 keyboardAppearance4526.test.tsx (#4526)
// =============================================================================
describe('keyboardAppearance (#4526)', () => {
  // =============================================================================
  // #4526 — OS 가 그리는 키보드는 **앱이 서 있는 스킴**을 따른다 (planner 2026-10-26).
  //
  // 폰의 기본이 라이트가 된 뒤(ADR-0189 증보 5) 아무것도 안 고른 다크 기기는 라이트 앱 위로 **다크 키보드**를
  // 올렸다. 키보드는 OS 가 그리고, 알려 주지 않으면 기기 외양을 따르기 때문이다.
  // `TextInput.keyboardAppearance` 로 앱이 알려 준다. 그 값은 `useKeyboardAppearance()` 한 곳이 정하고(풀린
  // 스킴 — 고른 것이 아니다), 앱의 입력창은 **하나도 빠짐없이** 그 값을 든다.
  //
  // 이 파일이 재는 것은 세 층이다:
  //   A. 값 — 훅이 어느 스킴에서 무엇을 돌려주는가(안 고름 · 라이트 · 다크 · 시스템 × 기기 라이트/다크)
  //   B. 실제 입력창 — 그 값이 진짜 컴포넌트의 호스트 입력에 닿는가(강조색 입력 · 공용 `InputPill` · 로그인 화면)
  //   C. 전수 — `src/**` 의 `.tsx` 에 있는 모든 JSX 입력창이 그 값을 든다(새 입력창이 빠지면 붉다). JSX 가 아닌
  //      모양(별칭 import · `createElement(TextInput)` · 애니메이션 래퍼)과 `measure/` 하네스는 안 본다 — 지금 앱에는 없다
  //
  // 시험은 **다크 기기**에서 잰다(`jest.setup.js` 가 시스템을 다크로 둔다). 기기가 라이트이면 「앱 스킴을 따른다」와
  // 「기기를 따른다」가 같은 값이라 아무것도 가리지 못한다. 그래서 가장 날카로운 쌍이 둘이다:
  //   - 안 고른 다크 기기 → 'light' (기기를 따르면 'dark' 가 된다 — 이 변경 전의 결함 그 자체)
  //   - 다크를 고른 라이트 기기 → 'dark' (기기를 따르면 'light' 가 된다 — 「고른 스킴」이 아니라 「시스템」을 읽는 배선을 가른다)
  //
  // red proof (PR 본문의 사보타주 표에 실제 실행 결과가 있다):
  //   - 훅이 상수를 돌려주면 / 시스템 스킴을 돌려주면 / 뒤집어 돌려주면 → A·B 가 붉다
  //   - 입력창 하나에서 속성을 빼면 / 값을 'dark' 로 못 박으면 / 훅이 아닌 상수를 쓰면 → C 가 그 파일:줄을 말하며 붉다
  //   - 공용 부품(`InputPill`) · 강조색 입력에서 속성을 빼면 → B 도 붉다. `InputPill` 이 호출자의 값을 이기게 되면 → B 의 불변식 시험이 붉다
  // =============================================================================

  let store = memoryStore();

  function record(scheme: 'system' | 'light' | 'dark'): string {
    return JSON.stringify({v: 2, scheme, theme: 'dawnsky', signal: null, density: 'comfortable'});
  }

  beforeEach(() => {
    store = memoryStore();
    __setNonSecretStore(store);
    __resetSessionStore();
    __resetServerBaseCache();
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  });

  afterEach(async () => {
    await drainRender();
    cleanup();
    jest.restoreAllMocks();
    __setNonSecretStore(null);
    act(() => systemHandle.__reset());
  });

  /**
   * 그리고, 프로바이더가 띄운 비동기 읽기(접근성 설정)가 끝나도록 한 번 비운다. 비우지 않으면 시험이 끝난 뒤에 상태가
   * 갱신되어 `act` 경고가 로그를 덮는다.
   */
  async function mount(ui: React.ReactElement) {
    const view = render(ui);
    await act(async () => {});
    return view;
  }

  /** 훅이 지금 돌려주는 값을 화면에 적는다. */
  function Probe(): React.JSX.Element {
    const keyboardAppearance = useKeyboardAppearance();
    return <Text testID="kb">{keyboardAppearance}</Text>;
  }
  const probed = () => screen.getByTestId('kb').props.children as string;

  // =============================================================================
  // A. 값 — 훅
  // =============================================================================

  describe('A. 키보드 모양은 앱이 서 있는 스킴이다', () => {
    // [이름, 저장된 선택(없으면 안 고른 폰), 기기, 기대]
    const CASES: ReadonlyArray<
      readonly [string, 'light' | 'dark' | 'system' | null, 'light' | 'dark', 'light' | 'dark']
    > = [
      // 이 변경 전의 결함: 앱은 라이트인데 키보드가 기기를 따라 다크였다.
      ['안 고른 폰 · 다크 기기 → 라이트 앱 위에 라이트 키보드', null, 'dark', 'light'],
      ['안 고른 폰 · 라이트 기기', null, 'light', 'light'],
      ['라이트를 고른 폰 · 다크 기기', 'light', 'dark', 'light'],
      // 기기를 읽는 배선(`systemScheme`)과 고른 스킴을 읽는 배선(`scheme`)을 가르는 쌍.
      ['다크를 고른 폰 · 라이트 기기 → 기기가 밝아도 다크 키보드', 'dark', 'light', 'dark'],
      ['다크를 고른 폰 · 다크 기기', 'dark', 'dark', 'dark'],
      ['시스템을 고른 폰 · 다크 기기 → 기기를 따라 다크', 'system', 'dark', 'dark'],
      ['시스템을 고른 폰 · 라이트 기기 → 기기를 따라 라이트', 'system', 'light', 'light'],
    ];

    it.each(CASES)('%s', async (_name, stored, device, expected) => {
      if (stored !== null) store.map.set(NON_SECRET_KEYS.appearance, record(stored));
      setSystem(device);
      await mount(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
      expect(probed()).toBe(expected);
    });

    it('화면에서 고르면 다시 켜지 않고 바뀐다 — 라이트 → 다크 → 라이트', async () => {
      await mount(
        <ThemeProvider>
          <Probe />
          <ThemeControl />
        </ThemeProvider>,
      );
      expect(probed()).toBe('light');
      fireEvent.press(screen.getByTestId('theme-dark'));
      expect(probed()).toBe('dark');
      fireEvent.press(screen.getByTestId('theme-light'));
      expect(probed()).toBe('light');
    });

    it('「시스템」을 고르면 기기가 바뀔 때 따라간다, 다크를 고르면 기기가 바뀌어도 그대로다', async () => {
      await mount(
        <ThemeProvider>
          <Probe />
          <ThemeControl />
        </ThemeProvider>,
      );
      fireEvent.press(screen.getByTestId('theme-system'));
      expect(probed()).toBe('dark'); // 기기가 다크
      setSystem('light');
      expect(probed()).toBe('light'); // 따라간다
      setSystem('dark');
      expect(probed()).toBe('dark');

      fireEvent.press(screen.getByTestId('theme-dark'));
      setSystem('light');
      expect(probed()).toBe('dark'); // 고른 다크는 기기를 안 따른다
    });

    it('프로바이더 밖의 기본도 라이트다 — 기기가 다크여도', async () => {
      await mount(<Probe />);
      expect(probed()).toBe('light');
    });

    it('하네스가 못 박은 스킴을 그대로 돌려준다', async () => {
      const dark = await mount(
        <FixedScheme scheme="dark">
          <Probe />
        </FixedScheme>,
      );
      expect(probed()).toBe('dark');
      dark.unmount();
      // 기기는 다크지만 못 박은 것은 라이트다.
      await mount(
        <FixedScheme scheme="light">
          <Probe />
        </FixedScheme>,
      );
      expect(probed()).toBe('light');
    });

    it('온보딩의 브랜드 외양도 사람이 고른 스킴을 이어받는다', async () => {
      store.map.set(NON_SECRET_KEYS.appearance, record('dark'));
      setSystem('light');
      await mount(
        <ThemeProvider>
          <BrandAppearance>
            <Probe />
          </BrandAppearance>
        </ThemeProvider>,
      );
      expect(probed()).toBe('dark');
    });
  });

  // =============================================================================
  // B. 실제 입력창 — 값이 진짜 컴포넌트의 호스트 입력에 닿는다
  // =============================================================================

  describe('B. 실제 입력창이 그 값을 든다', () => {
    it('강조색 직접 입력: 안 고른 다크 기기에서 라이트, 고르면 따라 바뀐다', async () => {
      await mount(
        <ThemeProvider>
          <ThemeControl />
        </ThemeProvider>,
      );
      const input = () => screen.getByTestId('appearance-signal-input');
      expect(input().props.keyboardAppearance).toBe('light');
      fireEvent.press(screen.getByTestId('theme-dark'));
      expect(input().props.keyboardAppearance).toBe('dark');
      fireEvent.press(screen.getByTestId('theme-light'));
      expect(input().props.keyboardAppearance).toBe('light');
    });

    it('공용 입력 알약(InputPill): 호스트 입력이 값을 든다 — 안 고름 라이트, 다크를 고른 폰 다크', async () => {
      const pill = (
        <ThemeProvider>
          <InputPill accessibilityLabel="이름 검색" testID="pill-input" />
        </ThemeProvider>
      );
      const first = await mount(pill);
      expect(screen.getByTestId('pill-input').props.keyboardAppearance).toBe('light');
      first.unmount();

      store.map.set(NON_SECRET_KEYS.appearance, record('dark'));
      setSystem('light');
      await mount(pill);
      expect(screen.getByTestId('pill-input').props.keyboardAppearance).toBe('dark');
    });

    it('공용 입력 알약은 호출자가 키보드 모양을 못 바꾼다 — 불변식은 부품 한 곳이 지킨다', async () => {
      // 타입이 먼저 막는다(`Omit<TextInputProps, 'keyboardAppearance'>`). 그 타입을 우회해 넘겨도 값은 앱 스킴이다 —
      // 부품이 호출자의 props 를 펼친 **뒤에** 값을 둔다.
      await mount(
        <ThemeProvider>
          {/* @ts-expect-error — `keyboardAppearance` 는 InputPill 의 props 가 아니다 */}
          <InputPill accessibilityLabel="이름 검색" testID="pill-input" keyboardAppearance="dark" />
        </ThemeProvider>,
      );
      expect(screen.getByTestId('pill-input').props.keyboardAppearance).toBe('light');
    });

    const LOGIN_INPUTS = ['server-url-input', 'email-input', 'password-input'] as const;

    async function openLoginForm() {
      await mount(
        <ThemeProvider>
          <BrandAppearance>
            <ConnectScreen />
          </BrandAppearance>
        </ThemeProvider>,
      );
      fireEvent.press(screen.getByTestId('welcome-address'));
      await act(async () => {});
    }

    it('로그인 화면의 세 입력: 안 고른 다크 기기에서 전부 라이트다', async () => {
      await openLoginForm();
      for (const id of LOGIN_INPUTS) {
        expect([id, screen.getByTestId(id).props.keyboardAppearance]).toEqual([id, 'light']);
      }
    });

    it('같은 로그인 화면이 다크를 고른 폰에서는 전부 다크다 — 위 단정이 헛돌지 않는다', async () => {
      store.map.set(NON_SECRET_KEYS.appearance, record('dark'));
      await openLoginForm();
      for (const id of LOGIN_INPUTS) {
        expect([id, screen.getByTestId(id).props.keyboardAppearance]).toEqual([id, 'dark']);
      }
    });
  });

  // =============================================================================
  // C. 전수 — 소스에 있는 모든 JSX 입력창
  // =============================================================================

  interface InputFinding {
    line: number;
    /** 문제가 없으면 null. */
    problem: string | null;
  }

  const HOOK = 'useKeyboardAppearance';
  const VALUE = 'keyboardAppearance';

  /** 함수 본문의 **최상위 문장**으로 `const keyboardAppearance = useKeyboardAppearance();` 가 있는가. */
  function declaresHookValue(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): boolean {
    const body = fn.body;
    if (!body || !ts.isBlock(body)) return false;
    return body.statements.some(
      st =>
        ts.isVariableStatement(st) &&
        st.declarationList.declarations.some(
          d =>
            ts.isIdentifier(d.name) &&
            d.name.text === VALUE &&
            d.initializer !== undefined &&
            ts.isCallExpression(d.initializer) &&
            d.initializer.expression.getText(sf) === HOOK &&
            d.initializer.arguments.length === 0,
        ),
    );
  }

  /**
   * 소스 안의 모든 **JSX** 입력창(`TextInput`, `Animated.TextInput`, `…TextInput`)을 찾아, 각각이
   * `keyboardAppearance={keyboardAppearance}` 를 들고 그 값이 같은 컴포넌트의 최상위에서 훅으로 만들어졌는지 본다.
   *
   * 보는 것: `.tsx` 의 JSX 태그. 안 보는 것: 별칭 import(`TextInput as Field`) · `createElement(TextInput, …)` ·
   * `createAnimatedComponent(TextInput)` · `.ts` 파일 · 루트 `App.tsx` · `measure/` 하네스. 지금 앱에 그 모양은 없고,
   * 생기면 이 스윕을 넓혀야 한다(그 전에는 조용히 초록이다).
   *
   * 문자열 훑기가 아니라 구문 트리를 쓰는 이유: 입력창 태그는 화살표 함수(`=>`)·긴 주석·문자열 속의 `>` 를 속성
   * 사이에 든다. 정규식은 그 셋에서 태그의 끝이나 주석 속 이름을 잘못 집는다(`conversationHygiene` 의 #1422 스윕이
   * 그 때문에 직접 태그 끝을 세는 함수를 갖고 있다). 구문 트리는 주석을 속성으로 읽지 않고, 타입 자리의
   * `useRef<TextInput | null>` 은 JSX 가 아니라서 애초에 세지 않는다.
   */
  function scanTextInputs(fileName: string, source: string): InputFinding[] {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const findings: InputFinding[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        /(^|\.)\w*TextInput$/.test(node.tagName.getText(sf))
      ) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const attr = node.attributes.properties.find(
          (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'keyboardAppearance',
        );
        let problem: string | null = null;
        if (!attr) {
          problem = '`keyboardAppearance` 가 없다';
        } else if (attr.initializer?.getText(sf) !== `{${VALUE}}`) {
          problem = `값이 훅이 돌려준 \`${VALUE}\` 가 아니다: ${attr.initializer?.getText(sf)}`;
        } else {
          // 값의 출처: 바깥쪽 함수들 중 하나의 최상위에서 훅으로 만들어져야 한다.
          let scope: ts.Node | undefined = node.parent;
          let ok = false;
          while (scope && !ok) {
            if (
              (ts.isFunctionDeclaration(scope) ||
                ts.isArrowFunction(scope) ||
                ts.isFunctionExpression(scope)) &&
              declaresHookValue(scope, sf)
            ) {
              ok = true;
            }
            scope = scope.parent;
          }
          if (!ok) problem = `\`const ${VALUE} = ${HOOK}();\` 가 같은 컴포넌트의 최상위에 없다`;
        }
        findings.push({line, problem});
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return findings;
  }

  const SRC_DIR = path.resolve(__dirname, '../src');

  function tsxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsxFiles(full));
      else if (/\.tsx$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  describe('C. 앱의 입력창은 하나도 빠짐없이 그 값을 든다', () => {
    it('src 의 모든 JSX 입력창이 `keyboardAppearance={keyboardAppearance}` 를 든다', () => {
      // 기준선(「지금 22 곳」)을 세우지 않고 **0** 을 단정한다. 새 입력창이 생기면 이 줄이 그 파일:줄을 말하며 붉어진다.
      const offenders: string[] = [];
      let seen = 0;
      for (const file of tsxFiles(SRC_DIR)) {
        const source = fs.readFileSync(file, 'utf8');
        for (const {line, problem} of scanTextInputs(file, source)) {
          seen += 1;
          if (problem !== null) offenders.push(`${path.relative(SRC_DIR, file)}:${line} — ${problem}`);
        }
      }
      expect(offenders).toEqual([]);
      // 스윕이 아무것도 못 본 채 초록이 되지 않게: 입력창이 하나도 없는 앱은 없다.
      expect(seen).toBeGreaterThan(0);
    });

    describe('스윕의 red proof — 이 스윕이 무엇을 붉게 하는가', () => {
      const wrap = (jsx: string, hook = `const ${VALUE} = ${HOOK}();`) =>
        `function Screen() {\n  ${hook}\n  return (\n    ${jsx}\n  );\n}\n`;
      const problemsOf = (source: string) => scanTextInputs('fixture.tsx', source).map(f => f.problem);

      it('빠진 입력창을 잡는다', () => {
        expect(problemsOf(wrap('<TextInput value="a" />'))).toEqual(['`keyboardAppearance` 가 없다']);
      });

      it('값을 못 박은 입력창을 잡는다 — 리터럴도, 다른 변수도', () => {
        expect(problemsOf(wrap('<TextInput keyboardAppearance="dark" />'))[0]).toContain('훅이 돌려준');
        expect(problemsOf(wrap('<TextInput keyboardAppearance={scheme} />'))[0]).toContain('훅이 돌려준');
      });

      it('이름만 같은 상수를 잡는다 — 훅 없이 `keyboardAppearance` 를 만든 컴포넌트', () => {
        const fake = wrap('<TextInput keyboardAppearance={keyboardAppearance} />', `const ${VALUE} = 'dark' as const;`);
        expect(problemsOf(fake)[0]).toContain('최상위에 없다');
        // 최상위가 아닌 자리(조건 안)의 훅 호출도 훅 규칙 위반이라 인정하지 않는다.
        const nested = wrap(
          '<TextInput keyboardAppearance={keyboardAppearance} />',
          `if (Math.random() > 1) { const ${VALUE} = ${HOOK}(); }`,
        );
        expect(problemsOf(nested)[0]).toContain('최상위에 없다');
      });

      it('주석 속의 이름은 속성이 아니다', () => {
        const inComment = wrap(
          ['<TextInput', '      // keyboardAppearance={keyboardAppearance}', '      value="a"', '    />'].join('\n'),
        );
        expect(problemsOf(inComment)).toEqual(['`keyboardAppearance` 가 없다']);
      });

      it('화살표 함수의 `>` 가 태그를 끊지 않는다 — 속성이 뒤에 있어도 든 것으로 센다', () => {
        const arrow = wrap(
          ['<TextInput', '      onChangeText={(next: string) => set(next)}', `      keyboardAppearance={${VALUE}}`, '    />'].join(
            '\n',
          ),
        );
        expect(problemsOf(arrow)).toEqual([null]);
      });

      it('올바른 입력창은 통과한다 — 컴포넌트 안쪽 콜백에서 써도 바깥 최상위의 훅을 본다', () => {
        expect(problemsOf(wrap(`<TextInput keyboardAppearance={${VALUE}} />`))).toEqual([null]);
        const inCallback = wrap(`{items.map(item => <TextInput key={item} keyboardAppearance={${VALUE}} />)}`);
        expect(problemsOf(inCallback)).toEqual([null]);
      });

      it('이름이 `…TextInput` 으로 끝나는 변형도 입력창으로 센다', () => {
        expect(problemsOf(wrap('<Animated.TextInput />'))).toHaveLength(1);
        expect(problemsOf(wrap('<BottomSheetTextInput />'))).toHaveLength(1);
      });

      it('타입 자리의 `TextInput` 은 입력창이 아니다', () => {
        const typeOnly = 'function Screen() {\n  const ref = useRef<TextInput | null>(null);\n  return null;\n}\n';
        expect(scanTextInputs('fixture.tsx', typeOnly)).toEqual([]);
      });
    });
  });
});

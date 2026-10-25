import React from 'react';
import {Linking, StyleSheet, Text, useColorScheme} from 'react-native';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';

import {DEFAULT_APPEARANCE} from '@momo/core/design/appearance';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeControl} from '../src/design/ThemeControl';
import {
  BrandAppearance,
  DEFAULT_THEME_CHOICE,
  MOBILE_DEFAULT_APPEARANCE,
  THEME_CHOICES,
  ThemeProvider,
  themeSummary,
  useStyles,
  useTheme,
} from '../src/design/theme';
import {darkPalette, lightPalette, paletteFrom, type Palette} from '../src/design/tokens';
import ConnectScreen from '../src/screens/ConnectScreen';
import {NON_SECRET_KEYS, __setNonSecretStore} from '../src/storage/kv';
import {__resetSessionStore} from '../src/storage/secureSession';
import {__resetServerBaseCache} from '../src/storage/serverBase';

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
  store = memoryStore();
  __setNonSecretStore(store);
  __resetSessionStore();
  __resetServerBaseCache();
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});

afterEach(() => {
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
  it('기기가 다크여도 첫 렌더가 라이트다 — 다크 한 프레임이 없다', () => {
    mount();
    expect(ink()).toBe(lightPalette.text);
    // 고른 것 · 풀린 스킴 · 시스템이 지금 말하는 것. 시스템은 다크라고 말하지만 화면은 라이트다.
    expect(who()).toBe('light/light/dark');
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
    fireEvent.press(screen.getByTestId('appearance-theme-graphite'));
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

  it('시스템이 바뀌어도 따라가지 않는다', () => {
    render(<Probe />);
    setSystem('light');
    expect(ink()).toBe(lightPalette.text);
    setSystem('dark');
    expect(ink()).toBe(lightPalette.text);
  });
});

describe('폰만 바뀌었다 — 웹·데스크탑의 기본은 시스템 그대로다', () => {
  it('core 의 기본(웹·데스크탑의 것)은 시스템이고, 폰의 기본은 스킴만 다르다', () => {
    expect(DEFAULT_APPEARANCE.scheme).toBe('system');
    expect(MOBILE_DEFAULT_APPEARANCE).toEqual({...DEFAULT_APPEARANCE, scheme: 'light'});
  });
});

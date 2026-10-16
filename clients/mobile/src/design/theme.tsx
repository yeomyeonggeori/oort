import React, {createContext, useCallback, useContext, useMemo, useRef, useState} from 'react';
import {Appearance, useColorScheme} from 'react-native';
import {
  DEFAULT_APPEARANCE,
  readMobileAppearance,
  serializeAppearance,
  type AppearanceV2,
  type SignalChoice,
} from '@momo/core/design/appearance';
import {normalizeHex, parseHex} from '@momo/core/design/color';
import {resolveAppearance, signalKey, type SignalState} from './appearanceState';
import {DEFAULT_THEME_ID, THEME_IDS, THEME_LABELS, type ThemeId} from './ds2Tokens';
import {lightPalette, darkPalette, type Palette} from './tokens';
import {NON_SECRET_KEYS, nonSecretStore} from '../storage/kv';

// =============================================================================
// 스킴을 고르는 곳 (U2 · `docs/planning/2026-08-05-uxui-elevation-points.md` §1).
//
// 이 파일이 생기기 전 폰의 색은 **모듈이 평가될 때 한 번** 정해졌다. 화면마다
// 파일 맨 아래에 스타일시트 상수가 하나 있었고(`StyleSheet.create` 를 즉시 부르는
// `const styles`), 그 상수는 import 되는 순간 굳는다. 팔레트를 두 벌 두는 것만으로는
// 아무 일도 일어나지 않는다 — 굳은 스타일시트는 두 번째 팔레트를 영영 보지 못한다.
//
// 그래서 이 배치가 먼저 한 일은 색을 고르는 것이 아니라 **고를 수 있게 만드는 것**
// 이다. 30 개 파일의 스타일시트가 전부 팔레트를 받는 함수가 되고(`buildStyles`),
// 컴포넌트는 그 함수를 `useStyles` 에 건넨다.
//
// ## 왜 훅이어야 하나 — 프록시로는 안 되는 이유
//
// 「`styles` 를 프록시로 만들어 읽을 때마다 지금 스킴을 보게 하면 파일을 안 고쳐도
// 되지 않나」가 첫 후보였다. 안 된다. 프록시는 **읽기**를 바꿀 뿐 리액트에게
// 「이 컴포넌트가 스킴에 의존한다」고 말하지 못한다. 이 앱의 타임라인 행은
// `React.memo` 로 감싸여 있고(`__tests__/messageRowMemo.test.tsx` 가 그것을 지킨다),
// props 가 그대로면 부모가 다시 그려도 다시 그려지지 않는다. 스킴을 바꾸면 화면
// 절반은 새 색, 나머지 절반은 옛 색이 된다.
//
// 훅은 **컨텍스트 구독**이라 memo 를 통과한다. 색을 읽는 컴포넌트가 색의 변화를
// 구독한다 — 숨길 것이 없는 대신, 색을 읽는 자리마다 한 줄이 든다. 그 한 줄이
// 이 배치가 30 개 파일을 만진 이유다.
//
// ## 구독은 앱 전체에 **하나**다
//
// 두 번째 함정은 성능이 아니라 성능처럼 생긴 정확성이다. 색을 읽는 자리마다
// `useColorScheme()` 을 부르면 그 자리마다 `Appearance` 구독이 하나씩 생긴다.
// 타임라인 행 200 개에 행마다 컴포넌트 서넛이면 600 개이고, 가상화 목록은 스크롤
// 하는 동안 그것을 계속 붙였다 뗐다 한다 — RN 의 `EventEmitter` 는 제거가 O(n) 이라
// 그 비용이 스크롤 프레임 안에 앉는다.
//
// 그래서 시스템을 **구독하는 것은 프로바이더 하나뿐**이고, 나머지는 컨텍스트만
// 읽는다. 컨텍스트 읽기는 구독이 아니라 트리 조회이고, 값이 바뀌면 리액트가 알아서
// 소비자를 다시 그린다(그리고 그것이 memo 를 통과하는 이유이기도 하다).
//
// ## `useStyles` 가 매 렌더 `StyleSheet.create` 를 부르지 않는다
//
// 캐시는 컴포넌트가 아니라 **팩토리에** 붙는다: `buildStyles` 는 모듈 상수라 앱
// 수명 동안 하나이고, 팔레트는 (테마 × 모드 × 신호) 조합당 하나다
// (`appearanceState.ts` 가 같은 조합에 같은 객체를 돌려준다). 그래서 한 화면에 행이
// 200 개 서 있어도 스타일시트는 (팩토리 × 팔레트) 당 한 번만 만들어진다 — `useMemo` 로 했다면 행마다
// 한 벌씩 200 벌이 생겼을 자리다. 순수 계산이고 결과가 불변이라 렌더 중에 읽어도
// 찢어지지 않는다.
//
// ## 스킴 말고 테마와 신호도 같은 길로 간다 (#2719)
//
// 팔레트가 둘에서 (3 테마 × 2 모드 × 신호 5종)으로 늘어도 소비자는 바뀌지 않는다.
// `useStyles` 의 캐시 키가 스킴 문자열에서 **팔레트 객체**로 바뀌었을 뿐이고, 컨텍스트
// 값이 바뀌면 memo 를 통과해 모든 소비자가 다시 그려지는 성질은 그대로다. 저장은 core
// 의 외양 레코드(`momo.mobile.appearance.v1`)이고 옛 스킴 키는 읽기만 한다.
// =============================================================================

/** 실제로 화면에 서는 두 스킴. `null`(모름)은 여기까지 오지 않는다. */
export type ColorScheme = 'light' | 'dark';

/**
 * 사람이 고르는 세 값. 웹 설정의 「테마」와 같은 세 값이고 같은 기본값이다
 * (기본 = 시스템, ADR 없이 두 클라가 달라지면 안 되는 자리).
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

const THEME_LABELS_KO: Readonly<Record<ThemeChoice, string>> = {
  system: '시스템',
  light: '라이트',
  dark: '다크',
};

export function themeChoiceLabel(choice: ThemeChoice): string {
  return THEME_LABELS_KO[choice];
}

/** 테마(새벽하늘·흑연·노을띠) 이름. 고르는 값 `ThemeChoice` 와 다른 축이다. */
export function themeIdLabel(id: ThemeId): string {
  return THEME_LABELS[id];
}

export {THEME_IDS};

/** 프로필 시트 「테마」 줄의 값 — 「새벽하늘 · 시스템」. */
export function themeSummary(id: ThemeId, choice: ThemeChoice): string {
  return `${themeIdLabel(id)} · ${themeChoiceLabel(choice)}`;
}

/** 기본 테마·기본 신호의 팔레트. 프로바이더 밖과 하네스의 기본. */
export function paletteFor(scheme: ColorScheme): Palette {
  return scheme === 'light' ? lightPalette : darkPalette;
}

/**
 * 저장된 외양을 읽는다. 못 읽거나 모르는 값이면 기본(시스템·새벽하늘·기본 신호) —
 * **저장이 없다는 것과 기본을 쓰라는 것은 같은 뜻**이라 폴백에 정보가 없다.
 *
 * 새 키(`momo.mobile.appearance.v1`)가 먼저, 없으면 옛 스킴 키(`momo.mobile.theme.v1`)
 * 에서 스킴만 이어받는다(core `readMobileAppearance`). MMKV 는 동기라 첫 페인트 전에
 * 답한다. 비동기 저장소였다면 한 프레임 동안 다크로 그렸다가 라이트로 뒤집히는
 * 깜빡임이 있었을 것이고, 그것이 `storage/kv.ts` 가 MMKV 인 이유이기도 하다.
 */
function readStoredAppearance(): AppearanceV2 {
  try {
    const store = nonSecretStore();
    return readMobileAppearance({
      current: store.getString(NON_SECRET_KEYS.appearance),
      legacyScheme: store.getString(NON_SECRET_KEYS.themeChoice),
    });
  } catch {
    // 네이티브 모듈이 없는 환경(단위 테스트, 하네스의 일부)에서 색이 아예 안
    // 나오는 것보다 기본을 따르는 편이 낫다.
    return DEFAULT_APPEARANCE;
  }
}

function writeStoredAppearance(next: AppearanceV2): void {
  try {
    nonSecretStore().set(NON_SECRET_KEYS.appearance, serializeAppearance(next));
  } catch {
    // 고른 것이 이번 실행에는 적용되고 다음 실행에는 잊힌다. 색 하나 때문에
    // 앱이 죽는 것보다 낫다.
  }
}

/** 커스텀 hex 를 저장 모양(`#RRGGBB` 대문자)으로. 형식이 틀리면 `null`. */
export function normalizeCustomHex(raw: string): string | null {
  const trimmed = raw.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  if (!parseHex(withHash)) return null;
  return normalizeHex(withHash).toUpperCase();
}

interface ThemeValue {
  choice: ThemeChoice;
  scheme: ColorScheme;
  /**
   * 시스템이 **지금** 말하는 것. `scheme` 과 다른 값이다.
   *
   * `scheme` 은 이미 풀린 답이라 사람이 다크를 고르면 시스템이 무엇이든 `dark` 다.
   * 그래서 「시스템은 지금 무엇인가」를 `scheme` 으로 답하면 고정된 동안 **거짓
   * 진술**이 된다 — 라이트인 기기에서 다크를 고른 사람이 「시스템은 다크입니다」를
   * 듣는다(U2 리뷰 H-1: 「시스템」 칸의 VoiceOver 힌트가 정확히 그것이었다).
   *
   * 두 값이 갈라지는 자리는 하나뿐이지만(그 힌트), 갈라진다는 사실 자체는 컨텍스트가
   * 져야 한다. 소비자가 `Appearance.getColorScheme()` 을 직접 물으면 그 답은 구독
   * 없이 읽은 값이라 시스템이 바뀌어도 갱신되지 않고, 구독을 달면 「구독은 앱 전체에
   * 하나」(파일 머리 주석)가 깨진다. 이미 구독하고 있는 프로바이더가 답하는 것이
   * 두 규율을 다 지키는 유일한 길이다.
   */
  systemScheme: ColorScheme;
  setChoice: (choice: ThemeChoice) => void;
  /** 지금 화면에 서 있는 팔레트(테마 × 모드 × 신호가 풀린 결과). */
  palette: Palette;
  /** 고른 테마(새벽하늘·흑연·노을띠). 스킴과 다른 축이다. */
  themeId: ThemeId;
  setTheme: (id: ThemeId) => void;
  /** 사람이 고른 신호(저장된 그대로). 지금 모드에서 풀린 결과는 `signalState`. */
  signal: SignalChoice;
  /** 지금 테마 × 모드에서 신호가 어떻게 풀렸는가 — 보정됐는지, 거절됐는지. */
  signalState: SignalState;
  setSignal: (signal: SignalChoice) => void;
}

/** 시스템이 지금 말하는 것. 모름(`null`)이면 이 앱이 처음부터 입고 있던 다크다. */
function systemScheme(): ColorScheme {
  return Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
}

/**
 * 프로바이더 **밖**에서 그려질 때의 값.
 *
 * 그런 자리는 앱에 없다(`App.tsx` 가 가장 바깥에 세운다) — 단위 테스트와 측정
 * 하네스뿐이고, 둘 다 「이 기기가 지금 무슨 스킴인가」를 물어 답을 받는 쪽이 옳다.
 * 그래서 다크 고정이 아니라 시스템이다.
 *
 * `scheme` 이 게터인 이유는 **구독하지 않고도 지금 값을 답하기 위해서**다. 이
 * 자리에는 다시 그려 줄 프로바이더가 없으므로 구독해 봐야 알릴 곳이 없고, 그
 * 대신 읽을 때마다 최신을 답한다.
 */
const DETACHED: ThemeValue = {
  choice: 'system',
  get scheme(): ColorScheme {
    return systemScheme();
  },
  // 고른 것이 없는 자리라 둘이 같은 값이다 — `choice` 가 `system` 이면 풀린 답이
  // 곧 시스템의 답이다.
  get systemScheme(): ColorScheme {
    return systemScheme();
  },
  setChoice: () => {},
  get palette(): Palette {
    return paletteFor(systemScheme());
  },
  themeId: DEFAULT_THEME_ID,
  setTheme: () => {},
  signal: null,
  signalState: {kind: 'default'},
  setSignal: () => {},
};

const ThemeContext = createContext<ThemeValue>(DETACHED);

/** 지금 팔레트. 구독이 아니라 **컨텍스트 조회**다 (파일 머리 주석). */
function useResolvedPalette(): Palette {
  return useContext(ThemeContext).palette;
}

/** 지금 스킴의 팔레트. 스타일시트 밖에서 색 하나가 필요할 때(예: 아이콘 tint). */
export function usePalette(): Palette {
  return useResolvedPalette();
}

/**
 * 「테마」 컨트롤이 읽고 쓰는 것. 프로바이더 없이 부르면 고를 수 없다는 사실을
 * 그대로 답한다(`DETACHED`) — 던지지 않는 이유는 이 훅을 쓰는 화면이 프로바이더
 * 없이 렌더되는 테스트에서도 자기 나머지 부분을 검사할 수 있어야 하기 때문이다.
 */
export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/**
 * 팩토리 × 팔레트 캐시. 키가 팩토리·팔레트 객체 자신이라 둘 중 하나가 사라지면 함께
 * 회수된다. 팔레트는 조합당 하나(`resolveAppearance`)라 키 공간이 유한하다.
 */
const built = new WeakMap<object, WeakMap<Palette, unknown>>();

/**
 * 지금 팔레트의 스타일시트.
 *
 * 호출부는 언제나 `const styles = useStyles(buildStyles);` 한 줄이고, 그 아래는
 * 팔레트가 한 벌이던 때와 **글자 하나 다르지 않다** — `buildStyles` 의 인자
 * 이름이 `color` 라서, 스타일시트 본문은 옮겨 오기 전 그대로다. 이 배치의 진단이
 * 「전면 개조」로 커지지 않은 이유가 그 이름 하나다.
 */
export function useStyles<T>(build: (color: Palette) => T): T {
  const palette = useResolvedPalette();
  let byPalette = built.get(build as object);
  if (byPalette === undefined) {
    byPalette = new WeakMap();
    built.set(build as object, byPalette);
  }
  let made = byPalette.get(palette);
  if (made === undefined) {
    made = build(palette);
    byPalette.set(palette, made);
  }
  return made as T;
}

/**
 * 앱 하나에 하나. `App.tsx` 의 가장 바깥에 선다 — 부팅 화면도 색을 쓰기 때문이다.
 */
export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  // 초기값을 lazy initializer 로 읽는다: MMKV 읽기는 싸지만 매 렌더 할 일은
  // 아니고, 무엇보다 **첫 렌더에 이미 답이 있어야** 한다.
  const [appearance, setAppearance] = useState<AppearanceV2>(readStoredAppearance);
  // 앱 전체에서 시스템을 구독하는 **유일한** 자리다 (파일 머리 주석).
  const system = useColorScheme();

  // 최신 값은 ref 에도 둔다: 한 틱에 두 번 고르면(테마, 이어서 신호) 두 번째가 첫째를
  // 덮어쓰지 않아야 하고, 저장은 상태 갱신 함수 안이 아니라 밖에서 한다.
  const latest = useRef(appearance);
  const update = useCallback((patch: Partial<Omit<AppearanceV2, 'v'>>) => {
    const next: AppearanceV2 = {...latest.current, ...patch};
    latest.current = next;
    setAppearance(next);
    writeStoredAppearance(next);
  }, []);
  const setChoice = useCallback((next: ThemeChoice) => update({scheme: next}), [update]);
  const setTheme = useCallback((id: ThemeId) => update({theme: id}), [update]);
  const setSignal = useCallback((next: SignalChoice) => update({signal: next}), [update]);

  const value = useMemo<ThemeValue>(() => {
    // 시스템의 답을 **먼저** 이름 붙인다. 이 값은 고른 것과 무관하게 참이고,
    // `scheme` 은 그것을 고른 것으로 덮은 결과다 — 두 문장이 한 줄에 접혀 있었을 때
    // 「시스템은 지금 무엇인가」에 답할 것이 `scheme` 밖에 없었다.
    const fromSystem: ColorScheme = system === 'light' ? 'light' : 'dark';
    const choice = appearance.scheme;
    const scheme: ColorScheme = choice === 'system' ? fromSystem : choice;
    const resolved = resolveAppearance(appearance.theme, scheme, appearance.signal);
    return {
      choice,
      scheme,
      systemScheme: fromSystem,
      setChoice,
      palette: resolved.palette,
      themeId: appearance.theme,
      setTheme,
      signal: appearance.signal,
      signalState: resolved.signal,
      setSignal,
    };
    // `signalKey` 를 의존으로 쓰는 것은 객체 동일성이 아니라 값이 바뀔 때만 다시
    // 풀기 위해서다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appearance.scheme, appearance.theme, signalKey(appearance.signal), system, setChoice, setTheme, setSignal]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * 스킴(과 선택적으로 테마·신호) 하나를 고정해서 그 아래를 그린다. **하네스 전용**이다
 * (`measure/`).
 *
 * 라이트 판 캡처가 이것을 쓴다: 시뮬레이터의 시스템 스킴을 바꾸는 것은 캡처
 * 스크립트 밖의 상태를 만지는 일이고, 그러면 한 번 찍고 되돌리는 것을 잊은 다음
 * 런이 다른 색을 찍는다. 프로바이더로 고정하면 두 판이 **같은 실행 안에서** 나온다.
 * 테마·신호 인자가 없으면 기본(새벽하늘·기본 신호)이라 기존 캡처가 그대로다.
 */
export function FixedScheme({
  scheme,
  theme = DEFAULT_THEME_ID,
  signal = null,
  children,
}: {
  scheme: ColorScheme;
  theme?: ThemeId;
  signal?: SignalChoice;
  children: React.ReactNode;
}): React.JSX.Element {
  // 시스템도 인자를 따른다. 하네스가 스킴을 못 박는 이유가 「같은 명령이 기기 상태에
  // 따라 다른 것을 내면 그 사진은 증거가 아니라 일화가 된다」이고, 시스템 스킴을 진짜
  // 기기에서 읽으면 그 일화가 **보조기술 문자열**로 되돌아온다 — 같은 캡처 명령이
  // 시뮬레이터 설정에 따라 다른 힌트를 담게 된다.
  const key = signalKey(signal);
  const value = useMemo<ThemeValue>(() => {
    const resolved = resolveAppearance(theme, scheme, signal);
    return {
      choice: scheme,
      scheme,
      systemScheme: scheme,
      setChoice: () => {},
      palette: resolved.palette,
      themeId: theme,
      setTheme: () => {},
      signal,
      signalState: resolved.signal,
      setSignal: () => {},
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheme, theme, key]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * 테마·신호를 **기본으로 되돌린** 채 그 아래를 그린다. 스킴(라이트·다크)은 사람의
 * 선택을 그대로 따른다.
 *
 * 온보딩(S0)과 브랜드 락업은 테마 영향 밖이다(ADR-0174 D4 · #2719 수용기준) — 처음
 * 보는 사람에게 제품의 얼굴은 하나여야 하고, 아직 로그인도 안 한 화면이 저장된
 * 흑연·노을띠를 입고 나오면 그 얼굴이 둘이 된다.
 */
export function BrandAppearance({children}: {children: React.ReactNode}): React.JSX.Element {
  const parent = useContext(ThemeContext);
  const scheme = parent.scheme;
  const value = useMemo<ThemeValue>(() => {
    const resolved = resolveAppearance(DEFAULT_THEME_ID, scheme, null);
    return {
      ...parent,
      scheme,
      palette: resolved.palette,
      themeId: DEFAULT_THEME_ID,
      signal: null,
      signalState: resolved.signal,
    };
  }, [parent, scheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

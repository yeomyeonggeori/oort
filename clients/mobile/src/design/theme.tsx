import React, {createContext, useCallback, useContext, useMemo, useState} from 'react';
import {Appearance, useColorScheme} from 'react-native';
import {darkPalette, lightPalette, type Palette} from './tokens';
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
// 수명 동안 하나이고, 스킴은 둘뿐이다. 그래서 한 화면에 행이 200 개 서 있어도
// 스타일시트는 (팩토리 × 스킴) 당 한 번만 만들어진다 — `useMemo` 로 했다면 행마다
// 한 벌씩 200 벌이 생겼을 자리다. 순수 계산이고 결과가 불변이라 렌더 중에 읽어도
// 찢어지지 않는다.
// =============================================================================

/** 실제로 화면에 서는 두 스킴. `null`(모름)은 여기까지 오지 않는다. */
export type ColorScheme = 'light' | 'dark';

/**
 * 사람이 고르는 세 값. 웹 설정의 「테마」와 같은 세 값이고 같은 기본값이다
 * (기본 = 시스템, ADR 없이 두 클라가 달라지면 안 되는 자리).
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

const THEME_LABELS: Readonly<Record<ThemeChoice, string>> = {
  system: '시스템',
  light: '라이트',
  dark: '다크',
};

export function themeChoiceLabel(choice: ThemeChoice): string {
  return THEME_LABELS[choice];
}

export function paletteFor(scheme: ColorScheme): Palette {
  return scheme === 'light' ? lightPalette : darkPalette;
}

/**
 * 저장된 선택을 읽는다. 못 읽거나 모르는 값이면 `system` — **저장이 없다는 것과
 * 「시스템을 따르라」는 것은 같은 뜻**이라 폴백에 정보가 없다.
 *
 * MMKV 는 동기라 첫 페인트 전에 답한다. 비동기 저장소였다면 한 프레임 동안 다크로
 * 그렸다가 라이트로 뒤집히는 깜빡임이 있었을 것이고, 그것이 `storage/kv.ts` 가
 * MMKV 인 이유이기도 하다.
 */
function readStoredChoice(): ThemeChoice {
  try {
    const raw = nonSecretStore().getString(NON_SECRET_KEYS.themeChoice);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  } catch {
    // 네이티브 모듈이 없는 환경(단위 테스트, 하네스의 일부)에서 색이 아예 안
    // 나오는 것보다 시스템을 따르는 편이 낫다.
    return 'system';
  }
}

function writeStoredChoice(choice: ThemeChoice): void {
  try {
    nonSecretStore().set(NON_SECRET_KEYS.themeChoice, choice);
  } catch {
    // 고른 것이 이번 실행에는 적용되고 다음 실행에는 잊힌다. 색 하나 때문에
    // 앱이 죽는 것보다 낫다.
  }
}

interface ThemeValue {
  choice: ThemeChoice;
  scheme: ColorScheme;
  setChoice: (choice: ThemeChoice) => void;
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
  setChoice: () => {},
};

const ThemeContext = createContext<ThemeValue>(DETACHED);

/** 스킴 하나. 구독이 아니라 **컨텍스트 조회**다 (파일 머리 주석). */
function useScheme(): ColorScheme {
  return useContext(ThemeContext).scheme;
}

/** 지금 스킴의 팔레트. 스타일시트 밖에서 색 하나가 필요할 때(예: 아이콘 tint). */
export function usePalette(): Palette {
  return paletteFor(useScheme());
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
 * 팩토리 × 스킴 캐시. 키가 팩토리 자신이라 모듈이 살아 있는 동안만 살아 있고,
 * 팩토리가 사라지면 함께 회수된다.
 */
const built = new WeakMap<object, Partial<Record<ColorScheme, unknown>>>();

/**
 * 지금 스킴의 스타일시트.
 *
 * 호출부는 언제나 `const styles = useStyles(buildStyles);` 한 줄이고, 그 아래는
 * 팔레트가 한 벌이던 때와 **글자 하나 다르지 않다** — `buildStyles` 의 인자
 * 이름이 `color` 라서, 스타일시트 본문은 옮겨 오기 전 그대로다. 이 배치의 진단이
 * 「전면 개조」로 커지지 않은 이유가 그 이름 하나다.
 */
export function useStyles<T>(build: (color: Palette) => T): T {
  const scheme = useScheme();
  let byScheme = built.get(build as object);
  if (byScheme === undefined) {
    byScheme = {};
    built.set(build as object, byScheme);
  }
  let made = byScheme[scheme];
  if (made === undefined) {
    made = build(paletteFor(scheme));
    byScheme[scheme] = made;
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
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  // 앱 전체에서 시스템을 구독하는 **유일한** 자리다 (파일 머리 주석).
  const system = useColorScheme();

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    writeStoredChoice(next);
  }, []);

  const value = useMemo<ThemeValue>(() => {
    const scheme: ColorScheme =
      choice === 'system' ? (system === 'light' ? 'light' : 'dark') : choice;
    return {choice, scheme, setChoice};
  }, [choice, system, setChoice]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * 스킴 하나를 고정해서 그 아래를 그린다. **하네스 전용**이다 (`measure/`).
 *
 * 라이트 판 캡처가 이것을 쓴다: 시뮬레이터의 시스템 스킴을 바꾸는 것은 캡처
 * 스크립트 밖의 상태를 만지는 일이고, 그러면 한 번 찍고 되돌리는 것을 잊은 다음
 * 런이 다른 색을 찍는다. 프로바이더로 고정하면 두 판이 **같은 실행 안에서** 나온다.
 */
export function FixedScheme({
  scheme,
  children,
}: {
  scheme: ColorScheme;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo<ThemeValue>(
    () => ({choice: scheme, scheme, setChoice: () => {}}),
    [scheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

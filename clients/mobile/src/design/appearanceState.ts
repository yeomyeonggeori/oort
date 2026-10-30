import type {SignalRejection, SignalValues} from '@momo/core/design/signal';
import type {SignalChoice} from '@momo/core/design/appearance';
import {paletteFrom, type Palette} from './tokens';
import {isThemeId} from '@momo/core/design/themes';
import type {Mode} from './ds2Tokens';
import type {ThemeRef} from '@momo/core/design/themeResolve';
import {resolvePhoneSignal, resolveThemeTokens, phoneThemeMode} from './themeCatalog';

// =============================================================================
// 테마 × 모드 × 신호 → 팔레트 (ADR-0189 D3, #2719 폰 부분).
//
// 이 파일은 **순수**하다. 저장소도 React 도 모른다 — 프로바이더(`theme.tsx`)가 상태를
// 들고 이 함수에 묻는다. 시험이 서른 조합(3 테마 × 2 모드 × 신호 5종)을 같은 함수로
// 도는 이유가 그것이다.
//
// ## 신호는 모드마다 따로 풀린다
//
// core `resolveSignal` 은 한 테마 × **한 모드** 의 표에서 입력을 보정하거나 거절한다.
// 같은 hex 가 다크에서는 통과하고 라이트에서는 거절될 수 있다(밝은 면 위 3:1 을 못
// 넘는 노랑). 그래서 저장하는 것은 **사람이 넣은 hex 그대로**이고(보정값을 저장하면
// 다른 모드에서 보정이 두 번 겹친다), 풀이는 모드가 바뀔 때마다 다시 한다.
//
// 거절되면 그 자리의 테마 기본 신호로 그린다 — 화면을 잠그거나 던지지 않는다. 그
// 사실은 `SignalState.rejected` 로 컨트롤에 올라가 사람에게 한 줄로 말해진다.
// =============================================================================

export type SignalState =
  | {kind: 'default'}
  | {kind: 'preset'; id: string; adjusted: boolean}
  | {kind: 'custom'; hex: string; adjusted: boolean}
  | {kind: 'rejected'; hex: string; reason: SignalRejection; message: string};

export interface ResolvedAppearance {
  palette: Palette;
  signal: SignalState;
}

/** 캐시 키에 들어가는 신호 이름. 값이 같으면 같은 문자열이다. */
export function signalKey(choice: SignalChoice): string {
  if (choice == null) return 'default';
  if ('preset' in choice) return `preset:${choice.preset}`;
  return `custom:${choice.custom.toUpperCase()}`;
}

const palettes = new Map<string, Palette>();
const states = new Map<string, SignalState>();

function solve(theme: ThemeRef, mode: Mode, choice: SignalChoice) {
  if (choice == null) return null;
  return resolvePhoneSignal(theme, mode, choice);
}

/**
 * 한 조합의 팔레트와 신호 상태. `onImage` 는 사용자 배경이 깔린 동안의 팔레트다(글자·표식
 * 색이 scrim 최악 합성 위 대비로 보정된다, ADR-0189 증보 2).
 * **같은 조합이면 같은 객체**를 돌려준다 — `useStyles`
 * 가 팔레트 객체의 동일성으로 스타일시트를 캐시하고, 동일하지 않은 팔레트는 매 렌더
 * `StyleSheet.create` 를 부르게 만든다.
 */
export function resolveAppearance(
  theme: ThemeRef,
  mode: Mode,
  choice: SignalChoice,
  onImage = false,
): ResolvedAppearance {
  mode = phoneThemeMode(theme, mode);
  const key = `${theme}/${mode}/${signalKey(choice)}${onImage ? '/image' : ''}`;
  const cachedPalette = palettes.get(key);
  const cachedState = states.get(key);
  if (cachedPalette && cachedState) return {palette: cachedPalette, signal: cachedState};

  const result = solve(theme, mode, choice);
  let values: SignalValues | null = null;
  let state: SignalState = {kind: 'default'};
  if (result && choice) {
    if (result.ok) {
      values = result.values;
      state =
        'preset' in choice
          ? {kind: 'preset', id: choice.preset, adjusted: result.adjusted}
          : {kind: 'custom', hex: choice.custom, adjusted: result.adjusted};
    } else {
      state = {
        kind: 'rejected',
        hex: 'preset' in choice ? choice.preset : choice.custom,
        reason: result.reason,
        message: result.message,
      };
    }
  }
  const source = isThemeId(theme) ? theme : resolveThemeTokens(theme, mode, choice);
  const palette = paletteFrom(source, mode, values, onImage);
  palettes.set(key, palette);
  states.set(key, state);
  return {palette, signal: state};
}

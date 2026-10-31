// 폰은 core 카탈로그·파생을 그대로 읽고 RN 팔레트로만 번역해요(AP-6).
import type {SignalChoice} from '@momo/core/design/appearance';
import {deriveCatalogMode} from '@momo/core/design/deriveCatalog';
import {
  resolvePreset,
  resolveSignal,
  SIGNAL_PRESETS,
  SIGNAL_REJECTION_COPY,
  type SignalPresetId,
  type SignalResult,
} from '@momo/core/design/signal';
import {
  normalizeThemeRef,
  modesOf,
  type ThemeRef,
} from '@momo/core/design/themeResolve';
import {
  DEFAULT_THEME_ID,
  THEMES,
  isThemeId,
  type Mode,
  type ThemeModeTokens,
} from '@momo/core/design/themes';

/** 사용자 테마 가져오기는 P2예요. 모르는 저장값은 새벽하늘로 돌아가요. */
export function phoneThemeRef(raw: unknown): ThemeRef {
  const ref = normalizeThemeRef(raw);
  return ref.startsWith('user:') ? DEFAULT_THEME_ID : ref;
}

export function phoneThemeMode(ref: ThemeRef, mode: Mode): Mode {
  const modes = modesOf(ref);
  return modes.includes(mode) ? mode : modes[0];
}

export function resolveThemeTokens(
  ref: ThemeRef,
  mode: Mode,
  signal: SignalChoice = null,
): ThemeModeTokens {
  const normalized = phoneThemeRef(ref);
  if (isThemeId(normalized)) return THEMES[normalized][mode];
  return (
    deriveCatalogMode(
      normalized.slice('catalog:'.length),
      phoneThemeMode(normalized, mode),
      signal,
    )?.tokens ?? THEMES[DEFAULT_THEME_ID][mode]
  );
}

/** 첫 파티의 기존 신호 풀이를 보존하고, 카탈로그는 에이전트 재배치까지 core 엔진에 맡겨요. */
export function resolvePhoneSignal(
  ref: ThemeRef,
  mode: Mode,
  choice: Exclude<SignalChoice, null>,
): SignalResult {
  const normalized = phoneThemeRef(ref);
  if (isThemeId(normalized)) {
    return 'preset' in choice
      ? resolvePreset(choice.preset, normalized, mode)
      : resolveSignal(choice.custom, normalized, mode);
  }
  const result = deriveCatalogMode(
    normalized.slice('catalog:'.length),
    phoneThemeMode(normalized, mode),
    choice,
  )!;
  const rejection = result.signal.choiceRejection;
  if (rejection)
    return {
      ok: false,
      reason: rejection,
      message: SIGNAL_REJECTION_COPY[rejection],
    };
  const c = result.tokens.color;
  const input =
    'preset' in choice ? SIGNAL_PRESETS[choice.preset][mode] : choice.custom;
  return {
    ok: true,
    adjusted: input.toLowerCase() !== c.signal.toLowerCase(),
    values: {
      signal: c.signal,
      'signal-text': c['signal-text'],
      'signal-soft': c['signal-soft'],
      'on-signal': c['on-signal'],
    },
  };
}

export const resolvePhonePreset = (
  id: SignalPresetId,
  ref: ThemeRef,
  mode: Mode,
): SignalResult => resolvePhoneSignal(ref, mode, {preset: id});

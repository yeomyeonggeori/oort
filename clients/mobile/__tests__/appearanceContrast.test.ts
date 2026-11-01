import {contrast, oklabDistance} from '@momo/core/design/color';
import {
  NON_TEXT_MIN_CONTRAST,
  TEXT_MIN_CONTRAST,
  VESSEL_MIN_CONTRAST,
  VESSEL_MIN_DISTANCE,
} from '@momo/core/design/themes';
import {SIGNAL_PRESET_IDS, resolveSignal} from '@momo/core/design/signal';
import type {SignalChoice} from '@momo/core/design/appearance';

import {resolveAppearance, signalKey} from '../src/design/appearanceState';
import {DS2_COMBOS} from '../src/design/ds2Tokens';
import type {Palette} from '../src/design/tokens';

// =============================================================================
// #2719·#3907 — 테마 3 × 모드 2 × 강조색 8종(기본 · 프리셋 4 · 커스텀 3) × 바닥 2(캔버스·배경 위) = 96 팔레트를 같은 자로 잰다.
//
// `paletteContrast.test.ts` 는 새벽하늘 두 벌을 잰다. 테마 선택과 강조색이 열리면서
// 화면이 입을 수 있는 팔레트가 스물네 벌(기본 신호) → 마흔여덟 벌이 됐고, 그 어느 것도
// 글자가 안 읽히는 조합이 되면 안 된다. 이 파일은 **사람이 고를 수 있는 조합 전수**를
// 돈다. 커스텀 셋은 (a) 이미 통과하는 색 (b) 보정되는 색(순백) (c) 순노랑 — 라이트에서
// 밝은 표면 위 3:1 을 못 넘어 보정/거절 경로를 탄다.
// =============================================================================

const SIGNALS: ReadonlyArray<readonly [string, SignalChoice]> = [
  ['기본', null],
  ...SIGNAL_PRESET_IDS.map(id => [`프리셋 ${id}`, {preset: id}] as const),
  ['커스텀 #3A6BD8', {custom: '#3A6BD8'}],
  ['커스텀 #FFFFFF(보정)', {custom: '#FFFFFF'}],
  ['커스텀 #FFE600(순노랑)', {custom: '#FFE600'}],
];

/** 글자가 자기가 설 수 있는 면 위에서 AA 를 넘는 쌍(신호와 무관한 것은 기본에서도 같다). */
const TEXT_PAIRS: ReadonlyArray<readonly [keyof Palette, keyof Palette]> = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'sheet'],
  ['text', 'surfaceMuted'],
  ['text', 'canvasTop'],
  ['text', 'canvasBottom'],
  ['textMuted', 'bg'],
  ['textMuted', 'surface'],
  ['textMuted', 'sheet'],
  ['textMuted', 'canvasTop'],
  ['textMuted', 'canvasBottom'],
  // 못 누르는 주 단추의 라벨(`PrimaryButton`·`OnboardingButton` 의 잠김, #5100) — 옅은 칸 위에서 읽혀야 한다.
  ['textMuted', 'surfaceMuted'],
  ['onPrimary', 'primary'],
  ['accentText', 'bg'],
  ['accentText', 'surface'],
  ['accentText', 'sheet'],
  ['accentText', 'surfaceMuted'],
  ['accentText', 'canvasTop'],
  ['accentText', 'canvasBottom'],
  ['accentText', 'accentSurface'],
  ['onAccent', 'accent'],
  ['agent', 'surface'],
  ['agent', 'agentSurface'],
  ['danger', 'surface'],
  ['dangerText', 'dangerSurface'],
  ['onDangerFill', 'dangerFill'],
  ['ok', 'surface'],
  ['ok', 'okSurface'],
  ['warn', 'surface'],
  ['warn', 'warnSurface'],
];

// 바닥: 기본 그라데이션과, 사용자 배경이 깔린 동안(ADR-0189 증보 2)의 팔레트. 후자는 글자·
// 표식 색이 scrim 최악 합성 위 대비로 보정된 판이고, 보정이 카드·칩 위 대비를 **깎지
// 않는다**는 것도 같은 쌍 목록으로 잰다.
const BACKDROPS = [
  ['캔버스', false],
  ['배경 위', true],
] as const;

const combos = DS2_COMBOS.flatMap(([theme, mode]) =>
  SIGNALS.flatMap(([signalLabel, signal]) =>
    BACKDROPS.map(([backdropLabel, onImage]) => ({
      theme,
      mode,
      label: `${signalLabel} · ${backdropLabel}`,
      signal,
      onImage,
    })),
  ),
);

describe('팔레트 96벌 — 사람이 고를 수 있는 조합 전수', () => {
  it('조합이 정말 아흔여섯이다 (48 × 바닥 둘)', () => {
    expect(combos).toHaveLength(96);
  });

  describe.each(combos)('$theme/$mode · $label', ({theme, mode, signal, onImage}) => {
    const {palette, signal: state} = resolveAppearance(theme, mode, signal, onImage);

    it('글자 쌍이 전부 AA(4.5:1) 를 넘는다', () => {
      const low = TEXT_PAIRS.map(([fg, bg]) => ({
        fg,
        bg,
        ratio: contrast(palette[fg], palette[bg]),
      })).filter(pair => pair.ratio < TEXT_MIN_CONTRAST);
      expect(low).toEqual([]);
    });

    it('강조 채움이 표면·바닥 위에서 비텍스트 3:1 을 넘고, 부드러운 채움은 표면에서 보인다', () => {
      for (const host of ['surface', 'surfaceMuted', 'sheet', 'canvasTop', 'bg', 'canvasBottom'] as const) {
        expect([host, contrast(palette.accent, palette[host]) >= NON_TEXT_MIN_CONTRAST]).toEqual([
          host,
          true,
        ]);
      }
      expect(contrast(palette.accentSurface, palette.surface)).toBeGreaterThanOrEqual(
        VESSEL_MIN_CONTRAST,
      );
      expect(oklabDistance(palette.accentSurface, palette.surface)).toBeGreaterThanOrEqual(
        VESSEL_MIN_DISTANCE,
      );
    });

    it('거절됐다면 테마 기본 신호로 그려진다 — 화면을 잠그지 않는다', () => {
      if (state.kind === 'rejected') {
        expect(palette).toBe(resolveAppearance(theme, mode, null, onImage).palette);
        expect(state.message.length).toBeGreaterThan(0);
      }
    });

    it('주 행동은 신호가 아니라 잉크다 — 강조색이 primary 를 바꾸지 않는다', () => {
      const base = resolveAppearance(theme, mode, null, onImage).palette;
      expect(palette.primary).toBe(base.primary);
      expect(palette.onPrimary).toBe(base.onPrimary);
      expect(palette.mode).toBe(mode);
    });
  });

  it('같은 조합은 같은 팔레트 객체다 — useStyles 캐시가 조합당 한 벌인 이유', () => {
    for (const [theme, mode] of DS2_COMBOS) {
      expect(resolveAppearance(theme, mode, {preset: 'seongun'}).palette).toBe(
        resolveAppearance(theme, mode, {preset: 'seongun'}).palette,
      );
    }
    expect(signalKey({custom: '#3a6bd8'})).toBe(signalKey({custom: '#3A6BD8'}));
  });

  it('프리셋 네 개는 여섯 조합 어디서도 거절되지 않는다 (themes-2.0 §4)', () => {
    for (const [theme, mode] of DS2_COMBOS) {
      for (const id of SIGNAL_PRESET_IDS) {
        expect(resolveAppearance(theme, mode, {preset: id}).signal.kind).toBe('preset');
      }
    }
  });

  it('보정 경로가 실제로 걸린다 — 순백 입력은 어느 모드에서도 입력 그대로 나가지 않는다', () => {
    for (const [theme, mode] of DS2_COMBOS) {
      const raw = resolveSignal('#FFFFFF', theme, mode);
      const fromState = resolveAppearance(theme, mode, {custom: '#FFFFFF'});
      if (raw.ok) {
        expect(raw.adjusted).toBe(true);
        expect(fromState.palette.accent.toLowerCase()).not.toBe('#ffffff');
        expect(fromState.signal).toMatchObject({kind: 'custom', adjusted: true});
      } else {
        expect(fromState.signal.kind).toBe('rejected');
      }
    }
  });
});

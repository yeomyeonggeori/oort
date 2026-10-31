import type {Mode} from '@momo/core/design/themes';
import {contrast, hueGap} from '@momo/core/design/color';
import {SIGNAL_PRESET_IDS} from '@momo/core/design/signal';
import type {SignalChoice} from '@momo/core/design/appearance';

import {resolveAppearance} from '../src/design/appearanceState';
import {
  BACKDROP_SCRIM_ALPHA,
  FIT_MARGIN,
  INK_MIN_ON_BACKDROP,
  NON_TEXT_MIN_ON_BACKDROP,
  TEXT_MIN_ON_BACKDROP,
  blend,
  fitForeground,
  holdsOnBoth,
  minimumScrimAlpha,
  scrimColor,
  worstCaseBackdrops,
} from '@momo/core/design/scrim';
import {DS2_COMBOS, THEME_IDS} from '../src/design/ds2Tokens';
import {paletteFrom} from '../src/design/tokens';

// =============================================================================
// ADR-0189 증보 2 — 배경 위 글자 대비를 **최악 입력**으로 잰다 (#3907).
//
// 사진은 우리가 못 보는 입력이다. 그래서 보장은 「이 사진에서 읽힌다」가 아니라 「어떤
// 사진이어도 읽힌다」다. scrim 합성의 대비는 사진 픽셀의 휘도에 단조이므로 최악은 순흑
// 사진·순백 사진 둘이고, 이 파일은 그 둘과 잡음(결정적 의사난수 픽셀 수백 개)을 잰다.
//
// 불투명도 토큰은 눈대중이 아니다: 여기서 같은 산수로 다시 구해 토큰과 대조한다. 그리고
// **토큰을 낮추면 빨개진다**는 것을 사보타주로 보인다(실패할 수 없는 가드가 아니다).
// =============================================================================

const MODES: readonly Mode[] = ['light', 'dark'];

/* eslint-disable no-bitwise -- 의사난수 생성기는 비트 연산이 본업이다 */
/** 결정적 의사난수(mulberry32). 시험이 흔들리지 않게 시드를 고정한다. */
function prng(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* eslint-enable no-bitwise */

function noisyPixels(count: number, seed: number): string[] {
  const next = prng(seed);
  const channel = () =>
    Math.floor(next() * 256)
      .toString(16)
      .padStart(2, '0');
  return Array.from({length: count}, () => `#${channel()}${channel()}${channel()}`);
}

/** 극단 + 잡음 + 체커보드의 두 색 — 「잡음이 낀 사진」의 대리. */
const PIXELS: readonly string[] = [
  '#000000',
  '#ffffff',
  '#7f7f7f',
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#ffff00',
  ...noisyPixels(300, 20261016),
];

const ROLES_TEXT = ['textMuted', 'accentText', 'agent', 'warn', 'danger', 'ok'] as const;
const ROLES_NON_TEXT = ['textFaint', 'icon', 'accent'] as const;

const SIGNALS: ReadonlyArray<readonly [string, SignalChoice]> = [
  ['기본', null],
  ...SIGNAL_PRESET_IDS.map(id => [`프리셋 ${id}`, {preset: id}] as const),
  ['커스텀 #FFE600', {custom: '#FFE600'}],
  ['커스텀 #3A6BD8', {custom: '#3A6BD8'}],
];

describe('scrim 불투명도 토큰은 산수의 결과다', () => {
  it.each(MODES)('%s — 여섯 조합 중 가장 큰 「잉크 7:1 최소 불투명도」 이상이고 0.02 넘게 두껍지 않다', mode => {
    const needed = THEME_IDS.map(theme => {
      const base = paletteFrom(theme, mode);
      return minimumScrimAlpha(base.bg, base.text, INK_MIN_ON_BACKDROP);
    });
    const worst = Math.max(...needed);
    expect(BACKDROP_SCRIM_ALPHA[mode]).toBeGreaterThanOrEqual(worst);
    // 필요 이상으로 두꺼우면 사진이 괜히 더 흐려진다 — 성재가 받아들인 「조금 흐리게」의 한도.
    expect(BACKDROP_SCRIM_ALPHA[mode]).toBeLessThanOrEqual(worst + 0.02);
  });

  it('사보타주 — 토큰을 0.15 낮추면 같은 자가 최악 입력에서 빨개진다', () => {
    for (const [theme, mode] of DS2_COMBOS) {
      const base = paletteFrom(theme, mode);
      const thin = BACKDROP_SCRIM_ALPHA[mode] - 0.15;
      expect(holdsOnBoth(base.text, worstCaseBackdrops(base.bg, thin), INK_MIN_ON_BACKDROP)).toBe(false);
      expect(
        holdsOnBoth(base.text, worstCaseBackdrops(base.bg, BACKDROP_SCRIM_ALPHA[mode]), INK_MIN_ON_BACKDROP),
      ).toBe(true);
    }
  });

  it('scrim 색은 바닥색에 모드별 불투명도를 단 #rrggbbaa 다', () => {
    for (const [theme, mode] of DS2_COMBOS) {
      const palette = paletteFrom(theme, mode);
      expect(palette.backdropScrim).toBe(scrimColor(palette.bg, BACKDROP_SCRIM_ALPHA[mode]));
      expect(palette.backdropScrim).toHaveLength(9);
    }
  });
});

describe.each(DS2_COMBOS)('%s/%s — 어떤 사진 위에서도', (theme, mode) => {
  const base = paletteFrom(theme, mode);
  const alpha = BACKDROP_SCRIM_ALPHA[mode];

  it('잉크가 순흑·순백·잡음 픽셀 위 합성에서 7:1 이상이다', () => {
    const low = PIXELS.map(pixel => ({
      pixel,
      ratio: contrast(base.text, blend(base.bg, pixel, alpha)),
    })).filter(entry => entry.ratio < INK_MIN_ON_BACKDROP);
    expect(low).toEqual([]);
  });

  describe.each(SIGNALS)('%s', (_label, signal) => {
    const palette = resolveAppearance(theme, mode, signal, true).palette;

    it('이미지 모드 팔레트가 표시한다 — 바닥 스타일이 이것을 읽는다', () => {
      expect(palette.backdrop).toBe('image');
      expect(resolveAppearance(theme, mode, signal, false).palette.backdrop).toBe('canvas');
    });

    it('보조·강조 글자가 모든 픽셀 위 합성에서 4.5:1 이상이다', () => {
      const failures: string[] = [];
      for (const pixel of PIXELS) {
        const host = blend(palette.bg, pixel, alpha);
        for (const role of ROLES_TEXT) {
          const ratio = contrast(palette[role], host);
          if (ratio < TEXT_MIN_ON_BACKDROP) failures.push(`${role}@${pixel}=${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it('하한에서 멈추지 않는다 — 보정은 여유(FIT_MARGIN)를 얹어 하한보다 높게 선다', () => {
      const thin: string[] = [];
      for (const pixel of ['#000000', '#ffffff']) {
        const host = blend(palette.bg, pixel, alpha);
        for (const role of ROLES_TEXT) {
          if (contrast(palette[role], host) < TEXT_MIN_ON_BACKDROP + FIT_MARGIN - 0.05) {
            thin.push(`${role}@${pixel}`);
          }
        }
      }
      expect(thin).toEqual([]);
    });

    it('아이콘·옅은 선·강조 채움이 3:1 이상이다', () => {
      const failures: string[] = [];
      for (const pixel of PIXELS) {
        const host = blend(palette.bg, pixel, alpha);
        for (const role of ROLES_NON_TEXT) {
          const ratio = contrast(palette[role], host);
          if (ratio < NON_TEXT_MIN_ON_BACKDROP) failures.push(`${role}@${pixel}=${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it('잉크는 손대지 않고 색상각은 지킨다 — 의미 색이 다른 색이 되지 않는다', () => {
      const plain = resolveAppearance(theme, mode, signal, false).palette;
      expect(palette.text).toBe(plain.text);
      expect(palette.primary).toBe(plain.primary);
      for (const role of ['accentText', 'agent', 'warn', 'danger', 'ok'] as const) {
        // 무채색에 가까운 색은 색상각이 의미 없다.
        expect([role, hueGap(plain[role], palette[role]) <= 12]).toEqual([role, true]);
      }
    });

    it('accent 채움 위 글자도 4.5:1 이다', () => {
      expect(contrast(palette.onAccent, palette.accent)).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe('보정은 닿는 역할에만 닿는다', () => {
  it('캔버스 팔레트와 이미지 팔레트는 바닥 역할(bg·canvas·surface·sheet)이 같다', () => {
    for (const [theme, mode] of DS2_COMBOS) {
      const plain = resolveAppearance(theme, mode, null, false).palette;
      const image = resolveAppearance(theme, mode, null, true).palette;
      for (const role of ['bg', 'canvasTop', 'canvasBottom', 'surface', 'sheet', 'surfaceMuted'] as const) {
        expect([role, image[role]]).toEqual([role, plain[role]]);
      }
    }
  });

  it('fitForeground — 이미 통과하는 색은 입력 그대로, 못 넘는 색은 모드의 방향으로만 옮긴다', () => {
    const lightHosts = worstCaseBackdrops(paletteFrom('dawnsky', 'light').bg, BACKDROP_SCRIM_ALPHA.light);
    const darkHosts = worstCaseBackdrops(paletteFrom('dawnsky', 'dark').bg, BACKDROP_SCRIM_ALPHA.dark);

    // 라이트: 아주 어두운 글자는 이미 통과 → 그대로.
    expect(fitForeground('#101010', lightHosts, 4.5, 'light')).toBe('#101010');
    // 라이트: 연한 호박은 못 넘는다 → 더 어두워지고 색상각은 거의 그대로다.
    const amber = '#D9902F';
    const fitted = fitForeground(amber, lightHosts, 4.5, 'light');
    expect(fitted).not.toBe(amber.toLowerCase());
    expect(luminanceOf(fitted)).toBeLessThan(luminanceOf(amber));
    expect(holdsOnBoth(fitted, lightHosts, 4.5)).toBe(true);
    expect(hueGap(amber, fitted)).toBeLessThanOrEqual(12);

    // 다크: 어두운 글자는 못 넘는다 → 더 밝아진다.
    const navy = '#3A4A8C';
    const lifted = fitForeground(navy, darkHosts, 4.5, 'dark');
    expect(luminanceOf(lifted)).toBeGreaterThan(luminanceOf(navy));
    expect(holdsOnBoth(lifted, darkHosts, 4.5)).toBe(true);
  });
});

function luminanceOf(hex: string): number {
  // 상대휘도의 단조 대리: 대비를 흰색 대비 역수로 본다.
  return 1 / contrast(hex, '#ffffff');
}

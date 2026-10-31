import {DS2_COMBOS} from '../src/design/ds2Tokens';
import {paletteFrom} from '../src/design/tokens';

it('AP-6: 첫 파티 6조합은 카탈로그 도입 전 팔레트와 같아요', () => {
  expect(
    Object.fromEntries(
      DS2_COMBOS.map(([theme, mode]) => [
        `${theme}/${mode}`,
        paletteFrom(theme, mode),
      ]),
    ),
  ).toMatchSnapshot();
});

import {THEME_CATALOG} from '@momo/core/design/themeCatalog.generated';
import {MODES} from '@momo/core/design/themes';
import {contrast} from '@momo/core/design/color';
import {minimumScrimAlpha, worstCaseBackdrops} from '@momo/core/design/scrim';
import {resolveAppearance} from '../src/design/appearanceState';
import {resolveThemeTokens} from '../src/design/themeCatalog';

const catalogModes = THEME_CATALOG.flatMap(entry =>
  MODES.filter(mode => entry[mode]).map(mode => ({
    ref: `catalog:${entry.id}` as const,
    mode,
  })),
);

it('승인된 카탈로그 전수: GPL·Slack 제외 57모드와 첫 파티 6조합을 팔레트로 만들어요', () => {
  // 이슈의 59는 Slack 2종 제외 결정 이전 숫자예요. 현재 코어 목록을 그대로 소비해요.
  expect(catalogModes).toHaveLength(57);
  for (const {ref, mode} of catalogModes) {
    const palette = paletteFrom(ref, mode);
    expect(palette.mode).toBe(mode);
    expect(palette.text).toMatch(/^#[a-f0-9]{6}$/);
    const resolved = resolveAppearance(ref, mode, null);
    expect(resolved.palette).toEqual(palette);
    expect(resolveAppearance(ref, mode, null).palette).toBe(resolved.palette);
  }
});

it('카탈로그 onImage 전수: 잉크 7·보조 글자 4.5·표식 3을 지키거나 배경을 꺼요', () => {
  let active = 0;
  let unavailable = 0;
  for (const {ref, mode} of catalogModes) {
    const p = paletteFrom(ref, mode, null, true);
    const floor = minimumScrimAlpha(p.bg, p.text, 7);
    if (floor >= 0.97) {
      expect(p.backdrop).toBe('canvas');
      unavailable++;
      continue;
    }
    active++;
    expect(p.backdrop).toBe('image');
    // 실제 RN에 칠해지는 8bit 알파를 재서 반올림 오차까지 잡아요.
    const alpha = parseInt(p.backdropScrim.slice(7), 16) / 255;
    const hosts = worstCaseBackdrops(p.bg, alpha);
    for (const host of hosts) {
      expect(contrast(p.text, host)).toBeGreaterThanOrEqual(7);
      for (const key of [
        'textMuted',
        'accentText',
        'agent',
        'warn',
        'danger',
        'ok',
      ] as const) {
        expect(contrast(p[key], host)).toBeGreaterThanOrEqual(4.5);
      }
      for (const key of ['textFaint', 'icon', 'accent'] as const) {
        expect(contrast(p[key], host)).toBeGreaterThanOrEqual(3);
      }
    }
    expect(contrast(p.onAccent, p.accent)).toBeGreaterThanOrEqual(4.5);
  }
  expect(active).toBeGreaterThan(0);
  expect(active + unavailable).toBe(catalogModes.length);
  // 현행 엔진은 카탈로그 잉크도 보정하므로 거절 갈래는 대비가 부족한 토큰으로 확인해요.
  const t = resolveThemeTokens('catalog:github', 'light');
  const impossible = {...t, color: {...t.color, ink: t.canvas[1]}};
  expect(paletteFrom(impossible, 'light', null, true).backdrop).toBe('canvas');
});

it('카탈로그 신호는 core 엔진의 에이전트 재배치까지 반영하고 캐시는 참조별로 나뉘어요', () => {
  const choice = {preset: 'seongun'} as const;
  const ref = 'catalog:github';
  const p = resolveAppearance(ref, 'dark', choice).palette;
  const tokens = resolveThemeTokens(ref, 'dark', choice);
  expect(p.agent).toBe(tokens.color.agent.toLowerCase());
  expect(p.accent).toBe(tokens.color.signal.toLowerCase());
  expect(resolveAppearance('catalog:nord', 'dark', choice).palette).not.toBe(p);
});

it('카탈로그에서 거절된 신호도 상태·기본 색으로 안전하게 남아요', () => {
  const ref = 'catalog:github';
  const rejected = resolveAppearance(ref, 'dark', {custom: 'invalid'});
  expect(rejected.signal).toMatchObject({
    kind: 'rejected',
    reason: 'invalid-hex',
  });
  expect(rejected.palette.accent).toBe(
    resolveAppearance(ref, 'dark', null).palette.accent,
  );
});

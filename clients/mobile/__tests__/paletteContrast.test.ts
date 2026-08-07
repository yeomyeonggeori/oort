import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  darkPalette,
  lightPalette,
  type Palette,
} from '../src/design/tokens';

// =============================================================================
// U2 — 두 스킴을 **같은 자로** 잰다.
//
// 폰이 다크 한 벌이던 동안 대비 단정은 화면별 스위트에 흩어져 있었다
// (`conversationVisual` 이 인용 규정선을, `avatarRender` 가 에이전트 태그를, …).
// 그 배치가 옳았던 이유는 각 단정이 **그 화면의 결정**을 지켰기 때문이고, 그
// 이유는 지금도 유효하다. 여기서 새로 지는 것은 다른 것이다:
//
//   그 화면들이 지키던 관계가 **라이트에서도 성립하는가.**
//
// 라이트 값은 발명이 아니라 웹 `tokens.css` 의 번역이지만(`tokens.ts` 머리 주석),
// 웹에 짝이 없는 역할이 열 개 넘게 있고 그 값들은 다크가 지키던 관계를 라이트에서
// 다시 푼 답이다. 답을 손으로 골랐으면 자로 재야 한다.
//
// ## 왜 「둘 다」 인가 — 한 벌만 재면 늦게 안다
//
// 라이트만 재면 다크의 회귀를 놓치고, 다크만 재면 이 배치가 더한 스물여덟 값이
// 아무 자에도 걸리지 않는다. 그래서 아래 표는 팔레트를 **인자로** 받고 두 번
// 돈다. 새 역할이 생기면 두 스킴 모두에서 값을 대야 하고(`Palette` 가 그것을
// 컴파일 타임에 지고), 그 값이 관계를 깨면 여기서 빨개진다.
//
// 계산은 WCAG 상대휘도 정의 그대로다 — `conversationVisual.test.tsx` 의 그것과
// 같은 함수이고, 두 곳이 갈라지지 않도록 값은 언제나 `tokens.ts` 에서 읽는다.
// =============================================================================

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 대비비. 순서 무관. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * OKLCH 색상각 차이(0~180도).
 *
 * 대비는 「얼마나 멀리 갔는가」만 재고 「어느 쪽으로 갔는가」는 못 잰다. 한 단
 * 밝히려다 색이 넘어간 값(다크의 옛 `accentText` 는 accent 에서 색상각이 15도
 * 밀려 있었다)을 잡으려면 밝기와 **직교하는** 축이 필요하고, 그것이 이 각이다.
 * 웹 `tokens.contrast.test.ts` 가 인디고 대역 공백을 재는 데 쓰는 것과 같은 공간.
 */
function hueGap(a: string, b: string): number {
  const angle = (hex: string) => {
    const [R, G, B] = rgb(hex).map(channel);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    const ca = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const cb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return ((Math.atan2(cb, ca) * 180) / Math.PI + 360) % 360;
  };
  const raw = Math.abs(angle(a) - angle(b)) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/** `#rrggbbaa` 를 불투명한 배경 위에 합성한다. 스크림을 재려면 이것이 필요하다. */
function composite(overlay: string, base: string): string {
  const h = overlay.replace('#', '');
  const alpha = parseInt(h.slice(6, 8), 16) / 255;
  const [fr, fg, fb] = rgb(overlay);
  const [br, bg, bb] = rgb(base);
  const mix = (f: number, b: number) =>
    Math.round(alpha * f + (1 - alpha) * b)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(fr, br)}${mix(fg, bg)}${mix(fb, bb)}`;
}

const SCHEMES: ReadonlyArray<readonly [string, Palette]> = [
  ['dark', darkPalette],
  ['light', lightPalette],
];

/** 본문 잉크가 자기가 설 수 있는 모든 표면에서 AA 를 넘는다. */
const BODY_INK: ReadonlyArray<readonly [keyof Palette, keyof Palette]> = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surfacePressed'],
  ['text', 'accentSurface'],
  ['text', 'accentSurfaceStrong'],
  ['text', 'warnSurface'],
  ['text', 'okSurface'],
  ['textMuted', 'bg'],
  ['textMuted', 'surface'],
  ['textMuted', 'warnSurface'],
  ['accentText', 'bg'],
  ['accentText', 'surface'],
  ['onAccent', 'accent'],
  ['onAccent', 'accentPressed'],
  ['onWarn', 'warn'],
  ['agent', 'bg'],
  ['agent', 'surface'],
  ['agent', 'agentSurface'],
  ['warn', 'bg'],
  ['warn', 'surface'],
  ['danger', 'bg'],
  ['danger', 'surface'],
  ['dangerText', 'dangerSurface'],
  ['ok', 'bg'],
  ['ok', 'surface'],
];

describe.each(SCHEMES)('%s 팔레트', (_name, palette) => {
  it.each(BODY_INK)('%s on %s ≥ 4.5:1 (WCAG AA 본문)', (ink, surface) => {
    expect(contrast(palette[ink], palette[surface])).toBeGreaterThanOrEqual(4.5);
  });

  it('3단 회색이 세 단으로 남는다', () => {
    // 순서가 곧 위계다. 같은 값이 두 자리에 앉으면 화면에는 두 단만 남는다.
    const [text, muted, faint] = [
      contrast(palette.text, palette.bg),
      contrast(palette.textMuted, palette.bg),
      contrast(palette.textFaint, palette.bg),
    ];
    expect(text).toBeGreaterThan(muted);
    expect(muted).toBeGreaterThan(faint);
  });

  it('textFaint 는 컨트롤 테두리의 3:1 을 넘고, border 는 못 넘는다', () => {
    // `conversationVisual` 이 다크에서 이미 지키는 관계다 — 인용의 규정선은
    // `textFaint` 로 그려지고, 그것이 `border` 였다면 선이 사라진다.
    for (const surface of ['bg', 'surface'] as const) {
      expect(contrast(palette.textFaint, palette[surface])).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(palette.border, palette.bg)).toBeLessThan(3);
  });

  it('surface 는 bg 에서 **멀어지는 쪽**으로 한 단이고, 그 단은 조용하다', () => {
    // 다크에서는 밝아지고 라이트에서는 …도 밝아진다: 종이(#fffefb)가 바탕
    // (#f7f6f3)보다 밝은 것이 여명 팔레트의 라이트 항이고, 웹의
    // `--surface-raised`/`--surface` 가 정확히 그 관계다.
    expect(luminance(palette.surface)).toBeGreaterThan(luminance(palette.bg));
    // 고도 띠는 **띠**여야 한다. 1.1 을 넘으면 그것은 다른 표면이 된다.
    expect(contrast(palette.surface, palette.bg)).toBeLessThan(1.1);
  });

  it('accentSurfaceStrong 이 accentSurface 보다 눈에 띈다', () => {
    // 검색 일치는 스캔해서 **찾아져야** 하고, 내 반응 칩은 조용해야 한다.
    expect(contrast(palette.accentSurfaceStrong, palette.surface)).toBeGreaterThan(
      contrast(palette.accentSurface, palette.surface),
    );
  });

  it('스크림은 어느 스킴에서든 뒤를 **어둡게** 한다', () => {
    // 색이 아니라 방향이다. 라이트에서 `bg` 에 알파를 걸었다면 스크림이 배경을
    // 밝혀 시트가 뒤로 물러났을 것이고, 그것이 이 토큰이 잉크를 쓰는 이유다.
    for (const surface of ['bg', 'surface', 'surfacePressed'] as const) {
      const under = composite(palette.scrim, palette[surface]);
      expect(luminance(under)).toBeLessThan(luminance(palette[surface]));
      // 그리고 시트는 스크림 걸린 **어떤** 표면보다 앞에 있다.
      expect(luminance(palette.surface)).toBeGreaterThan(luminance(under));
    }
  });

  it('순백도 순흑도 없다 — 종이의 흰색은 #fffefb 다', () => {
    // 웹 팔레트가 처음부터 갖고 있던 규율(`tokens.css` 머리 주석). 그림자와
    // 스크림은 색이 아니라 방향이라 이 규칙 밖이다.
    const paint = Object.entries(palette).filter(
      ([role]) => role !== 'shadow' && role !== 'scrim',
    );
    for (const [role, value] of paint) {
      expect([role, value]).not.toEqual([role, '#ffffff']);
      expect([role, value]).not.toEqual([role, '#000000']);
    }
  });
});

describe('두 팔레트가 같은 역할표를 든다', () => {
  it('키가 정확히 같다', () => {
    // 타입이 이미 지는 계약이지만, 값이 빈 문자열이거나 한쪽이 옛 키를 남긴
    // 경우는 타입이 못 잡는다.
    expect(Object.keys(lightPalette).sort()).toEqual(
      Object.keys(darkPalette).sort(),
    );
  });

  it('두 스킴이 같은 값을 드는 역할은 **하나뿐**이고, 그것은 이유가 있다', () => {
    // 라이트가 다크의 복사본이 아니라는 것을 값으로 붙잡는다. 예외는 이유가 있는
    // 것만 남긴다:
    //
    //   shadow    그림자는 색이 아니라 **아래 방향**이라 스킴을 따라가지 않는다.
    //
    // `onAccent` 가 여기 있었다 (#1155 이전). 그때는 두 스킴의 accent 채움이 **둘 다
    // 어두웠고**(다크 파랑 #3b6fd4 · 라이트 #a54c08) 그래서 그 위의 글자가 어느
    // 쪽에서도 종이색이었다. 다크가 호박(#f0a850)으로 정렬되면서 그 채움만 밝아졌고,
    // 이제 다크의 `onAccent` 는 어두운 쪽이다 — 아래 「호박 채움」 단정이 그 뒤집힘을
    // 값이 아니라 **관계로** 잰다.
    //
    // 목록이 자라면 그것은 라이트가 다크를 베끼기 시작했다는 신호다.
    const shared = Object.keys(darkPalette).filter(
      role =>
        darkPalette[role as keyof Palette] === lightPalette[role as keyof Palette],
    );
    expect(shared.sort()).toEqual(['shadow']);
  });
});

// =============================================================================
// #1155 — 다크 accent 가족이 웹 다크 항과 **바이트로** 같다
//
// U2 가 라이트를 웹의 라이트 항으로 정렬했을 때 다크는 선존재 파랑(#3b6fd4)으로
// 남았다. 그래서 같은 앱이 스킴을 바꾸면 「내 것」의 색이 계열째 갈아탔고, 웹에서는
// 그 일이 일어날 수 없었다 — 웹은 두 스킴을 `light-dark()` 한 줄에 적으므로 두 항이
// 갈라질 자리가 없다.
//
// 이 스위트가 그 한 줄의 대역이다: 웹 `tokens.css` 를 **읽어서** 폰의 두 팔레트와
// 맞춘다. 값을 여기 베껴 적으면 웹이 움직인 날 폰만 조용히 뒤처지므로, 기대값의
// 출처는 언제나 그 파일이다.
//
// 범위는 accent 가족뿐이다. 다크의 나머지 역할(표면·잉크·warn·danger…)은 아직
// 정렬되지 않았고 그것은 #1155 의 밖이다 — 여기서 전부를 재면 이 스위트는 「지금
// 무엇이 정렬됐는가」가 아니라 「무엇이 아직 안 됐는가」를 말하게 된다.
// =============================================================================

describe('#1155 — accent 가족이 웹 정본과 값 단위로 같다', () => {
  const CSS = readFileSync(
    join(__dirname, '../../web/src/design/tokens.css'),
    'utf8',
  );

  /** `--name: light-dark(#aaa, #bbb);` 에서 두 항을 꺼낸다. */
  function lightDark(name: string): {light: string; dark: string} {
    const found = new RegExp(
      `--${name}:\\s*light-dark\\(\\s*(#[0-9a-f]{6})\\s*,\\s*(#[0-9a-f]{6})\\s*\\)`,
    ).exec(CSS);
    if (!found) throw new Error(`--${name} 를 웹 tokens.css 에서 못 찾았다`);
    return {light: found[1], dark: found[2]};
  }

  const PAIRS: ReadonlyArray<readonly [keyof Palette, string]> = [
    ['accent', 'accent'],
    ['accentSurface', 'accent-soft'],
    ['onAccent', 'on-accent'],
  ];

  it.each(PAIRS)('%s 가 웹 --%s 의 두 항과 같다', (role, cssVar) => {
    const web = lightDark(cssVar);
    expect(darkPalette[role]).toBe(web.dark);
    expect(lightPalette[role]).toBe(web.light);
  });

  it.each(SCHEMES)(
    '%s — 웹에 짝이 없는 둘은 accent 의 색상각 위에 있다',
    (_name, palette) => {
      // 「발명 금지」를 기계가 진다. `accentPressed`(눌린 채움)와 `accentText`(잉크)
      // 는 웹에 대응 토큰이 없어서 관계로 풀린 값이고, 그 관계의 첫 조건이 **같은
      // 색**이다 — 색상각이 벌어지면 그것은 한 단이 아니라 다른 색이다.
      for (const role of ['accentPressed', 'accentText'] as const) {
        expect(hueGap(palette[role], palette.accent)).toBeLessThan(3);
      }
    },
  );

  it.each(SCHEMES)(
    '%s — 눌린 채움은 어둡고, 잉크는 배경에서 한 단 더 멀다',
    (_name, palette) => {
      // 두 걸음의 **방향**은 스킴이 정하지 않는다. 눌린 채움은 어느 스킴에서든
      // 채움보다 어둡고(누르면 가라앉는다), 잉크는 어느 스킴에서든 배경에서 채움
      // 보다 멀다(글자는 채움보다 오래 읽힌다).
      expect(luminance(palette.accentPressed)).toBeLessThan(
        luminance(palette.accent),
      );
      expect(contrast(palette.accentText, palette.bg)).toBeGreaterThan(
        contrast(palette.accent, palette.bg),
      );
    },
  );

  it('호박 채움 위의 글자는 다크에서만 어두운 쪽이다', () => {
    // #1155 가 실제로 뒤집은 것 하나. 다크의 accent 채움이 밝아졌으므로 그 위의
    // 글자는 반대쪽으로 간다. 값이 아니라 관계로 적어야 팔레트가 또 움직여도 산다.
    expect(luminance(darkPalette.onAccent)).toBeLessThan(
      luminance(darkPalette.accent),
    );
    expect(luminance(lightPalette.onAccent)).toBeGreaterThan(
      luminance(lightPalette.accent),
    );
  });
});

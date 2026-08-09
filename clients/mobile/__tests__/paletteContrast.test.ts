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
    const [ca, cb] = opponent(hex);
    return ((Math.atan2(cb, ca) * 180) / Math.PI + 360) % 360;
  };
  const raw = Math.abs(angle(a) - angle(b)) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/** OKLab 의 두 색 축 `(a, b)`. 각을 재면 색상, 길이를 재면 채도다. */
function opponent(hex: string): [number, number] {
  const [R, G, B] = rgb(hex).map(channel);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * OKLab 채도(C).
 *
 * 위험 위계의 자다. 대비는 「얼마나 잘 읽히는가」를 재는데, AA 를 한참 넘긴 두 톤은
 * 그 축에서 구분되지 않는다 — 남는 차이가 채도이고, 웹 `--danger` 주석이 순서의
 * 척도를 여기로 고정한 이유가 그것이다.
 */
function chroma(hex: string): number {
  return Math.hypot(...opponent(hex));
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
    // **두 바탕 다** 못 넘는다 (리뷰 N-a). `bg` 만 재던 이 단정은 카드 위에 선
    // 컨트롤 테두리에 대해 아무 말도 하지 않았고, ADE 카드의 「대화로」가 정확히
    // 그 자리에서 `border` 를 쓰고 있었다 — 실측 라이트 1.409:1 · 다크 1.298:1.
    for (const surface of ['bg', 'surface'] as const) {
      expect(contrast(palette.border, palette[surface])).toBeLessThan(3);
    }
  });

  it('surface 는 bg 에서 **멀어지는 쪽**으로 한 단이고, 그 단이 팔레트에서 가장 조용하다', () => {
    // 다크에서는 밝아지고 라이트에서는 …도 밝아진다: 종이(#fffefb)가 바탕
    // (#f7f6f3)보다 밝은 것이 여명 팔레트의 라이트 항이고, 웹의
    // `--surface-raised`/`--surface` 가 정확히 그 관계다.
    expect(luminance(palette.surface)).toBeGreaterThan(luminance(palette.bg));

    // 여기 있던 문장은 「1.1 을 넘으면 다른 표면이 된다」였고, 그 1.1 은 폰이 자기
    // 다크(1.084)와 라이트(1.072)를 보고 그은 선이었다. #1164 가 두 표면을 웹 항으로
    // 정렬하자 다크가 **1.1001** 이 됐다 — 0.0001 초과다. 낡은 값에 단정을 맞추는
    // 대신(문턱을 1.11 로 밀거나 값을 웹에서 떼어 놓는 것) 이 단정이 실제로 지키던
    // 것을 적는다: 고도는 이 팔레트가 가진 **가장 조용한 구분**이고, 색을 가진 어떤
    // 채움도 그보다는 진해야 한다. 색이 고도보다 조용하면 색이 하는 말이 그림자가
    // 하는 말보다 작아진다.
    //
    // 숫자가 아니라 순위라서 두 스킴이 같은 문장을 진다 — 그리고 문턱이 아니므로
    // 웹이 두 표면을 다시 고르는 날에도 이 단정은 여전히 옳은 것을 잰다.
    // 실측: 다크 1.1001 < 1.1641(warnSurface) · 라이트 1.0716 < 1.0801(okSurface).
    const band = contrast(palette.surface, palette.bg);
    for (const fill of [
      'accentSurface',
      'agentSurface',
      'warnSurface',
      'dangerSurface',
      'okSurface',
    ] as const) {
      expect([fill, band < contrast(palette[fill], palette.bg)]).toEqual([
        fill,
        true,
      ]);
    }
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
    // 웹 팔레트가 처음부터 갖고 있던 규율(`tokens.css` 머리 주석: *"no pure
    // #000000 / #ffffff anywhere"*).
    //
    // 면제 목록이 하나 줄었다 (#1164). 스크림이 여기 있었던 이유는 다크의 값이
    // 실제로 순흑이었기 때문이다(`#000000aa`) — 8자리라 6자리 비교를 그냥 통과했고,
    // 그래서 면제는 그 사실을 **가리고** 있었다. 웹 `--scrim` 다크 항은 순흑이 아니라
    // `rgb(9 8 11 / .62)` 이고, 정렬 뒤에는 스크림도 이 규칙 안에서 산다. 알파를
    // 떼고 **색 부분**을 재는 것이 그 차이를 잡는 자다.
    //
    // `shadow` 만 남는다: 그림자는 색이 아니라 아래 **방향**이고, 두 스킴이 같은 값을
    // 드는 유일한 역할인 것과 같은 이유다(아래 단정).
    for (const [role, value] of Object.entries(palette)) {
      if (role === 'shadow') continue;
      expect([role, value.slice(0, 7)]).not.toEqual([role, '#ffffff']);
      expect([role, value.slice(0, 7)]).not.toEqual([role, '#000000']);
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
// #1155 · #1164 — 두 팔레트가 웹 정본과 **바이트로** 같다
//
// 웹은 두 스킴을 `light-dark()` 한 줄에 적으므로 두 항이 갈라질 자리가 없다. 폰은
// 두 상수로 나눠 들기 때문에 그 자리가 있고, 실제로 세 번 갈라졌다 —
//
//   U2(#1153)   라이트를 웹 라이트 항으로 열여섯 역할 정렬. 다크는 손대지 않음.
//   #1155       다크 accent 가족만. 그때까지 다크 accent 는 선존재 파랑(#3b6fd4).
//   #1164       다크 나머지(표면·잉크·에이전트·warn·danger·ok·스크림).
//
// 이 스위트가 없는 `light-dark()` 의 대역이다: 웹 `tokens.css` 를 **읽어서** 폰의 두
// 팔레트와 맞춘다. 기대값을 여기 베껴 적으면 웹이 움직인 날 폰만 조용히 뒤처지므로,
// 출처는 언제나 그 파일이다.
//
// 범위가 자랐다. #1155 때 이 자리에는 *"범위는 accent 가족뿐이다 — 전부를 재면 이
// 스위트는 「무엇이 정렬됐는가」가 아니라 「무엇이 아직 안 됐는가」를 말하게 된다"* 가
// 적혀 있었고, 그 문장은 그때 참이었다. 지금은 짝이 있는 역할이 전부 정렬됐으므로
// 그 문장이 거짓이 됐고, 표는 「무엇이 정렬됐는가」를 그대로 말한다.
// =============================================================================

describe('#1155·#1164 — 두 팔레트가 웹 정본과 값 단위로 같다', () => {
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

  /**
   * 같은 일을 `rgb(r g b / a)` 두 항에 대해 — 그리고 폰의 표기(`#rrggbbaa`)로 옮긴다.
   *
   * 스크림만 이 경로를 쓴다. 웹이 스크림을 알파와 함께 쓰는 유일한 토큰이고, RN 의
   * 스타일 값은 `rgb(… / …)` 를 모른다. 변환이 여기 있는 이유는 **폰이 옮긴 것을 다시
   * 옮겨 대조**해야 하기 때문이다 — 기대값을 손으로 적으면 대조가 아니라 복사가 된다.
   */
  function lightDarkRgb(name: string): {light: string; dark: string} {
    const term = String.raw`rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)`;
    const found = new RegExp(
      `--${name}:\\s*light-dark\\(\\s*${term}\\s*,\\s*${term}\\s*\\)`,
    ).exec(CSS);
    if (!found) throw new Error(`--${name} 를 웹 tokens.css 에서 못 찾았다`);
    const hex = (o: number) =>
      '#' +
      [1, 2, 3]
        .map(i => Number(found[o + i]).toString(16).padStart(2, '0'))
        .join('') +
      Math.round(Number(found[o + 4]) * 255)
        .toString(16)
        .padStart(2, '0');
    return {light: hex(0), dark: hex(4)};
  }

  /**
   * 웹에 짝이 있는 역할 전부. 대응은 `tokens.ts` 머리 주석의 표 그대로다.
   *
   * 웹에만 있고 폰에 짝이 **없는** 토큰은 여기 없다: `--surface-sidebar`(폰에는
   * 사이드바 표면이 따로 없다) · `--danger-fill`/`--on-danger-fill`(폰에는 파괴
   * 액션의 채움 토큰이 아직 없다 — 역할을 새로 만드는 것은 정렬이 아니라 신설이라
   * #1164 밖이다).
   */
  const PAIRS: ReadonlyArray<readonly [keyof Palette, string]> = [
    ['bg', 'surface'],
    ['surface', 'surface-raised'],
    ['surfacePressed', 'surface-hover'],
    ['border', 'line'],
    ['text', 'ink'],
    ['textMuted', 'ink-muted'],
    ['textFaint', 'line-strong'],
    ['accent', 'accent'],
    ['accentSurface', 'accent-soft'],
    ['onAccent', 'on-accent'],
    ['agent', 'agent'],
    ['agentSurface', 'agent-soft'],
    ['warn', 'warn'],
    ['danger', 'danger'],
    ['ok', 'ok'],
  ];

  it.each(PAIRS)('%s 가 웹 --%s 의 두 항과 같다', (role, cssVar) => {
    const web = lightDark(cssVar);
    expect([role, darkPalette[role]]).toEqual([role, web.dark]);
    expect([role, lightPalette[role]]).toEqual([role, web.light]);
  });

  it('scrim 이 웹 --scrim 의 두 항과 같다 (알파까지)', () => {
    const web = lightDarkRgb('scrim');
    expect(darkPalette.scrim).toBe(web.dark);
    expect(lightPalette.scrim).toBe(web.light);
  });

  it('짝을 못 찾으면 조용히 통과하지 않는다', () => {
    // 실패 모드를 닫는다. 웹이 변수를 개명하거나 서식을 바꾸면 위 표는 **없는 값과
    // 같다**로 통과할 수 없고 여기서 시끄럽게 터진다.
    expect(() => lightDark('surface-that-does-not-exist')).toThrow(
      /웹 tokens.css 에서 못 찾았다/,
    );
    expect(() => lightDarkRgb('accent')).toThrow(/못 찾았다/);
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

  // ---------------------------------------------------------------------------
  // 상태 3가족의 파생 — tone 이 웹으로 옮겨갈 때 가족이 따라갔는가 (#1164)
  //
  // `warn`·`danger`·`ok` 는 웹 항으로 옮겨졌지만 그 셋의 채움·테두리·잉크 여덟은 웹에
  // 짝이 없다. 그래서 이 여덟은 tone 이 돈 각도만큼(warn +7.21° · danger +10.42° ·
  // ok −10.10°) 같이 돌고, 걸음(앵커 대비 L 차)과 채도는 그대로 뒀다. 값이 아니라 그
  // **관계**를 여기서 잰다 — 두 스킴에서 같은 자로.
  // ---------------------------------------------------------------------------

  const FAMILY: ReadonlyArray<readonly [keyof Palette, keyof Palette]> = [
    ['warnSurface', 'warn'],
    ['warnBorder', 'warn'],
    ['dangerSurface', 'danger'],
    ['dangerBorder', 'danger'],
    ['dangerText', 'danger'],
    ['okSurface', 'ok'],
    ['okBorder', 'ok'],
  ];

  it.each(SCHEMES)('%s — 파생은 자기 tone 의 계열 안에 남는다', (_name, palette) => {
    // 문턱 15° 는 웹이 `--danger-fill` 에 이미 쓰고 있는 값이다(*"위험 계열 hue 차
    // <= 15도"*) — 같은 위험을 말하는 두 값이 같은 계열로 읽히는 한계각이고, 여기서
    // 새로 고른 숫자가 아니다. 실측 최대: 다크 13.63°(dangerSurface) · 라이트
    // 12.65°(warnSurface).
    //
    // `onWarn` 은 이 표에 없다. 라이트의 `onWarn` 은 종이색(#fffefb, 채도 0.004)이라
    // 색상각이 뜻을 잃는다 — 무채색의 각을 재는 것은 아무것도 재지 않는 것이다.
    // 그 값이 지는 계약은 색이 아니라 대비이고, 위 `BODY_INK` 가 잰다.
    for (const [child, tone] of FAMILY) {
      expect([child, hueGap(palette[child], palette[tone]) < 15]).toEqual([
        child,
        true,
      ]);
    }
  });

  it.each(SCHEMES)(
    '%s — 상태 채움은 고도보다 진하고, 그 테두리는 채움보다 진하다',
    (_name, palette) => {
      // 세 가족이 같은 두 단을 갖는다: 채움은 **배경을 물들이는** 정도이고(고도 한
      // 단보다는 진해야 색이 그림자보다 큰 말을 한다), 테두리는 그 채움을 **끝내는**
      // 선이라 채움보다 진하다. 두 단이 뒤집히면 상자가 안팎을 잃는다.
      const band = contrast(palette.surface, palette.bg);
      for (const tone of ['warn', 'danger', 'ok'] as const) {
        const fill = contrast(palette[`${tone}Surface`], palette.bg);
        const edge = contrast(palette[`${tone}Border`], palette.bg);
        expect([tone, band < fill, fill < edge]).toEqual([tone, true, true]);
      }
    },
  );

  it.each(SCHEMES)(
    '%s — 위험 순서의 자는 대비가 아니라 채도다',
    (_name, palette) => {
      // 웹 `--danger` 주석이 적어 둔 규율 그대로다: 한 표면에 두 톤이 나란히 서면 더
      // 위험한 쪽이 먼저 눈에 들어와야 하고, 둘 다 AA 를 한참 넘기므로 그 순서를
      // 가르는 것은 대비가 아니라 채도(OKLab C)다.
      //
      // 폰이 이것을 지고 있지 **않았다**는 것이 #1164 가 찾은 것 하나다: 옛 다크는
      // danger C 0.1305 · warn C 0.1295 로 순서가 1.008 배 차이의 우연이었다. 웹
      // 다크 항은 같은 자리에서 0.1661 · 0.1407(1.18배)이고, 라이트는 처음부터
      // 0.1783 · 0.1079 였다.
      const c = (role: keyof Palette) => chroma(palette[role]);
      expect(c('danger')).toBeGreaterThan(c('warn'));
      expect(c('warn')).toBeGreaterThan(c('textMuted'));
    },
  );
});

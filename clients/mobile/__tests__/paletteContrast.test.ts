import {
  contrast as coreContrast,
  normalizeHex,
  oklabDistance,
} from '@momo/core/design/color';
import {
  COLOR_ROLES,
  GLASS_FALLBACK_OPACITY,
  THEMES as CORE_THEMES,
  VESSEL_MIN_CONTRAST,
  VESSEL_MIN_DISTANCE,
  contrastPairs,
} from '@momo/core/design/themes';

import {
  DEFAULT_THEME_ID,
  DS2_COMBOS,
  ds2Roles,
  THEMES,
} from '../src/design/ds2Tokens';
import {
  darkPalette,
  DS2_ROLE_MAP,
  lightPalette,
  paletteFrom,
  rgbaToHex8,
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
// 두 팔레트의 값은 core 새벽하늘 표에서 오지만(`tokens.ts` 머리 주석, ADR-0189 D5),
// core 에 짝이 없는 역할이 일곱 있고 그 값들은 관계로 계산한 답이다. 답을 계산했으면
// 그 계산이 지키려던 관계를 자로 재야 한다.
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
  // 잉크 채움 위의 글자 (ADR-0189 D1 — FAB·보내기·주 버튼).
  ['onPrimary', 'primary'],
  ['text', 'sheet'],
  ['textMuted', 'sheet'],
  ['onWarn', 'warn'],
  // 파괴 채움 위의 글자 (#1210 D2). 이 줄이 없던 동안 「거부 확정」의 라벨은
  // `onAccent` 였고, 다크에서 그것은 **어두운** 잉크(#17161a)를 어두운 테두리
  // 색(#623635) 위에 얹는 것이었다 — 실측 1.80:1 (라이트 1.89:1).
  ['onDangerFill', 'dangerFill'],
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

  it('surface 는 바닥에서 **멀어지는 쪽**으로 한 단이고, 색 채움은 표면 위에서 보인다', () => {
    // 고도의 방향: 카드(`surface`)는 바닥의 가운데 정지점(`bg`)보다 밝다 — 두
    // 스킴 모두. 새벽하늘 다크에서 그 단은 1.045 로 작다. 다크 카드는 그림자
    // 하이라이트(ADR-0189 표 「유리·스크림·그림자」)로 떠 있고, 대비로 뜨지 않는다.
    expect(luminance(palette.surface)).toBeGreaterThan(luminance(palette.bg));

    // 여명 판의 문장은 「고도는 팔레트의 **가장 조용한 구분**이고, 색 채움은 바닥
    // 위에서 그보다 진해야 한다」였다. ADR-0189 D1·D2 가 그 전제를 바꿨다: 바닥은
    // 이제 그라데이션 판이고 칩·상태 상자는 바닥이 아니라 **표면** 위에 선다. 새벽
    // 라이트의 soft 채움은 바닥 가운데 정지점 위에서 1.00~1.02 라 옛 단정을 그대로
    // 두면 서지도 않는 자리를 재며 빨개진다. 그래서 채움은 자기가 서는 면(`surface`
    // )에서 core 가 그릇에 거는 두 자(대비 1.05, OKLab 0.02)로 잰다.
    //
    // `sheet` 는 재지 않는다 — 재 보면 새벽 라이트 `warn-soft`(#FFEDD4)가 `sheet`
    // (#F4F2EF) 위 대비 1.026 · OKLab 0.035 로 첫 자에 못 미친다. 이 값은 core 표의
    // 두 값이고 core 채움 쌍은 soft 를 시트 위에서 재지 않는다. 폰에서 상태 칩이
    // 시트 위에 서는 자리(프로필·설정 시트)의 재도색은 DS2-5(#2717)라 거기로 넘긴다
    // (PR #2714 REMAINING).
    for (const fill of [
      'accentSurface',
      'agentSurface',
      'warnSurface',
      'dangerSurface',
      'okSurface',
    ] as const) {
      for (const host of ['surface'] as const) {
        expect([
          fill,
          host,
          contrast(palette[fill], palette[host]) >= VESSEL_MIN_CONTRAST &&
            oklabDistance(palette[fill], palette[host]) >= VESSEL_MIN_DISTANCE,
        ]).toEqual([fill, host, true]);
      }
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

  it('순백도 순흑도 없다 — 종이의 흰색은 #fffefc 다', () => {
    // 웹 팔레트가 처음부터 갖고 있던 규율(*"no pure #000000 / #ffffff anywhere"*).
    // 알파를 떼고 **색 부분**을 잰다.
    //
    // 면제는 **알파 층** 셋과 그림자다. 그림자는 색이 아니라 아래 방향이다. 알파
    // 층은 스스로 색으로 서지 않고 밑의 면과 섞여서만 보인다:
    //   scrim      core 다크 `rgba(0,0,0,.55)` (ADR-0189 표 「유리·스크림·그림자」).
    //              여명 판은 이것을 순흑이 아닌 값으로 옮겨 면제를 걷었었다 — 그
    //              값은 폰이 고른 것이 아니라 웹 항이었고, 지금의 원천은 core 다.
    //   glassLine  시안 A `--glassLine` (라이트 흰 70%, 다크 흰 7%). 유리 가장자리의
    //              반사광이라 흰색이 정의다.
    const ALPHA_LAYERS = new Set(['shadow', 'scrim', 'glassLine']);
    for (const [role, value] of Object.entries(palette)) {
      if (ALPHA_LAYERS.has(role)) continue;
      expect([role, value.slice(0, 7)]).not.toEqual([role, '#ffffff']);
      expect([role, value.slice(0, 7)]).not.toEqual([role, '#000000']);
    }
    // 면제된 셋은 실제로 알파를 든다 — 불투명으로 바뀌면 면제가 거짓이 된다.
    for (const role of ['scrim', 'glassLine'] as const) {
      expect([role, palette[role].length, palette[role].slice(7) === 'ff']).toEqual([
        role,
        9,
        false,
      ]);
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
// DS2-2 (#2714) — 두 팔레트가 core 새벽하늘과 **값 단위로** 같다
//
// 이 자리에는 「#1155·#1164 — 두 팔레트가 웹 정본과 값 단위로 같다」가 있었다. 웹
// `tokens.css`를 읽어 폰의 두 팔레트와 바이트로 맞추던 블록이고, 폰이 두 상수로
// 나눠 들던 동안 `light-dark()` 한 줄의 대역이었다(그 사이 세 번 갈라졌다 — U2,
// #1155, #1164).
//
// ADR-0189 D5·D6이 원천을 core 한 곳으로 옮겼다. 폰도 웹도 core를 대조하고, 폰이
// 웹 CSS를 읽을 이유가 사라졌다(웹 `tokens.css`는 DS2-1 #2713이 바꾸는 중이라,
// 남겨 두면 어느 쪽이 먼저 들어오든 옳은 값을 두고 빨개진다). 그래서 출처가 바뀐다:
// 기대값은 여전히 여기 베껴 적지 않고, `DS2_ROLE_MAP`이 말하는 core 역할을
// `ds2Roles`에서 **읽어서** 맞춘다.
//
// 관계 단정(색상각·방향·채도 위계·파괴 채움)은 남는다. 여명 값에서 새벽하늘 값으로
// 옮기면서 ADR-0189가 **관계 자체를** 바꾼 곳이 셋 있고, 각 단정 주석에 그 ADR
// 줄을 적었다: 바닥이 그라데이션 판이 되어 칩이 바닥이 아니라 표면 위에 서는 것,
// 주 행동이 신호색이 아니라 잉크가 된 것, 상태 soft 채움이 폰의 파생이 아니라 core
// 표의 값이 된 것.
// =============================================================================

describe('DS2-2 — 두 팔레트가 core 새벽하늘과 값 단위로 같다 (ADR-0189 D5)', () => {
  const MAPPED = Object.entries(DS2_ROLE_MAP) as ReadonlyArray<
    readonly [keyof typeof DS2_ROLE_MAP, string]
  >;

  it.each(MAPPED)('%s 가 core --%s 의 두 항과 같다', (role, coreRole) => {
    const light = ds2Roles(DEFAULT_THEME_ID, 'light')[coreRole];
    const dark = ds2Roles(DEFAULT_THEME_ID, 'dark')[coreRole];
    expect([role, darkPalette[role]]).toEqual([role, normalizeHex(dark)]);
    expect([role, lightPalette[role]]).toEqual([role, normalizeHex(light)]);
  });

  it('기본 테마는 새벽하늘이다', () => {
    expect(DEFAULT_THEME_ID).toBe('dawnsky');
  });

  it('스크림과 유리가 core rgba 의 두 항과 같다 (알파까지)', () => {
    for (const mode of ['light', 'dark'] as const) {
      const palette = mode === 'light' ? lightPalette : darkPalette;
      const roles = ds2Roles(DEFAULT_THEME_ID, mode);
      expect([mode, palette.scrim]).toEqual([mode, rgbaToHex8(roles.scrim)]);
      expect([mode, palette.glass]).toEqual([mode, rgbaToHex8(roles.glass)]);
    }
  });

  it('유리 대체값은 surface 94% 다 (ADR-0189 D7)', () => {
    for (const palette of [lightPalette, darkPalette]) {
      expect(palette.glassFallback.slice(0, 7)).toBe(palette.surface);
      expect(parseInt(palette.glassFallback.slice(7, 9), 16) / 255).toBeCloseTo(
        GLASS_FALLBACK_OPACITY,
        2,
      );
    }
  });

  it('짝을 못 찾으면 조용히 통과하지 않는다', () => {
    // 대응표의 모든 core 역할이 여섯 조합 전부에 실제로 있다 — 테마를 고르는
    // DS2-7이 같은 함수로 다른 테마의 팔레트를 만든다.
    for (const [theme, mode] of DS2_COMBOS) {
      const roles = ds2Roles(theme, mode);
      for (const [, coreRole] of MAPPED) {
        expect([theme, mode, coreRole, typeof roles[coreRole]]).toEqual([
          theme,
          mode,
          coreRole,
          'string',
        ]);
      }
      expect(() => paletteFrom(theme, mode)).not.toThrow();
    }
    expect(() => rgbaToHex8('#fffefc')).toThrow(/rgba/);
  });

  it.each(SCHEMES)(
    '%s — core 에 짝이 없는 둘은 accent 의 색상각 위에 있다',
    (_name, palette) => {
      // 「발명 금지」를 기계가 진다. `accentPressed`(눌린 채움)와 `accentText`(잉크)
      // 는 같은 색의 한 단이어야 한다 — 색상각이 벌어지면 그것은 다른 색이다.
      for (const role of ['accentPressed', 'accentText'] as const) {
        expect(hueGap(palette[role], palette.accent)).toBeLessThan(3);
      }
    },
  );

  it.each(SCHEMES)(
    '%s — 눌린 채움은 어둡고, 잉크는 배경에서 한 단 더 멀다',
    (_name, palette) => {
      expect(luminance(palette.accentPressed)).toBeLessThan(
        luminance(palette.accent),
      );
      expect(contrast(palette.accentText, palette.bg)).toBeGreaterThan(
        contrast(palette.accent, palette.bg),
      );
    },
  );

  it('호박 채움 위의 글자는 다크에서만 어두운 쪽이다', () => {
    expect(luminance(darkPalette.onAccent)).toBeLessThan(
      luminance(darkPalette.accent),
    );
    expect(luminance(lightPalette.onAccent)).toBeGreaterThan(
      luminance(lightPalette.accent),
    );
  });

  // ---------------------------------------------------------------------------
  // 폰의 파생 — core 에 짝이 없는 상태 역할이 자기 tone 의 계열 안에 남는가
  //
  // 여명 판에서 이 표는 soft 채움(`*Surface`)까지 들었다. 그 값들이 폰의 파생이었기
  // 때문이다. 새벽하늘에서 soft 채움은 core 표의 값(`*-soft`)이고, 그 대비는 core
  // `themes.test.ts`의 채움 쌍이 잰다. 여기 남는 것은 **폰이 계산한** 넷뿐이다 —
  // 그리고 새벽 라이트 `danger-soft`(#FFE9E5)는 `danger`(#BE2C4F)와 색상각이
  // 17.4° 떨어져 있어서, 옛 표에 넣으면 core 의 결정을 폰의 자로 뒤집게 된다.
  // ---------------------------------------------------------------------------

  const DERIVED: ReadonlyArray<readonly [keyof Palette, keyof Palette]> = [
    ['warnBorder', 'warn'],
    ['dangerBorder', 'danger'],
    ['dangerText', 'danger'],
    ['okBorder', 'ok'],
  ];

  it.each(SCHEMES)('%s — 파생은 자기 tone 의 계열 안에 남는다', (_name, palette) => {
    // 문턱 15° 는 웹이 `--danger-fill` 에 쓰던 「같은 위험 계열」의 한계각이다.
    for (const [child, tone] of DERIVED) {
      expect([child, hueGap(palette[child], palette[tone]) < 15]).toEqual([
        child,
        true,
      ]);
    }
  });

  it.each(SCHEMES)(
    '%s — 상태 채움은 자기가 서는 표면에서 보이고, 그 테두리는 채움보다 진하다',
    (_name, palette) => {
      // 관계가 바뀐 첫째 자리 (ADR-0189 D1·D2). 여명의 `bg`는 카드 밑의 평면이었고,
      // 칩은 그 평면을 물들였다. 새벽하늘의 `bg`는 그라데이션 **바닥**의 가운데
      // 정지점이고, 칩·상태 상자는 바닥이 아니라 그 위에 뜬 **표면**(`surface`)에
      // 선다. 라이트 바닥 위에서 soft 채움은 1.00~1.02 로 거의 사라지지만 그 자리에
      // 칩이 서지 않는다. 그래서 자는 표면이고, 문턱은 core 가 그릇에 거는 두 자
      // (대비 1.05, OKLab 0.02)다.
      for (const tone of ['warn', 'danger', 'ok'] as const) {
        const fill = palette[`${tone}Surface`];
        const edge = palette[`${tone}Border`];
        expect([
          tone,
          contrast(fill, palette.surface) >= VESSEL_MIN_CONTRAST,
          oklabDistance(fill, palette.surface) >= VESSEL_MIN_DISTANCE,
          contrast(fill, palette.surface) < contrast(edge, palette.surface),
        ]).toEqual([tone, true, true, true]);
      }
    },
  );

  it.each(SCHEMES)(
    '%s — 위험 순서의 자는 대비가 아니라 채도다',
    (_name, palette) => {
      const c = (role: keyof Palette) => chroma(palette[role]);
      expect(c('danger')).toBeGreaterThan(c('warn'));
      expect(c('warn')).toBeGreaterThan(c('textMuted'));
    },
  );

  it.each(SCHEMES)(
    '%s — 파괴 채움은 자기가 서는 표면에서 3:1 을 넘는다',
    (_name, palette) => {
      for (const surface of ['bg', 'surface', 'sheet', 'canvasTop', 'canvasBottom'] as const) {
        expect([
          surface,
          contrast(palette.dangerFill, palette[surface]) >= 3,
        ]).toEqual([surface, true]);
      }
    },
  );

  it.each(SCHEMES)(
    '%s — 파괴 채움은 보이되 주 행동을 이기지 않는다',
    (_name, palette) => {
      // 관계가 바뀐 둘째 자리 (ADR-0189 D1·D6). 여명에서 주 행동은 호박 `accent`
      // 채움이었고, 그래서 「파괴가 주 행동을 이기지 않는다」를 채도 비(≥1.15)로
      // 쟀다. 새벽하늘의 주 행동은 **잉크**(`primary`)다 — 채도가 0 이라 채도 비는
      // 뜻을 잃는다(실측: 새벽 신호 C 0.161/0.174 가 위험 0.182 보다 작아 옛 단정은
      // 0.88/0.96 으로 빨개진다. 신호는 이제 주 행동이 아니다).
      //
      // 무채색 잉크와 유채색 위험 채움 사이의 위계는 **대비**가 가른다: 두 채움이
      // 같은 표면에 나란히 서면 잉크가 더 멀리서 보여야 한다.
      for (const surface of ['surface', 'sheet'] as const) {
        expect([
          surface,
          contrast(palette.primary, palette[surface]) >
            contrast(palette.dangerFill, palette[surface]),
        ]).toEqual([surface, true]);
      }
      // 그리고 여전히 **위험 계열**이다. 문턱 15° 도 웹의 값.
      expect(hueGap(palette.dangerFill, palette.danger)).toBeLessThan(15);
    },
  );
});

// =============================================================================
// ADR-0189 D5·D6 — DS2 공유층. 원천은 core이고 폰은 그것을 경로로 직접 읽는다.
//
// 값은 여기 베껴 적지 않는다. 폰의 어댑터(`ds2Tokens.ts`)가 core 표를 **그대로**
// 들고 있는지(같은 객체), 역할 이름이 core 목록과 같은지, 그리고 그 표가 폰
// 런타임(jest + Metro와 같은 경로 풀이)에서도 대비 기준을 넘는지를 잰다. 전 조합
// 대비의 정본 시험은 core `themes.test.ts`다. 여기서 한 번 더 도는 것은 경로가
// 폰에서 실제로 풀린다는 증거이고, 어긋나면 이 파일이 빨개진다.
// =============================================================================

describe('DS2 공유층 — 원천은 core (ADR-0189 D5·D6)', () => {
  it('폰 어댑터가 core 표를 그대로 든다(복사가 아니라 같은 객체)', () => {
    expect(THEMES).toBe(CORE_THEMES);
  });

  it('여섯 조합 전부', () => {
    expect(DS2_COMBOS.map(([t, m]) => `${t}/${m}`)).toEqual([
      'dawnsky/light',
      'dawnsky/dark',
      'graphite/light',
      'graphite/dark',
      'noeul/light',
      'noeul/dark',
    ]);
  });

  it.each(DS2_COMBOS)('%s %s — 공유 색 역할이 core 목록 그대로다', (theme, mode) => {
    const roles = ds2Roles(theme, mode);
    for (const role of COLOR_ROLES) {
      expect([role, roles[role]]).toEqual([role, CORE_THEMES[theme][mode].color[role]]);
    }
    expect(roles['canvas-top']).toBe(CORE_THEMES[theme][mode].canvas[0]);
  });

  it('core 대비 쌍 356개가 폰 런타임에서도 기준을 넘는다', () => {
    const pairs = contrastPairs();
    expect(pairs.length).toBe(356);
    const failing = pairs.filter(p => coreContrast(p.fg, p.bg) < p.min);
    expect(failing).toEqual([]);
    // 폰 자체의 WCAG 식과 core 식이 같은 값을 낸다 — 두 자가 갈라지지 않는다.
    const probe = pairs[0];
    expect(contrast(probe.fg, probe.bg)).toBeCloseTo(coreContrast(probe.fg, probe.bg), 10);
  });
});

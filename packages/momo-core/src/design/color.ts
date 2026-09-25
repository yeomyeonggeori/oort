// =============================================================================
// 색의 자 — WCAG 대비와 OKLab 거리 (ADR-0189 D5).
//
// 디자인 시스템 2.0의 토큰 원천(`themes.ts`)과 커스텀 신호 보정(`signal.ts`)이
// 같은 산수를 쓰도록 한 자리에 둔다. 웹과 폰의 시험에 흩어져 있던 같은 식(웹
// `tokens.contrast.test.ts`, 폰 `paletteContrast.test.ts`)은 DS1 값을 재는 동안
// 그대로 남고, DS2 값은 이 파일로만 잰다.
//
// 순수 함수만 둔다. 입력은 `#RRGGBB` 문자열이고, 잘못된 입력은 `parseHex`가
// `null`로 알린다. 다른 함수는 잘못된 입력에 던진다: 원천 표의 오타가 조용히
// 검정으로 읽히면 대비 시험이 엉뚱한 쌍을 잰다.
// =============================================================================

export type Rgb = readonly [number, number, number];

export type Oklab = { L: number; a: number; b: number };

export type Oklch = { L: number; C: number; h: number };

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

/** `#RRGGBB`(대소문자 무관)만 받는다. 3자리·8자리·이름 색은 `null`이다. */
export function parseHex(input: string): Rgb | null {
  const found = HEX_RE.exec(input.trim());
  if (!found) return null;
  const h = found[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb;
}

function rgbOf(hex: string): Rgb {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`not a #RRGGBB color: ${hex}`);
  return rgb;
}

/** 소문자 `#rrggbb`. 생성물(CSS)은 이 표기만 쓴다. */
export function normalizeHex(hex: string): string {
  const [r, g, b] = rgbOf(hex);
  return toHex([r, g, b]);
}

function toHex(rgb: Rgb): string {
  return (
    "#" +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

function linear(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function gamma(linearValue: number): number {
  const v = linearValue <= 0.0031308 ? 12.92 * linearValue : 1.055 * linearValue ** (1 / 2.4) - 0.055;
  return v * 255;
}

/** WCAG 2.1 상대 휘도. */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 대비비. 순서 무관, 1~21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB → OKLab (Björn Ottosson). */
export function toOklab(hex: string): Oklab {
  const [R, G, B] = rgbOf(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** 두 색의 OKLab 유클리드 거리(ΔEok). */
export function oklabDistance(x: string, y: string): number {
  const p = toOklab(x);
  const q = toOklab(y);
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

export function toOklch(hex: string): Oklch {
  const { L, a, b } = toOklab(hex);
  const C = Math.hypot(a, b);
  const h = C < 1e-9 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { L, C, h };
}

/** OKLCH 색상각 차이(0~180도). */
export function hueGap(x: string, y: string): number {
  const raw = Math.abs(toOklch(x).h - toOklch(y).h) % 360;
  return raw > 180 ? 360 - raw : raw;
}

function oklabToLinear({ L, a, b }: Oklab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(lin: readonly number[]): boolean {
  return lin.every((v) => v >= -1e-6 && v <= 1 + 1e-6);
}

/**
 * OKLCH → `#rrggbb`. sRGB 밖이면 명도와 색상각을 지키고 채도만 줄인다(이분 탐색,
 * 결정적). 보정 엔진이 「명도만 옮긴다」는 약속을 지키려면 명도가 아니라 채도가
 * 양보해야 한다.
 */
export function fromOklch({ L, C, h }: Oklch): string {
  const lightness = Math.max(0, Math.min(1, L));
  const rad = (h * Math.PI) / 180;
  const at = (chroma: number) =>
    oklabToLinear({ L: lightness, a: chroma * Math.cos(rad), b: chroma * Math.sin(rad) });
  let lin = at(C);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    lin = at(lo);
  }
  return toHex(lin.map((v) => gamma(Math.max(0, Math.min(1, v)))) as unknown as Rgb);
}

/** 두 색을 OKLab에서 `t`(0 → `from`, 1 → `to`)만큼 섞는다. */
export function mixOklab(from: string, to: string, t: number): string {
  const p = toOklab(from);
  const q = toOklab(to);
  const mixed = { L: p.L + (q.L - p.L) * t, a: p.a + (q.a - p.a) * t, b: p.b + (q.b - p.b) * t };
  const C = Math.hypot(mixed.a, mixed.b);
  const h = C < 1e-9 ? 0 : ((Math.atan2(mixed.b, mixed.a) * 180) / Math.PI + 360) % 360;
  return fromOklch({ L: mixed.L, C, h });
}

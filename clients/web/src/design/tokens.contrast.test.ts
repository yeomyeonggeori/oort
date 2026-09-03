import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Dawn palette is not "checked by eye". tokens.css is parsed here and every
 * foreground/surface pair is measured with the WCAG 2.1 relative-luminance
 * formula, in BOTH schemes. If someone retunes a hex and drops below AA, this
 * test fails before the pixel ever ships (MOMO-597 / ADR-0133 P1).
 */

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** `--name: light-dark(#aaa, #bbb);` -> { name: [light, dark] } */
export function parseLightDarkTokens(source: string): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  const re =
    /--([a-z-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi;
  for (const m of source.matchAll(re)) out[m[1]] = [m[2], m[3]];
  return out;
}

const TOKENS = parseLightDarkTokens(css);

/**
 * `--scrim` is the one token that is not opaque, so the generic parser above
 * cannot see it and the pairs it produces cannot describe it. It gets its own
 * reader: `light-dark(rgb(r g b / a), rgb(r g b / a))`.
 */
function parseScrim(source: string): [ScrimLayer, ScrimLayer] {
  const rgba = String.raw`rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)`;
  const m = source.match(
    new RegExp(String.raw`--scrim:\s*light-dark\(\s*${rgba}\s*,\s*${rgba}\s*\)`)
  );
  if (!m) throw new Error("--scrim missing from tokens.css, or not light-dark(rgb(...), rgb(...))");
  const layer = (o: number): ScrimLayer => ({
    rgb: [Number(m[o]), Number(m[o + 1]), Number(m[o + 2])],
    alpha: Number(m[o + 3]),
  });
  return [layer(1), layer(5)];
}

interface ScrimLayer {
  rgb: [number, number, number];
  alpha: number;
}

const SCRIM = parseScrim(css);

function channels(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function linearize(hex: string): [number, number, number] {
  return channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  ) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = linearize(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function luminanceRGB([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** What the browser actually paints: source-over alpha blending in sRGB. */
function composite(layer: ScrimLayer, hex: string): [number, number, number] {
  const under = channels(hex).map((c) => c * 255);
  return under.map(
    (c, i) => layer.rgb[i] * layer.alpha + c * (1 - layer.alpha)
  ) as [number, number, number];
}

/** The two OKLab opponent axes. Hue is their angle, chroma their length. */
function oklabAB(hex: string): [number, number] {
  const [r, g, b] = linearize(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab hue angle in degrees, used to police hue families (AI-tell bans). */
export function hueAngle(hex: string): number {
  const [A, B] = oklabAB(hex);
  return (((Math.atan2(B, A) * 180) / Math.PI) + 360) % 360;
}

/**
 * OKLab chroma: how colorful a token is, independent of how light it is.
 *
 * This is the ruler for the risk hierarchy (MOMO-641). Luminance contrast
 * cannot order status tokens once they all clear AA by a wide margin: the dark
 * `--danger` that shipped before this measured 10.55:1 on `--surface` against
 * `--warn`'s 8.03:1 and still read as the quieter of the two, because it was a
 * pale pink (C 0.068) standing next to a saturated yellow (C 0.141). At equal
 * legibility the eye ranks by colorfulness, so that is what is measured here,
 * with the AA table above kept as the floor underneath it.
 */
export function chroma(hex: string): number {
  return Math.hypot(...oklabAB(hex));
}

/** Accent fill must outrank the destructive fill (MOMO-642 R1 H-2). */
export const ACCENT_DANGER_FILL_CHROMA_RATIO_MIN = 1.15;
/** Two fills on one screen stay different colours. */
export const ACCENT_DANGER_FILL_DELTA_E_MIN = 0.08;
export const AGENT_HUE_GAP_MIN = 90;
export const AGENT_DELTA_E_MIN = 0.08;

/** Shortest angular distance between two hues, in degrees. */
export function hueGap(a: string, b: string): number {
  const d = Math.abs(hueAngle(a) - hueAngle(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Perceptual distance in OKLab. Chroma orders two tones; this says whether they
 * are still two tones at all. Quieting the destructive fill (MOMO-642 R1 H-2)
 * moves it TOWARD the accent on the one axis the order is measured on, so the
 * order has to be bought without merging the two fills into one colour.
 */
export function deltaE(a: string, b: string): number {
  const [aA, aB] = oklabAB(a);
  const [bA, bB] = oklabAB(b);
  return Math.hypot(oklabL(a) - oklabL(b), aA - bA, aB - bB);
}

/** OKLab lightness, the third axis deltaE needs. */
function oklabL(hex: string): number {
  const [r, g, b] = linearize(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SCHEMES = [
  { name: "light", index: 0 },
  { name: "dark", index: 1 },
] as const;

/** Surfaces any body text can land on. */
export const SURFACES = [
  "surface",
  "surface-raised",
  "surface-sidebar",
  "surface-hover",
  "accent-soft",
  "agent-soft",
  "muted-soft",
  "ok-soft",
  "warn-soft",
  "danger-soft",
] as const;

/**
 * 어느 그릇이 어느 행 바탕 위에 서는가 — 닫힌 표 (#1515 · #1516).
 *
 * `CONTROL_SURFACES` 와 같은 성질의 표다: 「어디에 설 수 있는가」를 사람의 기억이
 * 아니라 값으로 지킨다. 그리고 **그릇마다 목록이 다르다** — 이 표가 전역 목록
 * 하나였다면 실제로는 만나지 않는 쌍에 바닥을 요구하게 되고, 그 요구를 맞추려고
 * 토큰을 조율하는 것은 화면에 없는 문제를 위해 값을 망치는 일이다.
 *
 *   `muted-soft`  원장의 칩(수명주기·단계 행)이 드는 톤 없는 그릇. 네 표면 전부에
 *                 선다 — 목록·상세의 기본 바탕(`--surface`), 가리킨·펼친 행
 *                 (`--surface-hover`), 선택된 관제 줄(`--accent-soft`), 그리고
 *                 미리보기 패널(`--surface-raised`, 단계 행 칩이 그 위에 선다).
 *   톤 그릇 셋    측정을 나르는 검증 칩이 드는 그릇. 이 칩이 서는 자리는 목록 행
 *                 (`WorkPanel` 의 두 목록)과 상세의 카드뿐이다. **관제 줄에는 이
 *                 칩이 서지 않는다** — #1514 D2 가 그 행의 셋째 줄에 칩이 들어갈
 *                 자리가 없다고 실측하고 되돌린 결정이고, 그래서 `--accent-soft`
 *                 (그 행의 선택 바탕)는 이 셋의 목록에 없다.
 *
 * 칩을 새 표면에 세우면 해당 줄을 늘려야 하고, 그러면 그 표면에서도 그릇이
 * 살아남는지를 아래 단정이 즉시 묻는다. 늘리지 않고 세우면 #1514 H-2 가 다시 조용히
 * 산다 — 그때도 이 파일은 전부 초록이었다. 관제 줄에 검증 칩을 세우는 후속이 온다면
 * `--accent-soft` 를 톤 그릇 줄에 더해야 하고, 라이트 `danger-soft` 가 그 위에서
 * 1.046 이라 **그 순간 이 파일이 빨개진다**. 그것이 이 표의 쓸모다.
 *
 * 그때 값을 조율하는 길이 **없지는 않다** (design-review D1). 브루트포스로 여섯 값이
 * 존재한다 — 예: `#ffeaeb` 은 `--accent-soft` 위에서 1.056 이고 중립 그릇과의 거리도
 * 0.0213 로 바닥을 넘는다. 다만 그 여섯이 전부 `--danger` 의 색상에서 **7.8~14.8도**
 * 떨어져 있고, 색상 가족을 5도로 조이면 해집합이 빈다. 즉 이 조율의 값은 「빨강을
 * 주황 쪽으로 최대 14.5도 밀기」이고, **칩이 서지도 않는 표면 하나를 위해 지불할 값이
 * 아니다.** 지금 1.046 을 그대로 두는 것은 불가능해서가 아니라 그 거래를 거절한
 * 것이다 — 실제로 관제 줄에 칩이 서는 날이 오면 그때 이 문단을 다시 읽고 정하면 된다.
 */
export const CHIP_VESSEL_SURFACES = [
  ["muted-soft", ["surface", "surface-hover", "accent-soft", "surface-raised"]],
  ["ok-soft", ["surface", "surface-hover", "surface-raised"]],
  ["warn-soft", ["surface", "surface-hover", "surface-raised", "accent-soft"]],
  ["danger-soft", ["surface", "surface-hover", "surface-raised"]],
] as const;

/**
 * 그릇이 자기 톤에 매인다 (#1516).
 *
 * 대비와 거리는 「그릇이 보이는가」를 재지만 「**옳은** 그릇인가」는 재지 않는다.
 * `--ok-soft` 를 붉게 칠해도 위 단정은 전부 초록이다 — 그러면 통과한 게이트가 붉은
 * 그릇에 초록 잉크로 서고, 그 조합은 사람이 다시 스크린샷을 뜰 때만 잡힌다.
 * `--danger-fill` 이 위험 색상 가족을 벗어나지 못하게 한 단정과 같은 자다.
 */
const TONE_VESSELS = [
  ["ok-soft", "ok"],
  ["warn-soft", "warn"],
  ["danger-soft", "danger"],
] as const;

/**
 * 나란히 선 두 그릇이 서로 다른 재료여야 하는 바닥.
 *
 * 한 행에 원장의 칩(중립 그릇)과 측정의 칩(톤 그릇)이 함께 선다. 둘이 한 평면
 * (라이트 휘도 .85~.87 · 다크 .028~.029)에 서므로 명도로는 갈리지 않고, 갈리는 축은
 * 색상뿐이다. 실측 최소는 라이트 danger 쌍의 0.0203 이다 — sRGB 에서 이 명도의
 * 빨강이 채도를 다 사지 못해 가장 좁다.
 */
const CHIP_VESSEL_MIN_SIBLING_DISTANCE = 0.02;

/**
 * 그릇이 행 바탕에서 살아남았다고 말할 수 있는 바닥.
 *
 * 두 자를 함께 건다. 대비(1.05)만 걸면 「대비는 넘는데 눈에는 같은 회색」이
 * 통과하고, 거리(0.02)만 걸면 명도가 거의 같은 쌍이 통과한다. 두 값 모두 이
 * 팔레트의 실측에서 나왔다: 라이트 --surface 위가 최악이고 1.061 / 0.0207 이다.
 * 고치기 전 --surface-hover 위의 그 칩은 1.000 / 0.0000 이었다.
 */
export const CHIP_VESSEL_MIN_CONTRAST = 1.05;
export const CHIP_VESSEL_MIN_DISTANCE = 0.02;

/** Foregrounds that render text or meaningful glyphs. */
export const FOREGROUNDS = [
  "ink",
  "ink-muted",
  "accent",
  "agent",
  "danger",
  "ok",
  "warn",
] as const;

/**
 * Surfaces a bordered control (input, `<select>`, outline button) may sit on.
 *
 * The two tinted surfaces are deliberately absent: `--line-strong` lands at
 * 2.90:1 on `--accent-soft` and 2.94:1 on `--agent-soft` in dark, under the 3:1
 * non-text minimum. They carry TEXT, which the 4.5:1 assertion above already
 * covers. The membership test below turns that into a measured fact instead of
 * something a reviewer has to remember: file a surface in the wrong list, or
 * improve a token without moving it, and it fails.
 *
 * 이 산문은 「그리고 아웃라인을 인 것은 아무것도 없다」로 끝났었다. 그 문장이
 * 거짓이 되는 순간을 이 레포가 한 번 겪었다 (design-review #1937 R2 M-1):
 * 사이드바 행의 「메뉴 열림」 표식이 하필 `--accent-soft` 위에 인셋 아웃라인을
 * 세웠고, 고른 색이 `--line-strong` 이었다 — 위 두 숫자가 그 결함의 값이다.
 * 컨트롤 경계 분류는 그대로다(그 표식은 컨트롤이 아니라 일시적 상태 표시다).
 * 대신 그 표식이 자기 바닥 위에서 3:1 을 넘는지를 아래 「행 메뉴 열림 표식」이
 * **컴포넌트의 클래스에서 토큰 이름을 읽어** 잰다. 산문이 지키던 자리를 자가
 * 이어받았다.
 */
export const CONTROL_SURFACES = [
  "surface",
  "surface-raised",
  "surface-sidebar",
  "surface-hover",
] as const;

function pick(token: string, index: 0 | 1): string {
  const pair = TOKENS[token];
  if (!pair) throw new Error(`token --${token} missing from tokens.css`);
  return pair[index];
}

/**
 * 행 메뉴의 「열림」 표식이 서는 **세** 바닥.
 *
 * 인셋 아웃라인 밑에 실제로 깔리는 색이 세 가지다:
 *   · `--surface-hover` — 열린 트리거 자신의 채움(`data-[state=open]:bg-…`).
 *     비활성 행에서는 이것이 바닥이다(실측 `spanBg` / 링크는 투명).
 *   · `--accent-soft` — **지금 열려 있는 채널**의 행. 알파가 없어 위 채움을
 *     덮는다. design-review #1937 R2 M-1 이 잡은 자리다.
 *   · `--surface-sidebar` — 그 둘이 어느 것도 칠해지지 않은 열의 바탕.
 *
 * 세 칸으로 적는 것이 이 가드의 이름값이다: 재는 값이 「실제 바닥」이므로 목록도
 * 실제 바닥이어야 한다 (design-review #1937 R3 N-2).
 */
const ROW_MENU_MARKER_SURFACES = [
  "surface-sidebar",
  "surface-hover",
  "accent-soft",
] as const;

const ROW_MENU_TRIGGER_SOURCE = readFileSync(
  new URL("../features/sidebar/SidebarRowContextMenu.tsx", import.meta.url),
  "utf8"
);

/**
 * 출하되는 클래스 목록에서 표식의 **선 색 토큰 이름**을 읽는다.
 *
 * 이름을 여기 적어 두지 않는 이유가 이 단정의 전부다: 앞 회전은 대비를
 * **주석으로** 주장했고("어느 표면 위에서도 3:1"), 그 주장은 거짓이었으며 반례는
 * 바로 위 `CONTROL_SURFACES` 산문에 소수점까지 적혀 있었다. 사본을 두면 사본이
 * 거짓말하므로, 색을 바꾸면 이 시험이 **새 색을** 재고 표식을 지우면 터진다.
 */
function rowMenuMarkerToken(): string {
  const match = /data-\[state=open\]:outline-([a-z-]+)/.exec(
    ROW_MENU_TRIGGER_SOURCE
  );
  if (!match) {
    throw new Error(
      "행 메뉴 열림 표식의 아웃라인 색을 못 찾았다 — 표식을 지웠거나 클래스 꼴이 바뀌었다"
    );
  }
  return match[1];
}

describe("행 메뉴 열림 표식", () => {
  it("두 겹이다 — 불투명한 활성 행이 배경 한 겹을 덮는다", () => {
    expect(ROW_MENU_TRIGGER_SOURCE).toMatch(
      /data-\[state=open\]:bg-surface-hover/
    );
    expect(ROW_MENU_TRIGGER_SOURCE).toMatch(/data-\[state=open\]:outline\b/);
    expect(ROW_MENU_TRIGGER_SOURCE).toMatch(
      /data-\[state=open\]:-outline-offset-1/
    );
  });

  it("선 색이 세 바닥·두 스킴 전부에서 3:1 을 넘는다", () => {
    const token = rowMenuMarkerToken();
    for (const scheme of SCHEMES) {
      for (const surface of ROW_MENU_MARKER_SURFACES) {
        const ratio = contrast(
          pick(token, scheme.index),
          pick(surface, scheme.index)
        );
        expect(
          Number(ratio.toFixed(2)),
          `--${token} on --${surface} (${scheme.name})`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("앞 회전이 골랐던 --line-strong 은 그 자를 못 넘는다", () => {
    // 반례를 함께 잠근다: 위 단정의 초록이 「자가 헐거워서」일 수 없게.
    const dark = contrast(pick("line-strong", 1), pick("accent-soft", 1));
    expect(Number(dark.toFixed(2))).toBe(2.9);
    expect(rowMenuMarkerToken()).not.toBe("line-strong");
  });

  it("포커스 링과 다른 색·다른 두께다", () => {
    // 포커스 링은 `--accent` 2px 인셋. 표식이 같으면 「캐럿이 여기 있다」와
    // 「이 행의 메뉴가 열려 있다」를 구별할 수 없다.
    expect(rowMenuMarkerToken()).not.toBe("accent");
    expect(ROW_MENU_TRIGGER_SOURCE).toMatch(/data-\[state=open\]:outline-1\b/);
  });
});

/**
 * 드롭 표지가 서는 두 바닥 (BT-5 / #1933).
 *
 * 표식은 두 겹이다 — 자기 채움(`--surface-hover`)과 그 위의 아웃라인. 아웃라인
 * 밑에 실제로 깔리는 색은 그 채움이고, 채움이 칠해지기 전 한 프레임의 바닥은 열
 * 자체(`--surface-sidebar`)다. 위 「행 메뉴 열림 표식」과 같은 규율로, 색 이름은
 * 여기 적지 않고 **출하되는 클래스에서 읽어** 잰다.
 */
const DROP_TARGET_SURFACES = ["surface-sidebar", "surface-hover"] as const;

const SECTION_SOURCE = readFileSync(
  new URL("../features/sidebar/SidebarRow.tsx", import.meta.url),
  "utf8"
);
const FOCUS_RING_SOURCE = readFileSync(
  new URL("./tokens.css", import.meta.url),
  "utf8"
);

/** `outline-<낱말>` 중 색이 아닌 것들. 꼴(파선)은 위 단정이 따로 잰다. */
const OUTLINE_STYLE_WORDS = new Set([
  "dashed",
  "solid",
  "dotted",
  "double",
  "none",
  "hidden",
  "offset",
]);

function dropTargetToken(): string {
  const found = [
    ...SECTION_SOURCE.matchAll(/data-\[drop-target\]:outline-([a-z-]+)/g),
  ]
    .map((match) => match[1])
    .filter((word) => !OUTLINE_STYLE_WORDS.has(word));
  if (found.length !== 1) {
    throw new Error(
      `드롭 표지의 아웃라인 색을 하나로 못 읽었다: ${JSON.stringify(found)}`
    );
  }
  return found[0];
}

describe("드롭 표지", () => {
  it("색이 아니라 꼴로 포커스 링과 갈린다", () => {
    // 링은 실선 2px `--accent` 이고 배경을 건드리지 않는다. 표식은 같은 색을
    // 쓰되 **파선**이고 채움이 함께 바뀐다 - 드래그 중인 프레임에는 캐럿이 든
    // 행과 받는 섹션이 한 화면에 함께 선다(실캡처).
    expect(SECTION_SOURCE).toMatch(/data-\[drop-target\]:bg-surface-hover/);
    expect(SECTION_SOURCE).toMatch(/data-\[drop-target\]:outline\b/);
    expect(SECTION_SOURCE).toMatch(/data-\[drop-target\]:outline-dashed/);
    expect(SECTION_SOURCE).toMatch(/data-\[drop-target\]:-outline-offset-2/);
    // 링 쪽은 파선이 아니다 - 두 표식이 한 꼴로 수렴하는 날 여기서 터진다.
    expect(FOCUS_RING_SOURCE).not.toMatch(/outline-style:\s*dashed/);
  });

  it("선 색이 두 바닥·두 스킴 전부에서 3:1 을 넘는다", () => {
    const token = dropTargetToken();
    for (const scheme of SCHEMES) {
      for (const surface of DROP_TARGET_SURFACES) {
        const ratio = contrast(
          pick(token, scheme.index),
          pick(surface, scheme.index)
        );
        expect(
          Number(ratio.toFixed(2)),
          `--${token} on --${surface} (${scheme.name})`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("Dawn palette", () => {
  it("declares every semantic token exactly once, as light-dark()", () => {
    const expected = [
      ...SURFACES,
      ...FOREGROUNDS,
      "line",
      "line-strong",
      "on-accent",
      "danger-fill",
      "on-danger-fill",
    ];
    for (const token of expected) expect(TOKENS[token], token).toBeDefined();
  });

  it("uses no pure black or pure white (warm paper instead)", () => {
    for (const [token, pair] of Object.entries(TOKENS)) {
      for (const hex of pair) {
        expect(hex.toLowerCase(), `${token} -> ${hex}`).not.toBe("#ffffff");
        expect(hex.toLowerCase(), `${token} -> ${hex}`).not.toBe("#000000");
      }
    }
    // The scrim is the one place a lazy pure black would be tempting.
    for (const layer of SCRIM) {
      expect(layer.rgb.join(","), "scrim tint").not.toBe("0,0,0");
      expect(layer.rgb.join(","), "scrim tint").not.toBe("255,255,255");
    }
  });

  // Which surfaces may carry a bordered control is a MEASUREMENT, not a habit.
  // A composition invented in a feature (the composer's routing line painted
  // itself --accent-soft and put a --line-strong `<select>` on top) was invisible
  // to this file because --accent-soft was simply not in the control table. So
  // the table is now closed: every surface is classified, and its class must
  // agree with the numbers in BOTH schemes.
  it("classifies every surface by whether a bordered control may sit on it", () => {
    for (const bg of SURFACES) {
      const passes = SCHEMES.every(
        (scheme) =>
          contrast(pick("line-strong", scheme.index), pick(bg, scheme.index)) >= 3
      );
      expect(
        passes,
        `--line-strong on ${bg}: ${SCHEMES.map(
          (scheme) =>
            `${scheme.name} ${contrast(
              pick("line-strong", scheme.index),
              pick(bg, scheme.index)
            ).toFixed(2)}`
        ).join(", ")}`
      ).toBe((CONTROL_SURFACES as readonly string[]).includes(bg));
    }
  });

  for (const scheme of SCHEMES) {
    describe(scheme.name, () => {
      it("text tokens meet WCAG AA (4.5:1) on every surface", () => {
        for (const fg of FOREGROUNDS) {
          for (const bg of SURFACES) {
            const ratio = contrast(
              pick(fg, scheme.index),
              pick(bg, scheme.index)
            );
            expect(
              Number(ratio.toFixed(2)),
              `${fg} on ${bg} (${scheme.name})`
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it("filled accent and destructive fill carry AA label text", () => {
        expect(
          contrast(pick("on-accent", scheme.index), pick("accent", scheme.index))
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(
            pick("on-danger-fill", scheme.index),
            pick("danger-fill", scheme.index)
          )
        ).toBeGreaterThanOrEqual(4.5);
      });

      it("control borders meet the 3:1 non-text minimum", () => {
        for (const bg of CONTROL_SURFACES) {
          const ratio = contrast(
            pick("line-strong", scheme.index),
            pick(bg, scheme.index)
          );
          expect(
            Number(ratio.toFixed(2)),
            `line-strong on ${bg} (${scheme.name})`
          ).toBeGreaterThanOrEqual(3);
        }
      });

      // 위 단정의 **반쪽**이었다 (#1211 D3). `--line-strong` 이 3:1 을 넘는다는 것은
      // 「강한 선을 쓰면 된다」를 말할 뿐, 「약한 선을 쓰면 안 된다」를 말하지 않는다.
      // 그 둘째 문장이 tokens.css:33 이 선언한 규칙의 실제 내용이고(*"--line
      // separates, --line-strong outlines controls (3:1)"*), 그것이 값으로 참인지는
      // 지금까지 아무 데서도 재지 않았다. 실측 최대는 다크 --surface 위 1.43:1 이다.
      //
      // 이 단정이 없으면 `designSystem.test.ts` 의 컨트롤 프리미티브 규칙이 근거를
      // 잃는다: 「`border-line` 은 컨트롤 경계가 될 수 없다」의 이유가 바로 이 수다.
      it("the separating line never reaches the 3:1 control minimum", () => {
        for (const bg of CONTROL_SURFACES) {
          const ratio = contrast(pick("line", scheme.index), pick(bg, scheme.index));
          expect(
            Number(ratio.toFixed(2)),
            `line on ${bg} (${scheme.name})`
          ).toBeLessThan(3);
        }
      });

      // 파괴 액션의 윤곽은 비파괴 컨트롤의 윤곽보다 **진하다** (#1211 D3).
      //
      // dark1155 M1 이 증명한 실패 양식을 값이 아니라 관계로 닫는다: 비파괴 컨트롤
      // 하나의 경계를 3:1 로 올리는 수리가, 그 옆의 파괴 형제를 화면에서 가장 흐린
      // 선으로 만들었다. 그때 각 값은 개별적으로 옳았고 이 파일의 단정은 전부
      // 초록이었다 — 위계는 어느 한 값의 성질이 아니라 **두 값 사이의 순서**이기
      // 때문이다.
      //
      // 실측(라이트/다크, --surface 위): danger 6.05/7.03 대 line-strong 3.59/3.56.
      it("outlines a destructive control louder than a neutral one", () => {
        for (const bg of CONTROL_SURFACES) {
          const destructive = contrast(pick("danger", scheme.index), pick(bg, scheme.index));
          const neutral = contrast(pick("line-strong", scheme.index), pick(bg, scheme.index));
          expect(
            [bg, destructive > neutral],
            `danger ${destructive.toFixed(2)} vs line-strong ${neutral.toFixed(
              2
            )} on ${bg} (${scheme.name})`
          ).toEqual([bg, true]);
        }
      });

      // The scrim is a direction, not a color: whatever it covers must end up
      // darker, in BOTH schemes. Painting it with --ink passed review by eye in
      // light and inverted in dark (--ink is nearly white there), which is the
      // regression these two assertions exist to make impossible (MOMO-614 R1).
      it("darkens every surface it covers", () => {
        const layer = SCRIM[scheme.index];
        for (const bg of SURFACES) {
          const hex = pick(bg, scheme.index);
          const over = luminanceRGB(composite(layer, hex));
          expect(
            Number(over.toFixed(4)),
            `scrim over ${bg} (${scheme.name})`
          ).toBeLessThanOrEqual(luminance(hex) * 0.7);
        }
      });

      it("leaves the dialog panel brighter than anything it covers", () => {
        const layer = SCRIM[scheme.index];
        const panel = luminance(pick("surface-raised", scheme.index));
        for (const bg of SURFACES) {
          const over = luminanceRGB(composite(layer, pick(bg, scheme.index)));
          expect(
            panel,
            `--surface-raised panel vs scrimmed ${bg} (${scheme.name})`
          ).toBeGreaterThan(over);
        }
      });

      it("separates the agent hue from the human accent hue", () => {
        expect(
          Math.round(
            hueGap(pick("agent", scheme.index), pick("accent", scheme.index))
          ),
          `agent vs accent hue gap (${scheme.name})`
        ).toBeGreaterThanOrEqual(AGENT_HUE_GAP_MIN);
      });

      // The risk hierarchy is an ORDER, not a taste: --danger > --warn >
      // --ink-muted, in both schemes. Five shipping surfaces put two of these
      // tones side by side and would silently invert with the tokens: the app
      // consent dialog and the ToolRow chips under 설정 > 앱, the quota chips
      // and bars under 설정 > 사용량, the AI 연결 체인 status lines, the profile
      // panel's connection bar (warn while connecting, danger while
      // disconnected, and nothing at all while healthy — presence 6b H1), and
      // the presence badge on the same row's avatar (warn = 자리 비움, danger =
      // 방해 금지). Ratios, not bare `>`, so a token that merely ties cannot
      // pass (the old dark danger sat at 0.48x of warn).
      it("ranks danger louder than warn, and warn louder than muted", () => {
        const c = (token: string) => chroma(pick(token, scheme.index));
        expect(
          Number((c("danger") / c("warn")).toFixed(2)),
          `danger vs warn chroma (${scheme.name})`
        ).toBeGreaterThanOrEqual(1.15);
        expect(
          Number((c("warn") / c("ink-muted")).toFixed(2)),
          `warn vs ink-muted chroma (${scheme.name})`
        ).toBeGreaterThanOrEqual(2);
      });

      // The SECOND surface class the chroma ruler governs: action FILLS.
      //
      // The ruler above orders risk tones against each other. It said nothing
      // about the surfaces where --danger was painted as a fill, so the ruler
      // stepped straight over `<Button variant="destructive">` and by its own
      // measurement the destructive secondary outranked the primary action:
      // 설치 해제 (C 0.178 light / 0.166 dark) stood beside 내 사용 허용 (0.136 /
      // 0.134) in 설정 > 앱 상세, at 1.31x and 1.24x. One --danger cannot serve
      // both orders — in dark it must clear warn by 1.15x (C >= 0.162) AND stay
      // under accent (C <= 0.116), an empty interval — so the fill has its own
      // token and its own assertion here (MOMO-642 R1 H-2).
      //
      // Ratios again rather than a bare `>`, for the same reason: a tie is not
      // an order. Applies to every destructive fill in the client, since they
      // all come from the one `destructive` variant.
      it("ranks the primary action fill above the destructive fill", () => {
        const c = (token: string) => chroma(pick(token, scheme.index));
        expect(
          Number((c("accent") / c("danger-fill")).toFixed(2)),
          `accent vs danger-fill chroma (${scheme.name})`
        ).toBeGreaterThanOrEqual(ACCENT_DANGER_FILL_CHROMA_RATIO_MIN);
      });

      // Quieter, not merged. Lowering the destructive fill's chroma walks it
      // toward the accent on the very axis the order is read from, so the two
      // fills must stay apart as colours. Measured 0.092 light / 0.131 dark,
      // both WIDER than the 0.073 / 0.122 the two had before the split.
      it("keeps the destructive fill a different colour from the accent fill", () => {
        expect(
          Number(
            deltaE(
              pick("danger-fill", scheme.index),
              pick("accent", scheme.index)
            ).toFixed(3)
          ),
          `danger-fill vs accent deltaE (${scheme.name})`
        ).toBeGreaterThanOrEqual(ACCENT_DANGER_FILL_DELTA_E_MIN);
      });

      // ...and still recognisably the risk colour. A fill allowed to drift out
      // of the --danger hue family would satisfy both assertions above by
      // ceasing to look destructive, which is the cheapest way to pass this
      // file and the worst way to ship. The floor under "quieter" is the same
      // one --warn already stands on: a tone that carries meaning is at least
      // twice as colourful as the quietest foreground.
      it("keeps the destructive fill in the danger hue family", () => {
        expect(
          Math.round(
            hueGap(pick("danger-fill", scheme.index), pick("danger", scheme.index))
          ),
          `danger-fill vs danger hue gap (${scheme.name})`
        ).toBeLessThanOrEqual(15);
        expect(
          Number(
            (
              chroma(pick("danger-fill", scheme.index)) /
              chroma(pick("ink-muted", scheme.index))
            ).toFixed(2)
          ),
          `danger-fill vs ink-muted chroma (${scheme.name})`
        ).toBeGreaterThanOrEqual(2);
      });

      // The floor under that order: chroma may not be bought with legibility.
      // --danger outreads the quietest foreground on every surface it can land
      // on, so a louder red can never also be a dimmer one.
      it("keeps danger above the quietest foreground in contrast too", () => {
        for (const bg of SURFACES) {
          expect(
            contrast(pick("danger", scheme.index), pick(bg, scheme.index)),
            `danger vs ink-muted on ${bg} (${scheme.name})`
          ).toBeGreaterThan(
            contrast(pick("ink-muted", scheme.index), pick(bg, scheme.index))
          );
        }
      });

      // 칩의 그릇은 그 칩이 서는 **어떤 행 바탕과도** 같은 재료가 아니다 (#1515).
      //
      // #1514 H-2 가 실측한 결함은 값 하나가 틀린 것이 아니라 **두 축이 한 값을
      // 나눠 가진 것**이었다: 수명주기 칩의 그릇이 `--surface-hover` 였고 그 토큰은
      // 행이 주목받았다는 **상태**의 이름이라, 상태가 켜지는 순간 그릇이 꺼졌다
      // (대비 1.00). 그래서 여기서 재는 것은 「그릇이 예쁜가」가 아니라 「그릇이
      // 행의 어느 상태에서도 남아 있는가」다 — 행이 입을 수 있는 바탕을 닫힌 표로
      // 두고 전부 돈다.
      //
      // 두 자를 함께 걸어야 하는 이유는 이 팔레트의 라이트가 좁기 때문이다.
      // `--ink-muted` 의 AA 바닥이 휘도 0.769 이고 `--surface-hover` 가 0.7704 라,
      // 칩이 설 수 있는 띠는 [0.769, 0.9911] 하나뿐이고 표면 다섯이 이미 그것을
      // 나눠 갖는다. 그 안에서 얻을 수 있는 최선의 대비가 1.06 이므로, 대비만으로
      // 그릇의 생존을 정의하면 바닥을 1.06 까지 내려야 하고 그 바닥은 「거의 같은
      // 회색」도 통과시킨다. OKLab 거리가 그 자리를 메운다.
      it("keeps a chip vessel distinct from every row background it can stand on", () => {
        for (const [vessel, surfaces] of CHIP_VESSEL_SURFACES) {
          for (const bg of surfaces) {
            const ratio = contrast(pick(vessel, scheme.index), pick(bg, scheme.index));
            const distance = deltaE(
              pick(vessel, scheme.index),
              pick(bg, scheme.index)
            );
            expect(
              Number(ratio.toFixed(3)),
              `${vessel} on ${bg} (${scheme.name}) contrast`
            ).toBeGreaterThanOrEqual(CHIP_VESSEL_MIN_CONTRAST);
            expect(
              Number(distance.toFixed(4)),
              `${vessel} on ${bg} (${scheme.name}) OKLab distance`
            ).toBeGreaterThanOrEqual(CHIP_VESSEL_MIN_DISTANCE);
          }
        }
      });

      // ...and the interaction states keep that token to themselves.
      //
      // 위 단정은 「그릇이 행과 다르다」를 재지만, 다음 사람이 그릇을
      // `--surface-hover` 로 되돌리는 것을 막지는 못한다 — 되돌리면 위 단정이
      // 빨개지긴 하나, 그 실패 메시지는 「대비 1.00」이라 **왜** 안 되는지를 말하지
      // 않는다. 이 단정이 그 이유를 이름으로 적어 둔다: 상호작용 상태를 그리는
      // 토큰은 정적인 그릇이 될 수 없다. 상태는 켜졌다 꺼지고 그릇은 늘 있어야
      // 하므로, 한 값을 나눠 가지면 상태가 켜진 동안 그릇이 반드시 사라진다.
      it("never lets a chip vessel share a value with an interaction state", () => {
        for (const [vessel] of CHIP_VESSEL_SURFACES) {
          for (const state of ["surface-hover", "accent-soft"] as const) {
            expect(
              pick(vessel, scheme.index),
              `${vessel} (${scheme.name}) is the value ${state} paints interaction with`
            ).not.toBe(pick(state, scheme.index));
          }
        }
      });

      // 그릇이 자기 톤의 색상 가족 안에 머문다 (#1516).
      //
      // 위 두 단정을 만족시키는 가장 싼 방법은 「눈에 띄는 아무 색이나」다. 그러면
      // 통과한 게이트가 붉은 그릇에 서고, 대비도 거리도 전부 초록이다. 색상 가족을
      // 걸어 두면 그 통로가 닫힌다 — `--danger-fill` 이 「조용해지는 대신 위험 색을
      // 그만두는」 길로 이 파일을 통과하지 못하게 한 것과 같은 자다.
      it("keeps every tone vessel inside its own tone's hue family", () => {
        for (const [vessel, tone] of TONE_VESSELS) {
          expect(
            Math.round(hueGap(pick(vessel, scheme.index), pick(tone, scheme.index))),
            `${vessel} vs ${tone} hue gap (${scheme.name})`
          ).toBeLessThanOrEqual(15);
        }
      });

      // 그리고 한 행에 나란히 서는 두 그릇은 서로 다른 재료다 (#1516).
      //
      // 원장의 칩(중립 그릇)과 측정의 칩(톤 그릇)이 같은 행에 선다. 네 그릇이 한
      // 평면에 있으므로 명도로는 갈리지 않고, 갈리는 축은 색상뿐이다. 그 갈림이
      // 없으면 #1463 M2 가 지적한 「같은 모양 알약 둘」이 그릇에서 되살아난다.
      it("keeps the toneless vessel a different material from every tone vessel", () => {
        for (const [vessel] of TONE_VESSELS) {
          expect(
            Number(
              deltaE(
                pick(vessel, scheme.index),
                pick("muted-soft", scheme.index)
              ).toFixed(4)
            ),
            `${vessel} vs muted-soft OKLab distance (${scheme.name})`
          ).toBeGreaterThanOrEqual(CHIP_VESSEL_MIN_SIBLING_DISTANCE);
        }
      });

      it("keeps accent and agent out of the indigo/violet AI-tell band", () => {
        for (const token of ["accent", "agent"] as const) {
          const hue = hueAngle(pick(token, scheme.index));
          expect(
            hue > 265 && hue < 330,
            `${token} hue ${hue.toFixed(0)} (${scheme.name}) sits in the indigo/violet band`
          ).toBe(false);
        }
      });
    });
  }
});

/** `--onboarding-name: #hex;` — S0 single-look tokens, no light-dark pair. */
function parseOnboardingTokens(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /--(onboarding-[a-z-]+):\s*(#[0-9a-f]{6});/gi;
  for (const m of source.matchAll(re)) out[m[1]] = m[2];
  return out;
}

const ONBOARDING = parseOnboardingTokens(css);

describe("onboarding S0 palette (single look)", () => {
  it("declares the S0 tokens as one hex each", () => {
    for (const name of [
      "onboarding-space",
      "onboarding-star",
      "onboarding-ink",
      "onboarding-ink-faint",
      "onboarding-accent",
      "onboarding-on-accent",
      "onboarding-line",
    ]) {
      expect(ONBOARDING[name], name).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("uses no pure black or pure white", () => {
    for (const [name, hex] of Object.entries(ONBOARDING)) {
      expect(hex.toLowerCase(), name).not.toBe("#ffffff");
      expect(hex.toLowerCase(), name).not.toBe("#000000");
    }
  });

  it("keeps body copy and the accent readable on the space field", () => {
    expect(
      contrast(ONBOARDING["onboarding-ink"], ONBOARDING["onboarding-space"])
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(ONBOARDING["onboarding-accent"], ONBOARDING["onboarding-space"])
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(
        ONBOARDING["onboarding-on-accent"],
        ONBOARDING["onboarding-accent"]
      )
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the S0 control outline at 3:1 on the space field", () => {
    expect(
      contrast(ONBOARDING["onboarding-line"], ONBOARDING["onboarding-space"])
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps the S0 accent out of the indigo/violet AI-tell band", () => {
    const hue = hueAngle(ONBOARDING["onboarding-accent"]);
    expect(hue > 265 && hue < 330, `accent hue ${hue.toFixed(0)}`).toBe(false);
  });
});

describe("H-3R checked tool row ring vs fill", () => {
  it("ring ink on accent-soft is ≥ 3:1 both schemes; on-fill pairing fails this", () => {
    const tools = readFileSync(
      new URL("../features/agentHub/EnabledToolsSection.tsx", import.meta.url),
      "utf8"
    );
    const usesOnFill = /bg-accent-soft[\s\S]{0,500}focus-ring-on-fill/.test(
      tools
    );
    for (const scheme of SCHEMES) {
      const ring = pick(usesOnFill ? "on-accent" : "accent", scheme.index);
      const fill = pick("accent-soft", scheme.index);
      expect(
        contrast(ring, fill),
        `${usesOnFill ? "on-accent" : "accent"} on accent-soft (${scheme.name})`
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("N-11 vessel table ownership", () => {
  it("muted-soft on accent-soft is not re-measured in a second UX-R4a describe", () => {
    const src = readFileSync(new URL("./tokens.contrast.test.ts", import.meta.url), "utf8");
    const banned =
      "describe(" + '"UX-R4a ' + 'tool chip vessel on selected row"';
    expect(src.includes(banned)).toBe(false);
    const muted = CHIP_VESSEL_SURFACES.find(([name]) => name === "muted-soft");
    expect(muted?.[1]).toContain("accent-soft");
  });
});

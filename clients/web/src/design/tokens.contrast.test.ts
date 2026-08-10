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
function parseLightDarkTokens(source: string): Record<string, [string, string]> {
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

/** Shortest angular distance between two hues, in degrees. */
function hueGap(a: string, b: string): number {
  const d = Math.abs(hueAngle(a) - hueAngle(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Perceptual distance in OKLab. Chroma orders two tones; this says whether they
 * are still two tones at all. Quieting the destructive fill (MOMO-642 R1 H-2)
 * moves it TOWARD the accent on the one axis the order is measured on, so the
 * order has to be bought without merging the two fills into one colour.
 */
function deltaE(a: string, b: string): number {
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
const SURFACES = [
  "surface",
  "surface-raised",
  "surface-sidebar",
  "surface-hover",
  "accent-soft",
  "agent-soft",
] as const;

/** Foregrounds that render text or meaningful glyphs. */
const FOREGROUNDS = [
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
 * covers, and nothing with an outline. The membership test below turns that into
 * a measured fact instead of something a reviewer has to remember: file a
 * surface in the wrong list, or improve a token without moving it, and it fails.
 */
const CONTROL_SURFACES = [
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
        ).toBeGreaterThanOrEqual(90);
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
        ).toBeGreaterThanOrEqual(1.15);
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
        ).toBeGreaterThanOrEqual(0.08);
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

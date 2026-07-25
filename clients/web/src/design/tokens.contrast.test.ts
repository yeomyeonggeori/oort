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

/** OKLab hue angle in degrees, used to police hue families (AI-tell bans). */
export function hueAngle(hex: string): number {
  const [r, g, b] = linearize(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return (((Math.atan2(B, A) * 180) / Math.PI) + 360) % 360;
}

/** Shortest angular distance between two hues, in degrees. */
function hueGap(a: string, b: string): number {
  const d = Math.abs(hueAngle(a) - hueAngle(b)) % 360;
  return d > 180 ? 360 - d : d;
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

/** Surfaces a bordered control (input, outline button) is allowed to sit on. */
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
      "on-danger",
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

      it("filled accent and danger carry AA label text", () => {
        expect(
          contrast(pick("on-accent", scheme.index), pick("accent", scheme.index))
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(pick("on-danger", scheme.index), pick("danger", scheme.index))
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

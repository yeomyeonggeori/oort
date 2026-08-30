import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCENT_THEMES, DEFAULT_ACCENT_ID } from "./index";

function parseLightDarkTokens(source: string): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  const re =
    /--([a-z-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi;
  for (const m of source.matchAll(re)) out[m[1]] = [m[2], m[3]];
  return out;
}

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

function oklabL(hex: string): number {
  const [r, g, b] = linearize(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

function hueAngle(hex: string): number {
  const [A, B] = oklabAB(hex);
  return (((Math.atan2(B, A) * 180) / Math.PI) + 360) % 360;
}

function hueGap(a: string, b: string): number {
  const d = Math.abs(hueAngle(a) - hueAngle(b)) % 360;
  return d > 180 ? 360 - d : d;
}

function deltaE(a: string, b: string): number {
  const [aA, aB] = oklabAB(a);
  const [bA, bB] = oklabAB(b);
  return Math.hypot(oklabL(a) - oklabL(b), aA - bA, aB - bB);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Accent theme bindings are not "checked by eye". Every CSS file in this
 * directory (except swatches.css) is an input: adding a theme without a
 * passing pair fails this file. ADR-0174 D5 — 테마 추가 = 대비 테스트 추가.
 */

const THEME_DIR = fileURLToPath(new URL(".", import.meta.url));
const TOKENS_CSS = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const DAWN = parseLightDarkTokens(TOKENS_CSS);

const BINDING_TOKENS = ["accent", "accent-soft", "on-accent"] as const;

const SCHEMES = [
  { name: "light", index: 0 as const },
  { name: "dark", index: 1 as const },
];

const SURFACES = [
  "surface",
  "surface-raised",
  "surface-sidebar",
  "surface-hover",
  "agent-soft",
  "muted-soft",
  "ok-soft",
  "warn-soft",
  "danger-soft",
] as const;

const CONTROL_SURFACES = [
  "surface",
  "surface-raised",
  "surface-sidebar",
  "surface-hover",
] as const;

const TEXT_ON_SOFT = ["ink", "ink-muted", "accent"] as const;

const BLUE_HUE_MIN = 185;
const BLUE_HUE_MAX = 265;
const INDIGO_HUE_MIN = 265;
const INDIGO_HUE_MAX = 330;
const AGENT_HUE_GAP = 90;
const AGENT_DELTA_E = 0.08;

type Pair = [string, string];

export type AccentBinding = {
  accent: Pair;
  "accent-soft": Pair;
  "on-accent": Pair;
};

function themeCssFiles(): string[] {
  return readdirSync(THEME_DIR)
    .filter((name) => name.endsWith(".css") && name !== "swatches.css")
    .sort();
}

function loadBinding(source: string): AccentBinding {
  const parsed = parseLightDarkTokens(source);
  for (const name of BINDING_TOKENS) {
    if (!parsed[name]) {
      throw new Error(`theme binding missing --${name}`);
    }
  }
  const extra = Object.keys(parsed).filter(
    (name) => !BINDING_TOKENS.includes(name as (typeof BINDING_TOKENS)[number])
  );
  if (extra.length > 0) {
    throw new Error(`theme binding rebinds extra tokens: ${extra.join(", ")}`);
  }
  return {
    accent: parsed.accent,
    "accent-soft": parsed["accent-soft"],
    "on-accent": parsed["on-accent"],
  };
}

function pickDawn(token: string, index: 0 | 1): string {
  const pair = DAWN[token];
  if (!pair) throw new Error(`--${token} missing from tokens.css`);
  return pair[index];
}

function isBlueFamily(hex: string): boolean {
  const hue = hueAngle(hex);
  return (
    (hue >= BLUE_HUE_MIN && hue <= BLUE_HUE_MAX) ||
    (hue > INDIGO_HUE_MIN && hue < INDIGO_HUE_MAX)
  );
}

export function accentBindingFailures(binding: AccentBinding): string[] {
  const fails: string[] = [];
  for (const scheme of SCHEMES) {
    const accent = binding.accent[scheme.index];
    const soft = binding["accent-soft"][scheme.index];
    const onAccent = binding["on-accent"][scheme.index];
    const agent = pickDawn("agent", scheme.index);
    const label = scheme.name;

    for (const hex of [accent, soft, onAccent]) {
      if (hex.toLowerCase() === "#ffffff" || hex.toLowerCase() === "#000000") {
        fails.push(`${label} ${hex} is pure black or white`);
      }
    }

    for (const bg of SURFACES) {
      const ratio = contrast(accent, pickDawn(bg, scheme.index));
      if (ratio < 4.5) {
        fails.push(
          `${label} accent on ${bg} ${ratio.toFixed(2)} (need 4.5:1 text)`
        );
      }
    }
    const onOwnSoft = contrast(accent, soft);
    if (onOwnSoft < 4.5) {
      fails.push(
        `${label} accent on accent-soft ${onOwnSoft.toFixed(2)} (need 4.5:1 text)`
      );
    }
    for (const bg of CONTROL_SURFACES) {
      const ratio = contrast(accent, pickDawn(bg, scheme.index));
      if (ratio < 3) {
        fails.push(
          `${label} accent on ${bg} ${ratio.toFixed(2)} (need 3:1 control)`
        );
      }
    }
    const fill = contrast(onAccent, accent);
    if (fill < 4.5) {
      fails.push(`${label} on-accent on accent ${fill.toFixed(2)}`);
    }
    for (const fg of TEXT_ON_SOFT) {
      const color = fg === "accent" ? accent : pickDawn(fg, scheme.index);
      const ratio = contrast(color, soft);
      if (ratio < 4.5) {
        fails.push(`${label} ${fg} on accent-soft ${ratio.toFixed(2)}`);
      }
    }

    const gap = hueGap(accent, agent);
    if (gap < AGENT_HUE_GAP) {
      fails.push(`${label} agent hue gap ${gap.toFixed(0)} (need ${AGENT_HUE_GAP})`);
    }
    const distance = deltaE(accent, agent);
    if (distance < AGENT_DELTA_E) {
      fails.push(
        `${label} agent deltaE ${distance.toFixed(3)} (need ${AGENT_DELTA_E})`
      );
    }
    if (isBlueFamily(accent)) {
      fails.push(
        `${label} accent hue ${hueAngle(accent).toFixed(0)} sits in the blue/indigo band`
      );
    }
  }
  return fails;
}

const files = themeCssFiles();
const bindings = files.map((file) => {
  const id = file.replace(/\.css$/, "");
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  return { id, file, source, binding: loadBinding(source) };
});

describe("accent theme catalog", () => {
  it("puts Dawn first, and every CSS stem is a catalog id", () => {
    expect(DEFAULT_ACCENT_ID).toBe("dawn");
    expect(ACCENT_THEMES[0].id).toBe("dawn");
    expect(files).toEqual(
      [...ACCENT_THEMES.map((theme) => `${theme.id}.css`)].sort()
    );
  });

  it("does not rebind onboarding or agent tokens", () => {
    for (const { file, source } of bindings) {
      expect(source, file).not.toMatch(/^\s*--onboarding-/m);
      expect(source, file).not.toMatch(/^\s*--agent/m);
    }
  });

  it("keeps the Dawn file identical to tokens.css", () => {
    const dawn = bindings.find((entry) => entry.id === "dawn");
    expect(dawn).toBeDefined();
    for (const name of BINDING_TOKENS) {
      expect(dawn!.binding[name][0]).toBe(DAWN[name][0]);
      expect(dawn!.binding[name][1]).toBe(DAWN[name][1]);
    }
  });

  it("S0 tokens stay outside data-accent rules", () => {
    expect(TOKENS_CSS).toMatch(/\.onboarding-landing[\s\S]*--accent:/);
    const onboarding = TOKENS_CSS.match(
      /--onboarding-accent:\s*(#[0-9a-f]{6});/i
    );
    expect(onboarding?.[1]).toBeDefined();
  });
});

describe("every accent binding meets AA, control 3:1, and agent distance", () => {
  it("has at least Dawn so the suite is not vacuous", () => {
    expect(bindings.length).toBeGreaterThan(0);
  });

  for (const { id, binding } of bindings) {
    it(`${id} passes the accent contrast table`, () => {
      expect(accentBindingFailures(binding), id).toEqual([]);
    });
  }
});

describe("red proof: a low-contrast binding fails this table", () => {
  it("rejects a pale accent that cannot clear AA on surface", () => {
    const pale: AccentBinding = {
      accent: ["#f4e7d6", "#33261a"],
      "accent-soft": ["#fffefb", "#17161a"],
      "on-accent": ["#fffefb", "#17161a"],
    };
    const fails = accentBindingFailures(pale);
    expect(fails.some((line) => line.includes("4.5"))).toBe(true);
  });
});

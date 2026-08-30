import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCENT_DANGER_FILL_CHROMA_RATIO_MIN,
  ACCENT_DANGER_FILL_DELTA_E_MIN,
  AGENT_DELTA_E_MIN,
  AGENT_HUE_GAP_MIN,
  CHIP_VESSEL_MIN_CONTRAST,
  CHIP_VESSEL_MIN_DISTANCE,
  CHIP_VESSEL_SURFACES,
  CONTROL_SURFACES,
  chroma,
  contrast,
  deltaE,
  FOREGROUNDS,
  hueAngle,
  hueGap,
  parseLightDarkTokens,
  SURFACES,
} from "../tokens.contrast.test";
import {
  ACCENT_ID_CHAR_CLASS,
  ACCENT_ID_RE,
  ACCENT_THEMES,
  DEFAULT_ACCENT_ID,
} from "./index";

/**
 * Accent theme bindings are not "checked by eye". Every CSS file in this
 * directory (except swatches.css) is an input: adding a theme without a
 * passing pair fails this file. ADR-0174 D5 — 테마 추가 = 대비 테스트 추가.
 *
 * Axes are *derived* from tokens.contrast.test.ts: the formulas and the
 * accent-family tables are imported, not rewritten. A binding that rebinds
 * `--accent` / `--accent-soft` inherits every contract those tokens held on
 * `:root`.
 */

const THEME_DIR = fileURLToPath(new URL(".", import.meta.url));
const TOKENS_CSS = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const BOOT = readFileSync(
  new URL("../../../public/theme-boot.js", import.meta.url),
  "utf8"
);
const CAPTURE = readFileSync(
  new URL("../../../scripts/capture-screens.mjs", import.meta.url),
  "utf8"
);
const GATE = readFileSync(
  new URL("../../../gates/gate-theme.mjs", import.meta.url),
  "utf8"
);
const DAWN = parseLightDarkTokens(TOKENS_CSS);

const BINDING_TOKENS = ["accent", "accent-soft", "on-accent"] as const;

const SCHEMES = [
  { name: "light", index: 0 as const },
  { name: "dark", index: 1 as const },
];

const BLUE_HUE_MIN = 185;
const BLUE_HUE_MAX = 265;
const INDIGO_HUE_MIN = 265;
const INDIGO_HUE_MAX = 330;

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

function pickOverlay(
  binding: AccentBinding,
  token: string,
  index: 0 | 1
): string {
  if (token === "accent" || token === "accent-soft" || token === "on-accent") {
    return binding[token][index];
  }
  return pickDawn(token, index);
}

function isBlueFamily(hex: string): boolean {
  const hue = hueAngle(hex);
  return (
    (hue >= BLUE_HUE_MIN && hue <= BLUE_HUE_MAX) ||
    (hue > INDIGO_HUE_MIN && hue < INDIGO_HUE_MAX)
  );
}

const STATUS_DISTANCE_TOKENS = ["ok", "warn", "danger"] as const;

/** Dawn's worst accent↔ok/warn/danger distance. Bindings may not undercut it. */
function statusDistanceFloor(): number {
  const distances = SCHEMES.flatMap((scheme) =>
    STATUS_DISTANCE_TOKENS.map((token) =>
      Number(
        deltaE(pickDawn("accent", scheme.index), pickDawn(token, scheme.index)).toFixed(
          3
        )
      )
    )
  );
  return Math.min(...distances);
}

const STATUS_DELTA_E_FLOOR = statusDistanceFloor();

export function accentBindingFailures(binding: AccentBinding): string[] {
  const fails: string[] = [];
  for (const scheme of SCHEMES) {
    const pick = (token: string) => pickOverlay(binding, token, scheme.index);
    const accent = pick("accent");
    const soft = pick("accent-soft");
    const onAccent = pick("on-accent");
    const label = scheme.name;

    for (const hex of [accent, soft, onAccent]) {
      if (hex.toLowerCase() === "#ffffff" || hex.toLowerCase() === "#000000") {
        fails.push(`${label} ${hex} is pure black or white`);
      }
    }

    for (const fg of FOREGROUNDS) {
      for (const bg of SURFACES) {
        const ratio = contrast(pick(fg), pick(bg));
        if (ratio < 4.5) {
          fails.push(
            `${label} ${fg} on ${bg} ${ratio.toFixed(2)} (need 4.5:1 text)`
          );
        }
      }
    }
    for (const bg of CONTROL_SURFACES) {
      const ratio = contrast(accent, pick(bg));
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

    const fillRatio = Number(
      (chroma(accent) / chroma(pick("danger-fill"))).toFixed(2)
    );
    if (fillRatio < ACCENT_DANGER_FILL_CHROMA_RATIO_MIN) {
      fails.push(
        `${label} accent vs danger-fill chroma ${fillRatio} (need ${ACCENT_DANGER_FILL_CHROMA_RATIO_MIN})`
      );
    }
    const fillDistance = Number(
      deltaE(pick("danger-fill"), accent).toFixed(3)
    );
    if (fillDistance < ACCENT_DANGER_FILL_DELTA_E_MIN) {
      fails.push(
        `${label} danger-fill vs accent deltaE ${fillDistance} (need ${ACCENT_DANGER_FILL_DELTA_E_MIN})`
      );
    }

    const gap = hueGap(accent, pick("agent"));
    if (gap < AGENT_HUE_GAP_MIN) {
      fails.push(`${label} agent hue gap ${gap.toFixed(0)} (need ${AGENT_HUE_GAP_MIN})`);
    }
    const agentDistance = deltaE(accent, pick("agent"));
    if (agentDistance < AGENT_DELTA_E_MIN) {
      fails.push(
        `${label} agent deltaE ${agentDistance.toFixed(3)} (need ${AGENT_DELTA_E_MIN})`
      );
    }
    if (isBlueFamily(accent)) {
      fails.push(
        `${label} accent hue ${hueAngle(accent).toFixed(0)} sits in the blue/indigo band`
      );
    }

    for (const status of STATUS_DISTANCE_TOKENS) {
      const distance = Number(deltaE(accent, pick(status)).toFixed(3));
      if (distance < STATUS_DELTA_E_FLOOR) {
        fails.push(
          `${label} accent vs ${status} deltaE ${distance} (need ${STATUS_DELTA_E_FLOOR})`
        );
      }
    }

    for (const [vessel, surfaces] of CHIP_VESSEL_SURFACES) {
      if (!(surfaces as readonly string[]).includes("accent-soft")) continue;
      const ratio = contrast(pick(vessel), soft);
      const distance = deltaE(pick(vessel), soft);
      if (ratio < CHIP_VESSEL_MIN_CONTRAST) {
        fails.push(
          `${label} ${vessel} on accent-soft contrast ${ratio.toFixed(3)}`
        );
      }
      if (distance < CHIP_VESSEL_MIN_DISTANCE) {
        fails.push(
          `${label} ${vessel} on accent-soft OKLab distance ${distance.toFixed(4)}`
        );
      }
    }
    for (const [vessel] of CHIP_VESSEL_SURFACES) {
      if (pick(vessel) === soft) {
        fails.push(
          `${label} ${vessel} is the value accent-soft paints interaction with`
        );
      }
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

  it("uses one accent id character class in the catalog, boot, capture, and theme gate", () => {
    for (const theme of ACCENT_THEMES) {
      expect(theme.id).toMatch(ACCENT_ID_RE);
    }
    expect(BOOT).toContain(`/^[${ACCENT_ID_CHAR_CLASS}]+$/`);
    expect(CAPTURE).toContain(`id: "([${ACCENT_ID_CHAR_CLASS}]+)"`);
    expect(GATE).toContain("ACCENT_ID_CHAR_CLASS");
    expect(GATE).toContain('id: "([${ACCENT_ID_CHAR_CLASS}]+)"');
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

describe("every accent binding meets the accent-family table", () => {
  it("has at least Dawn so the suite is not vacuous", () => {
    expect(bindings.length).toBeGreaterThan(0);
  });

  for (const { id, binding } of bindings) {
    it(`${id} passes the accent contrast table`, () => {
      expect(accentBindingFailures(binding), id).toEqual([]);
    });
  }

  it("keeps swatch neighbours a different colour", () => {
    for (const scheme of SCHEMES) {
      for (let i = 0; i < bindings.length; i += 1) {
        for (let j = i + 1; j < bindings.length; j += 1) {
          const distance = Number(
            deltaE(
              bindings[i].binding.accent[scheme.index],
              bindings[j].binding.accent[scheme.index]
            ).toFixed(3)
          );
          expect(
            distance,
            `${bindings[i].id} vs ${bindings[j].id} ${scheme.name}`
          ).toBeGreaterThanOrEqual(ACCENT_DANGER_FILL_DELTA_E_MIN);
        }
      }
    }
  });
});

describe("red proof: a failing binding fails this table", () => {
  it("rejects a pale accent that cannot clear AA on surface", () => {
    const pale: AccentBinding = {
      accent: ["#f4e7d6", "#33261a"],
      "accent-soft": ["#fffefb", "#17161a"],
      "on-accent": ["#fffefb", "#17161a"],
    };
    const fails = accentBindingFailures(pale);
    expect(fails.some((line) => line.includes("4.5"))).toBe(true);
  });

  it("rejects a desaturated fill that loses the accent > danger-fill order", () => {
    const quiet: AccentBinding = {
      accent: ["#884c00", "#e8904c"],
      "accent-soft": ["#f6e6d8", "#342721"],
      "on-accent": ["#fffefb", "#17161a"],
    };
    const fails = accentBindingFailures(quiet);
    expect(
      fails.some((line) => line.includes("accent vs danger-fill chroma"))
    ).toBe(true);
  });

  it("rejects an accent that sits on the agent or in the indigo band", () => {
    const agent: AccentBinding = {
      accent: ["#4a6785", "#7fa0c4"],
      "accent-soft": ["#e6ebf2", "#1e2836"],
      "on-accent": ["#fffefb", "#17161a"],
    };
    const agentFails = accentBindingFailures(agent);
    expect(
      agentFails.some(
        (line) => line.includes("agent hue gap") || line.includes("agent deltaE")
      )
    ).toBe(true);

    const indigo: AccentBinding = {
      accent: ["#6b3fa0", "#c49ae8"],
      "accent-soft": ["#eee6f4", "#2c2434"],
      "on-accent": ["#fffefb", "#17161a"],
    };
    const indigoFails = accentBindingFailures(indigo);
    expect(
      indigoFails.some((line) => line.includes("blue/indigo band"))
    ).toBe(true);
  });

  it("rejects an accent that collides with ok or warn worse than Dawn", () => {
    const okTwin: AccentBinding = {
      accent: ["#187533", "#57ab5a"],
      "accent-soft": ["#e0f4e2", "#243323"],
      "on-accent": ["#fffefb", "#17161a"],
    };
    const fails = accentBindingFailures(okTwin);
    expect(fails.some((line) => line.includes("accent vs ok deltaE"))).toBe(
      true
    );
  });

  it("rejects an accent that collides with danger worse than Dawn", () => {
    const dangerTwin: AccentBinding = {
      accent: ["#ae083e", "#fe6600"],
      "accent-soft": ["#f6e0e2", "#3a1c12"],
      "on-accent": ["#fffefb", "#17161a"],
    };
    const fails = accentBindingFailures(dangerTwin);
    expect(fails.some((line) => line.includes("accent vs danger deltaE"))).toBe(
      true
    );
  });

  it("rejects two swatch neighbours that share a colour", () => {
    expect(
      Number(deltaE("#a54c08", "#884c00").toFixed(3))
    ).toBeLessThan(ACCENT_DANGER_FILL_DELTA_E_MIN);
  });

  it("rejects an accent-soft that swallows the muted-soft vessel", () => {
    const merged: AccentBinding = {
      accent: ["#a54c08", "#f0a850"],
      "accent-soft": ["#f3efe8", "#302e36"],
      "on-accent": ["#fffefb", "#17161a"],
    };
    const fails = accentBindingFailures(merged);
    expect(
      fails.some(
        (line) =>
          line.includes("muted-soft on accent-soft") ||
          line.includes("muted-soft is the value accent-soft")
      )
    ).toBe(true);
  });
});

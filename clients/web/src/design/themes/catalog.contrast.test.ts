import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePreset, type SignalPresetId } from "@momo/core/design/signal";
import { SIGNAL_MIN_DISTANCE, THEMES } from "@momo/core/design/themes";
import {
  CHIP_VESSEL_MIN_CONTRAST,
  CHIP_VESSEL_MIN_DISTANCE,
  CHIP_VESSEL_SURFACES,
  CONTROL_SURFACES,
  contrast,
  deltaE,
  hueAngle,
  hueGap,
  parseLightDarkTokens,
} from "../tokens.contrast.test";
import {
  ACCENT_ID_CHAR_CLASS,
  ACCENT_ID_RE,
  ACCENT_THEMES,
  DEFAULT_ACCENT_ID,
} from "./index";

/**
 * Accent bindings are not "checked by eye". Every CSS file in this directory
 * (except swatches.css) is an input: adding a binding without a passing table
 * fails this file. ADR-0174 D5 — 테마 추가 = 대비 테스트 추가.
 *
 * DS2-1 (#2713, ADR-0189 D3·D6): 액센트 id 는 신호 프리셋으로 옮겨 가는 중이다.
 * 바인딩은 이제 `--accent` 셋이 아니라 신호 네 값(`--signal`·`--on-signal`·
 * `--signal-text`·`--signal-soft`)을 다시 묶는다. 값의 원천은 core 다 —
 * dawn 은 새벽하늘의 테마 기본 신호, 나머지 넷은 `resolvePreset(id, "dawnsky")`.
 * 이 파일은 ① 파일이 core 와 한 칸씩 같은지 ② 그 값이 웹의 자(tokens.contrast 의
 * 표)를 넘는지 ③ 목록·부트·캡처·게이트가 같은 id 문법을 쓰는지를 잰다.
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
const ROOT = parseLightDarkTokens(TOKENS_CSS);

const BINDING_TOKENS = ["signal", "on-signal", "signal-text", "signal-soft"] as const;
type BindingToken = (typeof BINDING_TOKENS)[number];

const SCHEMES = [
  { name: "light", mode: "light" as const, index: 0 as const },
  { name: "dark", mode: "dark" as const, index: 1 as const },
];

/** 「네온 AI 보라」 금지(ADR-0189 D2 유지). 신호가 이 색상 띠에 서면 안 된다. */
const INDIGO_HUE_MIN = 265;
const INDIGO_HUE_MAX = 330;

/** 같은 id 의 라이트·다크가 같은 색 가족이다. 앞 판 여명의 실측 최대 19.8° 를 올림. */
const SCHEME_HUE_DRIFT_MAX_DEG = 20;

type Pair = [string, string];
export type SignalBinding = Record<BindingToken, Pair>;

function themeCssFiles(): string[] {
  return readdirSync(THEME_DIR)
    .filter((name) => name.endsWith(".css") && name !== "swatches.css")
    .sort();
}

function loadBinding(source: string): SignalBinding {
  const parsed = parseLightDarkTokens(source);
  for (const name of BINDING_TOKENS) {
    if (!parsed[name]) throw new Error(`theme binding missing --${name}`);
  }
  const extra = Object.keys(parsed).filter(
    (name) => !(BINDING_TOKENS as readonly string[]).includes(name)
  );
  if (extra.length > 0) {
    throw new Error(`theme binding rebinds extra tokens: ${extra.join(", ")}`);
  }
  return Object.fromEntries(BINDING_TOKENS.map((t) => [t, parsed[t]])) as SignalBinding;
}

function pickRoot(token: string, index: 0 | 1): string {
  const pair = ROOT[token];
  if (!pair) throw new Error(`--${token} missing from tokens.css`);
  return pair[index];
}

/** 신호 네 값이 선 면: 비텍스트 3:1 을 지는 신호 점·배지·링이 설 수 있는 모든 면. */
const SIGNAL_HOSTS = CONTROL_SURFACES;
/** 신호 글자가 서는 면. core 가 표면·시트·바닥에서 보장하고, 웹은 행 상태를 더한다. */
const SIGNAL_TEXT_HOSTS = [
  "surface",
  "surface-muted",
  "sheet",
  "pane",
  "canvas-top",
  "canvas-mid",
  "canvas-bottom",
  "surface-hover",
  "muted-soft",
] as const;

export function signalBindingFailures(binding: SignalBinding): string[] {
  const fails: string[] = [];
  const drift = hueGap(binding.signal[0], binding.signal[1]);
  if (drift > SCHEME_HUE_DRIFT_MAX_DEG) {
    fails.push(`light↔dark hue drift ${drift.toFixed(1)} (need ≤ ${SCHEME_HUE_DRIFT_MAX_DEG})`);
  }
  for (const scheme of SCHEMES) {
    const pick = (token: string) =>
      (BINDING_TOKENS as readonly string[]).includes(token)
        ? binding[token as BindingToken][scheme.index]
        : pickRoot(token, scheme.index);
    const label = scheme.name;
    const signal = pick("signal");
    const soft = pick("signal-soft");

    for (const token of BINDING_TOKENS) {
      const hex = pick(token).toLowerCase();
      if (hex === "#ffffff" || hex === "#000000") fails.push(`${label} --${token} ${hex} is pure black or white`);
    }
    for (const bg of SIGNAL_HOSTS) {
      const ratio = contrast(signal, pick(bg));
      if (ratio < 3) fails.push(`${label} signal on ${bg} ${ratio.toFixed(2)} (need 3:1 non-text)`);
    }
    for (const bg of [...SIGNAL_TEXT_HOSTS, "signal-soft"]) {
      const ratio = contrast(pick("signal-text"), pick(bg));
      if (ratio < 4.5) fails.push(`${label} signal-text on ${bg} ${ratio.toFixed(2)} (need 4.5:1 text)`);
    }
    for (const fg of ["ink", "ink-muted"]) {
      const ratio = contrast(pick(fg), soft);
      if (ratio < 4.5) fails.push(`${label} ${fg} on signal-soft ${ratio.toFixed(2)} (need 4.5:1 text)`);
    }
    const label45 = contrast(pick("on-signal"), signal);
    if (label45 < 4.5) fails.push(`${label} on-signal on signal ${label45.toFixed(2)} (need 4.5:1)`);

    for (const other of ["agent", "danger", "danger-fill"]) {
      const distance = Number(deltaE(signal, pick(other)).toFixed(3));
      if (distance < SIGNAL_MIN_DISTANCE) {
        fails.push(`${label} signal vs ${other} deltaE ${distance} (need ${SIGNAL_MIN_DISTANCE})`);
      }
    }
    const hue = hueAngle(signal);
    if (hue > INDIGO_HUE_MIN && hue < INDIGO_HUE_MAX) {
      fails.push(`${label} signal hue ${hue.toFixed(0)} sits in the indigo band`);
    }

    // `--accent-soft`(=--signal-soft)는 선택된 행의 바탕이고, 원장의 칩이 그 위에 선다.
    for (const [vessel, surfaces] of CHIP_VESSEL_SURFACES) {
      if (!(surfaces as readonly string[]).includes("accent-soft")) continue;
      const ratio = Number(contrast(pick(vessel), soft).toFixed(3));
      const distance = Number(deltaE(pick(vessel), soft).toFixed(4));
      if (ratio < CHIP_VESSEL_MIN_CONTRAST) {
        fails.push(`${label} ${vessel} on signal-soft contrast ${ratio.toFixed(3)}`);
      }
      if (distance < CHIP_VESSEL_MIN_DISTANCE) {
        fails.push(`${label} ${vessel} on signal-soft OKLab distance ${distance.toFixed(4)}`);
      }
    }
  }
  return fails;
}

/** core 가 이 id 에 주는 새벽하늘 값. dawn 은 테마 기본 신호(`signal: null`)다. */
function coreBinding(id: string): SignalBinding {
  const pairFor = (token: BindingToken): Pair =>
    SCHEMES.map((scheme) => {
      if (id === DEFAULT_ACCENT_ID) return THEMES.dawnsky[scheme.mode].color[token];
      const resolved = resolvePreset(id as SignalPresetId, "dawnsky", scheme.mode);
      if (!resolved.ok) throw new Error(`core rejects preset ${id} on dawnsky ${scheme.mode}`);
      return resolved.values[token];
    }).map((hex) => hex.toLowerCase()) as Pair;
  return Object.fromEntries(BINDING_TOKENS.map((t) => [t, pairFor(t)])) as SignalBinding;
}

/**
 * core 프리셋 엔진이 아직 재지 않는 쌍 — 잔량 (#2737).
 *
 * `resolvePreset` 은 신호를 표면·시트·바닥·띠 위에서 보정하지만, 웹의 칩 그릇
 * (`--muted-soft`)과 만나는 두 쌍은 모른다: 선택된 행(`--signal-soft`) 위 원장 칩,
 * 그리고 원장 칩 그릇 위 신호 글자(orphaned). 프리셋은 사람이 고를 때만 켜지고
 * (기본 신호는 전부 통과), 엔진 수리는 core 의 일이라 #2737 에 넘겼다. 목록은
 * 줄어들기만 한다: 한 줄이 통과하기 시작하면 아래 단정이 그 줄을 지우라고 한다.
 */
const PRESET_RESIDUE: Readonly<Record<string, readonly string[]>> = {
  hongyeom: ["light muted-soft on signal-soft contrast 1.010"],
  seongun: ["light signal-text on muted-soft 4.38 (need 4.5:1 text)"],
};

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
    expect(files).toEqual([...ACCENT_THEMES.map((theme) => `${theme.id}.css`)].sort());
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

  it("does not rebind onboarding, agent, or the primary action", () => {
    for (const { file, source } of bindings) {
      expect(source, file).not.toMatch(/^\s*--onboarding-/m);
      expect(source, file).not.toMatch(/^\s*--agent/m);
      // ADR-0189 D3: 커스텀·프리셋은 주 버튼을 칠하지 않는다.
      expect(source, file).not.toMatch(/^\s*--(?:on-)?primary/m);
    }
  });

  it("scopes each binding to the Dawn Sky palette it was measured on", () => {
    for (const { id, file, source } of bindings) {
      expect(source, file).toContain(`:root[data-palette="dawnsky"][data-accent="${id}"]`);
      expect(source, file).toContain(`[data-accent-swatch="${id}"]`);
    }
  });

  it("carries core's values, cell by cell (dawn = theme default signal)", () => {
    for (const { id, binding } of bindings) {
      expect([id, binding]).toEqual([id, coreBinding(id)]);
    }
  });

  it("keeps the Dawn file identical to the tokens.css default signal", () => {
    const dawn = bindings.find((entry) => entry.id === "dawn");
    expect(dawn).toBeDefined();
    for (const name of BINDING_TOKENS) {
      expect(dawn!.binding[name]).toEqual(ROOT[name]);
    }
  });

  it("S0 and the brand lockup stay outside data-accent rules", () => {
    expect(TOKENS_CSS).toMatch(/\.onboarding-landing,\s*\n\s*\.brand-lockup\s*\{[\s\S]*?--signal:/);
    expect(TOKENS_CSS).toMatch(/\.brand-lockup\s*\{[\s\S]*?--accent:\s*var\(--signal\)/);
    const onboarding = TOKENS_CSS.match(/--onboarding-accent:\s*(#[0-9a-f]{6});/i);
    expect(onboarding?.[1]).toBeDefined();
  });
});

describe("every accent binding meets the signal table", () => {
  it("has at least Dawn so the suite is not vacuous", () => {
    expect(bindings.length).toBeGreaterThan(0);
  });

  for (const { id, binding } of bindings) {
    it(`${id} passes the signal contrast table (minus its named residue)`, () => {
      expect(signalBindingFailures(binding), id).toEqual([...(PRESET_RESIDUE[id] ?? [])]);
    });
  }

  it("keeps the residue on presets only — the default signal owes nothing", () => {
    expect(PRESET_RESIDUE[DEFAULT_ACCENT_ID]).toBeUndefined();
    for (const id of Object.keys(PRESET_RESIDUE)) {
      expect(bindings.map((b) => b.id)).toContain(id);
    }
  });

  it("keeps swatch neighbours a different colour", () => {
    for (const scheme of SCHEMES) {
      for (let i = 0; i < bindings.length; i += 1) {
        for (let j = i + 1; j < bindings.length; j += 1) {
          const distance = Number(
            deltaE(
              bindings[i].binding.signal[scheme.index],
              bindings[j].binding.signal[scheme.index]
            ).toFixed(3)
          );
          expect(distance, `${bindings[i].id} vs ${bindings[j].id} ${scheme.name}`).toBeGreaterThanOrEqual(
            SIGNAL_MIN_DISTANCE
          );
        }
      }
    }
  });
});

describe("red proof: a failing binding fails this table", () => {
  const base = (): SignalBinding => ({
    signal: ["#c2410c", "#ff8a4c"],
    "on-signal": ["#fffefc", "#16171b"],
    "signal-text": ["#af3908", "#ff9a62"],
    "signal-soft": ["#fbe9de", "#392418"],
  });

  it("the Dawn Sky default passes, so the proofs below fail for their own reason", () => {
    expect(signalBindingFailures(base())).toEqual([]);
  });

  it("rejects a pale signal that cannot clear 3:1 on the surface", () => {
    const pale = { ...base(), signal: ["#f4d6c4", "#3a2519"] as Pair };
    expect(signalBindingFailures(pale).some((line) => line.includes("need 3:1 non-text"))).toBe(true);
  });

  it("rejects signal text that cannot clear AA", () => {
    const faint = { ...base(), "signal-text": ["#e08a5a", "#6a3a22"] as Pair };
    expect(signalBindingFailures(faint).some((line) => line.includes("signal-text on"))).toBe(true);
  });

  it("rejects a label colour that disappears on the fill", () => {
    const flat = { ...base(), "on-signal": ["#d0602a", "#ff9a62"] as Pair };
    expect(signalBindingFailures(flat).some((line) => line.includes("on-signal on signal"))).toBe(true);
  });

  it("rejects a signal that sits on the danger colour or the agent", () => {
    const dangerTwin = { ...base(), signal: ["#be2c4f", "#ff6b63"] as Pair };
    expect(signalBindingFailures(dangerTwin).some((line) => line.includes("signal vs danger"))).toBe(true);
    const agentTwin = { ...base(), signal: ["#2f5b8a", "#8db3e2"] as Pair };
    expect(signalBindingFailures(agentTwin).some((line) => line.includes("signal vs agent"))).toBe(true);
  });

  it("rejects a signal in the indigo band", () => {
    const indigo = { ...base(), signal: ["#6b3fa0", "#c49ae8"] as Pair };
    expect(signalBindingFailures(indigo).some((line) => line.includes("indigo band"))).toBe(true);
  });

  it("rejects a pair whose dark half is a different colour", () => {
    const mintTail = { ...base(), signal: ["#8b005a", "#6de89b"] as Pair };
    expect(signalBindingFailures(mintTail).some((line) => line.includes("light↔dark hue drift"))).toBe(true);
  });

  it("rejects a signal-soft that swallows the muted-soft vessel", () => {
    const merged = { ...base(), "signal-soft": [pickRoot("muted-soft", 0), pickRoot("muted-soft", 1)] as Pair };
    expect(signalBindingFailures(merged).some((line) => line.includes("muted-soft on signal-soft"))).toBe(true);
  });

  it("rejects a binding that rebinds more than the signal four", () => {
    expect(() =>
      loadBinding(`:root { --signal: light-dark(#c2410c, #ff8a4c); --on-signal: light-dark(#fffefc, #16171b);
        --signal-text: light-dark(#af3908, #ff9a62); --signal-soft: light-dark(#fbe9de, #392418);
        --primary: light-dark(#c2410c, #ff8a4c); }`)
    ).toThrow(/extra tokens: primary/);
  });
});

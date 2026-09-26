import { describe, expect, it } from "vitest";
import { contrast, hueGap, oklabDistance, toOklch } from "./color";
import {
  SIGNAL_PRESETS,
  SIGNAL_PRESET_IDS,
  SIGNAL_REJECTION_COPY,
  presetMatrix,
  resolveSignal,
  type SignalResult,
} from "./signal";
import { MODES, THEME_IDS, THEMES, type Mode, type ThemeId, type ThemeModeTokens } from "./themes";

// =============================================================================
// ADR-0189 D3 — 커스텀 신호 보정·거절.
//
// 엔진의 출력을 엔진과 다른 식으로 다시 잰다: 출력이 조건을 채운다고 엔진이
// 말하는 것이 아니라, 여기서 대비와 거리를 직접 계산해 확인한다.
// =============================================================================

const COMBOS: [ThemeId, Mode][] = THEME_IDS.flatMap((t) => MODES.map((m): [ThemeId, Mode] => [t, m]));

/** 엔진 밖에서 조건을 다시 잰다. 실패한 조건의 이름 목록(빈 배열 = 통과). */
function violations(result: SignalResult, t: ThemeModeTokens): string[] {
  if (!result.ok) return ["rejected"];
  const v = result.values;
  const c = t.color;
  const out: string[] = [];
  const nonText = [c.surface, c["surface-muted"], c.sheet, ...t.canvas, ...(t.band ? [t.band.band] : [])];
  const text = [c.surface, c["surface-muted"], c.sheet, ...t.canvas, v["signal-soft"]];
  nonText.forEach((h) => contrast(v.signal, h) < 3 && out.push(`signal/${h}`));
  text.forEach((h) => contrast(v["signal-text"], h) < 4.5 && out.push(`signal-text/${h}`));
  if (contrast(v["on-signal"], v.signal) < 4.5) out.push("on-signal");
  if (![c.ink, c["on-primary"]].includes(v["on-signal"])) out.push("on-signal-candidate");
  if (contrast(v["signal-soft"], c.surface) < 1.05 || oklabDistance(v["signal-soft"], c.surface) < 0.02) {
    out.push("signal-soft-vessel");
  }
  if (oklabDistance(v.signal, c.agent) < 0.07) out.push("near-agent");
  if (oklabDistance(v.signal, c.danger) < 0.07) out.push("near-danger");
  for (const hex of Object.values(v)) {
    if (["#ffffff", "#000000"].includes(hex.toLowerCase())) out.push(`pure:${hex}`);
  }
  return out;
}

describe("프리셋 네 개 × 여섯 조합", () => {
  const rows = presetMatrix();

  it("행 수 = 4 × 6", () => {
    expect(rows.length).toBe(SIGNAL_PRESET_IDS.length * COMBOS.length);
  });

  it.each(rows.map((r) => [`${r.preset} ${r.theme} ${r.mode}`, r] as const))("%s: 통과하거나 보정된다", (_n, r) => {
    expect(violations(r.result, THEMES[r.theme][r.mode])).toEqual([]);
  });

  it("새벽하늘 위에서는 네 프리셋이 보정 없이 통과한다(표 §4)", () => {
    for (const r of rows.filter((x) => x.theme === "dawnsky")) {
      expect(r.result.ok && [r.preset, r.mode, r.result.adjusted, r.result.values.signal]).toEqual([
        r.preset,
        r.mode,
        false,
        SIGNAL_PRESETS[r.preset][r.mode].toLowerCase(),
      ]);
    }
  });

  it("보정은 명도만 옮긴다 — 색상각은 3도 안에 남는다", () => {
    for (const r of rows) {
      if (!r.result.ok || !r.result.adjusted) continue;
      expect([r.preset, r.theme, r.mode, hueGap(r.input, r.result.values.signal) < 3]).toEqual([
        r.preset,
        r.theme,
        r.mode,
        true,
      ]);
    }
  });

  it("노을띠 라이트는 띠 때문에 보정된다 — 보정이 실제로 일어나는 경로가 있다", () => {
    const noeul = rows.filter((r) => r.theme === "noeul" && r.mode === "light");
    expect(noeul.every((r) => r.result.ok && r.result.adjusted)).toBe(true);
  });

  // 표 §4의 교정점: 입력 hex와 새벽하늘 표면만으로 정해지는 열.
  it.each([
    ["seongun", "light", "surface", 5.9],
    ["seongun", "light", "canvas", 4.87],
    ["hongyeom", "dark", "surface", 5.64],
    ["hyeseong", "light", "surface", 9.28],
    ["gamram", "dark", "surface", 7.24],
  ] as const)("교정: 새벽하늘 %s %s %s = %s", (preset, mode, column, expected) => {
    const t = THEMES.dawnsky[mode];
    const r = resolveSignal(SIGNAL_PRESETS[preset][mode], "dawnsky", mode);
    if (!r.ok) throw new Error("rejected");
    const s = r.values.signal;
    const got =
      column === "surface"
        ? contrast(s, t.color.surface)
        : column === "canvas"
          ? Math.min(...t.canvas.map((h) => contrast(s, h)))
          : contrast(r.values["on-signal"], s);
    expect(got).toBeCloseTo(expected, 2);
  });
});

describe("테마 기본 신호는 엔진이 보정하지 않는다", () => {
  it.each(COMBOS)("%s %s", (theme, mode) => {
    const signal = THEMES[theme][mode].color.signal;
    const r = resolveSignal(signal, theme, mode);
    expect(r.ok && [r.adjusted, r.values.signal]).toEqual([false, signal.toLowerCase()]);
  });
});

describe("경계 입력", () => {
  it.each(COMBOS)("순백 #FFFFFF — %s %s: 회색으로 보정되고 순백은 나가지 않는다", (theme, mode) => {
    const r = resolveSignal("#FFFFFF", theme, mode);
    expect(violations(r, THEMES[theme][mode])).toEqual([]);
    expect(r.ok && r.adjusted).toBe(true);
    if (r.ok) expect(toOklch(r.values.signal).C).toBeLessThan(0.01);
  });

  it.each(COMBOS)("순흑 #000000 — %s %s: 보정되고 순흑은 나가지 않는다", (theme, mode) => {
    const r = resolveSignal("#000000", theme, mode);
    expect(violations(r, THEMES[theme][mode])).toEqual([]);
    expect(r.ok && r.adjusted).toBe(true);
  });

  it("위험색과 거의 같은 색은 거절한다", () => {
    const r = resolveSignal("#BE2C50", "dawnsky", "light");
    expect(r).toEqual({ ok: false, reason: "near-danger", message: SIGNAL_REJECTION_COPY["near-danger"] });
    // 각 조합의 위험색 그 자체
    for (const [theme, mode] of COMBOS) {
      const danger = THEMES[theme][mode].color.danger;
      expect([theme, mode, resolveSignal(danger, theme, mode)]).toMatchObject([theme, mode, { ok: false, reason: "near-danger" }]);
    }
  });

  it("에이전트색과 거의 같은 색은 거절한다", () => {
    // 에이전트색 자체를 넣는다. 그대로 신호 조건을 채우는 조합에서는 거절되고,
    // 노을띠 라이트처럼 띠 때문에 명도가 옮겨지는 조합에서는 보정 뒤 거리로 판정한다.
    let rejected = 0;
    for (const [theme, mode] of COMBOS) {
      const t = THEMES[theme][mode];
      const r = resolveSignal(t.color.agent, theme, mode);
      if (r.ok) {
        expect([theme, mode, r.adjusted, violations(r, t)]).toEqual([theme, mode, true, []]);
      } else {
        expect([theme, mode, r.reason]).toEqual([theme, mode, "near-agent"]);
        rejected += 1;
      }
    }
    expect(rejected).toBeGreaterThanOrEqual(5);
    expect(resolveSignal("#2F5B8B", "dawnsky", "light")).toMatchObject({ ok: false, reason: "near-agent" });
  });

  it("거리 판정은 보정 **뒤** 값으로 한다 — 입력은 멀어도 보정 결과가 위험색에 닿으면 거절", () => {
    // 너무 밝아 3:1을 못 넘는 분홍. 보정하면 명도가 내려간다. 그 보정 결과를
    // 위험색으로 둔 표 위에서 같은 입력을 넣으면, 입력 자체는 위험색과 멀어도
    // 거절돼야 한다. 입력 hex로 거리를 쟀다면 통과했을 자리다.
    const base = THEMES.dawnsky.light;
    const input = "#F4A0B4";
    const first = resolveSignal(input, "dawnsky", "light");
    if (!first.ok) throw new Error("expected the pink to be corrected, not rejected");
    expect(first.adjusted).toBe(true);
    const corrected = first.values.signal;
    const tokens: ThemeModeTokens = { ...base, color: { ...base.color, danger: corrected } };
    expect(oklabDistance(input, corrected)).toBeGreaterThan(0.07);
    expect(resolveSignal(input, "dawnsky", "light", tokens)).toMatchObject({ ok: false, reason: "near-danger" });
  });

  it.each(["#GGGGGG", "red", "#fff", "#C2410C80", "C2410C", "", "rgb(1,2,3)"])(
    "잘못된 hex %j 는 거절한다",
    (input) => {
      expect(resolveSignal(input, "dawnsky", "light")).toEqual({
        ok: false,
        reason: "invalid-hex",
        message: SIGNAL_REJECTION_COPY["invalid-hex"],
      });
    }
  );

  it("명도를 옮겨도 조건을 못 채우면 거절한다", () => {
    // 표면과 띠가 모두 중간 회색이면 어느 명도도 둘 다에서 3:1을 넘지 못한다.
    const base = THEMES.noeul.light;
    const impossible: ThemeModeTokens = {
      ...base,
      band: { ...base.band!, band: "#777777" },
      color: { ...base.color, surface: "#777777" },
    };
    expect(resolveSignal("#C2410C", "noeul", "light", impossible)).toEqual({
      ok: false,
      reason: "unreachable",
      message: SIGNAL_REJECTION_COPY.unreachable,
    });
  });

  it("거절 문구는 한 줄이다", () => {
    for (const message of Object.values(SIGNAL_REJECTION_COPY)) {
      expect(message).not.toMatch(/\n/);
      expect(message).not.toMatch(/—/);
    }
  });
});

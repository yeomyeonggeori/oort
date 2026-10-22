import { describe, expect, it } from "vitest";
import { MODES, THEMES } from "@momo/core/design/themes";
import { WALLPAPER_PRESETS, WALLPAPER_SOLIDS, WALLPAPER_VARS, wallpaperTokensOf, wallpaperTreatment } from "@momo/core/design/wallpaper";
import type { DomTokens } from "./domTokens";
import { EMPTY_PLAN, planWallpaper, type PlanInput } from "./plan";

// 입력 → 계획: 깔아도 되는가, 루트에 무엇을 꽂는가, 배경 요소에 무엇을 칠하는가 (AP-4 #4191).

function domOf(theme: "dawnsky" | "graphite" | "noeul", hasBand = theme === "noeul"): DomTokens {
  return {
    byMode: { light: wallpaperTokensOf(THEMES[theme].light), dark: wallpaperTokensOf(THEMES[theme].dark) },
    hasBand,
  };
}

const base: PlanInput = {
  ref: undefined,
  mode: "light",
  dom: domOf("dawnsky"),
  reduceTransparency: false,
  increaseContrast: false,
  photo: { status: "none" },
};

describe("고른 것이 없으면 아무것도 깔지 않는다", () => {
  it("꺼져 있고 변수도 그림도 없다. 그래도 지금 모드의 처리(힌트용)는 계산해 둔다", () => {
    const plan = planWallpaper(base);
    expect(plan.decision).toEqual({ live: false, reason: null });
    expect(plan.vars).toEqual({});
    expect(plan.paint).toBeNull();
    expect(plan.resolved).toBe(true);
    expect(plan.treatment?.verdict).toBe("ok");
  });

  it("빈 계획은 꺼져 있고 읽지 못한 상태다", () => {
    expect(EMPTY_PLAN.decision.live).toBe(false);
    expect(EMPTY_PLAN.resolved).toBe(false);
  });
});

describe("단색·기본 제공", () => {
  it("단색: 바탕색만 칠하고 그림은 없다", () => {
    const plan = planWallpaper({ ...base, ref: { kind: "solid", id: "slate" } });
    expect(plan.decision.live).toBe(true);
    expect(plan.paint).toEqual({ backgroundColor: WALLPAPER_SOLIDS.slate.hex, backgroundImage: "none", key: "solid:slate" });
  });

  it("기본 제공: 그라데이션과 그 폴백 색을 칠한다", () => {
    const plan = planWallpaper({ ...base, ref: { kind: "preset", id: "bam" } });
    expect(plan.paint).toEqual({
      backgroundColor: WALLPAPER_PRESETS.bam.fallback,
      backgroundImage: WALLPAPER_PRESETS.bam.gradient,
      key: "preset:bam",
    });
  });

  it("깔릴 때 두 모드의 scrim과 보정색이 루트 변수로 실린다 (이름은 core 표 그대로)", () => {
    const plan = planWallpaper({ ...base, ref: { kind: "solid", id: "slate" } });
    const light = wallpaperTreatment(wallpaperTokensOf(THEMES.dawnsky.light), "light");
    const dark = wallpaperTreatment(wallpaperTokensOf(THEMES.dawnsky.dark), "dark");
    expect(plan.vars[WALLPAPER_VARS.scrim("light")]).toBe(light.scrim);
    expect(plan.vars[WALLPAPER_VARS.scrim("dark")]).toBe(dark.scrim);
    expect(plan.vars[WALLPAPER_VARS.role("ink-muted", "dark")]).toBe(dark.roles["ink-muted"]);
  });

  it("모르는 id는 「없음」이다 (그림도 변수도 없다)", () => {
    const plan = planWallpaper({ ...base, ref: { kind: "solid", id: "future-color" } });
    expect(plan.decision).toEqual({ live: false, reason: null });
    expect(plan.paint).toBeNull();
    expect(plan.vars).toEqual({});
  });
});

describe("사진", () => {
  const photoRef = { kind: "image" as const, width: 100, height: 80, rev: 7 };

  it("읽히기 전에는 깔지 않고 이유를 말한다 (변수도 없다: 평평한 scrim만 서는 일이 없다)", () => {
    for (const photo of [{ status: "none" as const }, { status: "loading" as const }, { status: "missing" as const }]) {
      const plan = planWallpaper({ ...base, ref: photoRef, photo });
      expect([photo.status, plan.decision]).toEqual([photo.status, { live: false, reason: "no-photo" }]);
      expect(plan.paint).toBeNull();
      expect(plan.vars).toEqual({});
    }
  });

  it("읽히면 사진을 칠한다: 바탕색은 CSS가 바닥색으로 주도록 비우고, 키는 번호다 (큰 문자열을 비교하지 않는다)", () => {
    const plan = planWallpaper({ ...base, ref: photoRef, photo: { status: "ready", dataUrl: "data:image/jpeg;base64,AAAA", thumb: null, rev: 7 } });
    expect(plan.decision.live).toBe(true);
    expect(plan.paint).toEqual({ backgroundColor: "", backgroundImage: 'url("data:image/jpeg;base64,AAAA")', key: "image:7" });
  });
});

describe("시스템 접근성과 테마 불가", () => {
  const ref = { kind: "preset" as const, id: "bam" };

  it("투명도 줄이기·대비 높이기: 선택은 남고 그림도 변수도 없다", () => {
    for (const flag of ["reduceTransparency", "increaseContrast"] as const) {
      const plan = planWallpaper({ ...base, ref, [flag]: true });
      expect(plan.ref).toEqual(ref);
      expect(plan.decision.live).toBe(false);
      expect(plan.decision.reason).toBe(flag === "reduceTransparency" ? "reduce-transparency" : "increase-contrast");
      expect(plan.paint).toBeNull();
      expect(plan.vars).toEqual({});
    }
  });

  it("테마의 색을 못 읽으면 깔지 않는다 (unresolved)", () => {
    const plan = planWallpaper({ ...base, ref, dom: null });
    expect(plan.resolved).toBe(false);
    expect(plan.decision).toEqual({ live: false, reason: "unresolved" });
    expect(plan.treatment).toBeNull();
  });

  it("지금 모드에서 쓸 수 없는 테마: 그 모드에서만 꺼진다 (다른 모드는 켜진다)", () => {
    // 라이트 모드의 잉크를 바닥과 거의 같게 만들어 하한이 95%를 넘게 한다(불투명으로도 7:1에 못 미친다).
    const dawn = domOf("dawnsky");
    const poor: DomTokens = {
      hasBand: false,
      byMode: {
        light: { ...dawn.byMode.light, ink: dawn.byMode.light.canvas },
        dark: dawn.byMode.dark,
      },
    };
    const light = planWallpaper({ ...base, ref, dom: poor, mode: "light" });
    expect(light.treatment?.verdict).toBe("unavailable");
    expect(light.decision).toEqual({ live: false, reason: "unavailable" });
    expect(light.paint).toBeNull();
    const dark = planWallpaper({ ...base, ref, dom: poor, mode: "dark" });
    expect(dark.decision.live).toBe(true);
  });
});

describe("모드는 지금 모드의 처리를 고른다", () => {
  it("라이트와 다크의 scrim 불투명도가 다르다 (새벽하늘 0.69 / 0.76)", () => {
    const ref = { kind: "solid" as const, id: "slate" };
    const [light, dark] = MODES.map((mode) => planWallpaper({ ...base, ref, mode }));
    expect(light.treatment?.alpha).toBeCloseTo(0.69, 5);
    expect(dark.treatment?.alpha).toBeCloseTo(0.76, 5);
  });

  it("띠 여부는 읽은 값을 그대로 싣는다", () => {
    expect(planWallpaper({ ...base, dom: domOf("noeul") }).hasBand).toBe(true);
    expect(planWallpaper({ ...base, dom: domOf("graphite") }).hasBand).toBe(false);
  });
});

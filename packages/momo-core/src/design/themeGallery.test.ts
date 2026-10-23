import { describe, expect, it } from "vitest";
import { galleryTiles, pickNotice, schemeForThemePick, themeLabel } from "./themeGallery";
import { THEME_IDS, THEME_LABELS } from "./themes";
import { modesOf, type ModesLookup, type ThemeRef } from "./themeResolve";

// 갤러리 목록과 단일 모드 규칙 1 (AP-1b #4188). 규칙 2·3은 themeResolve.test.ts가 잰다.

const SOLO_DARK = "catalog:solo-dark" as const satisfies ThemeRef;
const PAIR = "catalog:pair" as const satisfies ThemeRef;
const fake: ModesLookup = (ref) => (ref === SOLO_DARK ? ["dark"] : ref === PAIR ? ["dark", "light"] : null);

describe("갤러리 목록", () => {
  it("themeLabel: 첫 파티는 한국어 이름, 카탈로그는 항목의 라벨", () => {
    for (const id of THEME_IDS) expect(themeLabel(id)).toBe(THEME_LABELS[id]);
    expect(themeLabel("catalog:nord")).toBe("Nord");
    expect(themeLabel("catalog:github-default")).toBe("GitHub Default");
    expect(themeLabel("catalog:rose-pine")).toBe("Rosé Pine");
    expect(themeLabel("user:abc")).toBe("abc");
  });

  it("galleryTiles: 색 모드가 목록을 정한다 (시스템 19 · 라이트 20 · 다크 43, 첫 파티 먼저)", () => {
    const system = galleryTiles("system");
    const light = galleryTiles("light");
    const dark = galleryTiles("dark");
    expect([system.length, light.length, dark.length]).toEqual([19, 20, 43]);
    for (const tiles of [system, light, dark]) {
      expect(tiles.slice(0, 3).map((t) => t.ref)).toEqual(["dawnsky", "graphite", "noeul"]);
      expect(new Set(tiles.map((t) => t.ref)).size).toBe(tiles.length);
      expect(tiles.slice(3).map((t) => t.ref)).toEqual([...tiles.slice(3).map((t) => t.ref)].sort());
    }
    expect(new Set(system.map((t) => t.kind))).toEqual(new Set(["split"]));
    expect(new Set(light.map((t) => t.kind))).toEqual(new Set(["light"]));
    expect(new Set(dark.map((t) => t.kind))).toEqual(new Set(["dark"]));
    // 시스템 목록에는 단일 모드 테마가 없고, 라이트 목록에는 다크 단독이, 다크 목록에는 라이트 단독이 없다.
    expect(system.some((t) => t.ref === "catalog:nord" || t.ref === "catalog:snazzy-light")).toBe(false);
    expect(light.some((t) => t.ref === "catalog:nord")).toBe(false);
    expect(light.some((t) => t.ref === "catalog:snazzy-light")).toBe(true);
    expect(dark.some((t) => t.ref === "catalog:snazzy-light")).toBe(false);
    expect(dark.some((t) => t.ref === "catalog:nord")).toBe(true);
    // 라벨은 첫 파티는 한국어 이름, 카탈로그는 색인의 라벨이다.
    expect(system[0].label).toBe("새벽하늘");
    expect(dark.find((t) => t.ref === "catalog:nord")?.label).toBe("Nord");
  });

  it("목록의 모든 타일은 그 모드를 실제로 가진다 (modesOf와 같은 답)", () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const tile of galleryTiles(scheme)) expect(modesOf(tile.ref), tile.ref).toContain(scheme);
    }
    for (const tile of galleryTiles("system")) expect(modesOf(tile.ref), tile.ref).toEqual(["light", "dark"]);
  });
});

describe("단일 모드 규칙 1: 단일 모드 테마를 고르면 색 모드를 그 모드로 맞춘다", () => {
  it("다크 단독을 시스템·라이트에서 고르면 다크로 맞추고 알린다", () => {
    expect(schemeForThemePick("system", "catalog:nord")).toEqual({ scheme: "dark", adjusted: "dark" });
    expect(schemeForThemePick("light", "catalog:nord")).toEqual({ scheme: "dark", adjusted: "dark" });
  });

  it("이미 그 모드면 아무것도 바꾸지 않고 알리지도 않는다", () => {
    expect(schemeForThemePick("dark", "catalog:nord")).toEqual({ scheme: "dark", adjusted: null });
    expect(schemeForThemePick("light", "catalog:snazzy-light")).toEqual({ scheme: "light", adjusted: null });
  });

  it("라이트 단독은 라이트로 맞춘다", () => {
    expect(schemeForThemePick("system", "catalog:snazzy-light")).toEqual({ scheme: "light", adjusted: "light" });
    expect(schemeForThemePick("dark", "catalog:snazzy-light")).toEqual({ scheme: "light", adjusted: "light" });
  });

  it("두 모드를 다 가진 테마는 고른 색 모드를 건드리지 않는다", () => {
    for (const scheme of ["system", "light", "dark"] as const) {
      expect(schemeForThemePick(scheme, "catalog:github")).toEqual({ scheme, adjusted: null });
      expect(schemeForThemePick(scheme, "noeul")).toEqual({ scheme, adjusted: null });
    }
  });

  it("가짜 조회로도 같은 규칙이다", () => {
    expect(schemeForThemePick("system", SOLO_DARK, fake)).toEqual({ scheme: "dark", adjusted: "dark" });
    expect(schemeForThemePick("system", PAIR, fake)).toEqual({ scheme: "system", adjusted: null });
  });

  it("문구: 이 테마는 {모드}만 있어서 색 모드를 {모드}로 맞췄어요", () => {
    expect(pickNotice("dark")).toBe("이 테마는 다크만 있어서 색 모드를 다크로 맞췄어요.");
    expect(pickNotice("light")).toBe("이 테마는 라이트만 있어서 색 모드를 라이트로 맞췄어요.");
  });
});


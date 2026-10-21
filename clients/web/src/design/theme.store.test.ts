// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROOT_ATTRIBUTES } from "@momo/core/design/appearance";
import { rootStamp, STAMPED_ATTRIBUTES } from "@momo/core/design/rootStamp";
import { themeCacheKey } from "@momo/core/design/themeCache";
import type { ModesLookup } from "@momo/core/design/themeResolve";
import {
  APPEARANCE_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY_V1,
  THEME_STORAGE_KEY,
  getAccent,
  getAppearance,
  getThemeRef,
  initTheme,
  reloadAppearanceForTest,
  setAccent,
  setTheme,
  setThemeModesLookupForTest,
  setThemeRef,
  subscribeTheme,
  updateAppearance,
} from "./theme";
import { THEME_CACHE_STORAGE_KEY } from "./themeCache";

// AP-1a(#4186): 저장소의 **진짜 경로**(localStorage · document · 구독)를 잰다. 규칙 표 자체는
// core rootStamp.test.ts가, 부트 스크립트와의 일치는 theme.test.ts가 잰다.

const root = () => document.documentElement;
const hex = (six: string) => `#${six}`;
const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 2, scheme: "system", theme: "dawnsky", signal: null, density: "comfortable", ...over });
const cacheRaw = (theme: string, vars: Record<string, string> = { "--ink": hex("2e3440") }) =>
  JSON.stringify({ key: themeCacheKey("1", { theme: theme as never, signal: null }), vars });

function clearRoot(): void {
  for (const name of [...STAMPED_ATTRIBUTES, ROOT_ATTRIBUTES.glass, "data-font-sans", "data-font-mono"]) {
    root().removeAttribute(name);
  }
  root().removeAttribute("style");
}

beforeEach(() => {
  localStorage.clear();
  clearRoot();
  reloadAppearanceForTest();
});

afterEach(() => {
  setThemeModesLookupForTest(undefined);
  vi.restoreAllMocks();
  localStorage.clear();
  clearRoot();
  reloadAppearanceForTest();
});

describe("저장: v2 하나만 쓰고 v1·옛 키는 그대로 둔다 (롤백 허용)", () => {
  it("v1을 읽어 쓰는 첫 변경이 v2를 만들고, v1 원문은 한 글자도 안 바뀐다", () => {
    const v1 = JSON.stringify({ scheme: "light", accent: "gamram", fontSans: "Pretendard" });
    localStorage.setItem(APPEARANCE_STORAGE_KEY_V1, v1);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    reloadAppearanceForTest();
    expect(getAppearance()).toMatchObject({ scheme: "light", signal: { preset: "gamram" }, fontSans: "Pretendard" });
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();

    setTheme("dark");
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}")).toEqual({
      v: 2,
      scheme: "dark",
      theme: "dawnsky",
      signal: { preset: "gamram" },
      density: "comfortable",
      fontSans: "Pretendard",
    });
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY_V1)).toBe(v1);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("달라진 것이 없으면 쓰지도 알리지도 않는다", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const listener = vi.fn();
    const off = subscribeTheme(listener);
    setTheme("system");
    setAccent("dawn");
    updateAppearance({ fontSize: "default", threadLayout: "split", prominentActive: false });
    expect(write).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    setTheme("dark");
    expect(write).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("스냅샷 객체는 바뀔 때만 새로 만들어진다 (useSyncExternalStore의 조건)", () => {
    const first = getAppearance();
    expect(getAppearance()).toBe(first);
    setTheme("light");
    const second = getAppearance();
    expect(second).not.toBe(first);
    expect(getAppearance()).toBe(second);
  });

  it("updateAppearance가 이후 이슈의 필드를 정규화해 저장하고 속성으로 찍는다", () => {
    updateAppearance({
      fontSize: "larger",
      threadLayout: "focus",
      prominentActive: true,
      wallpaper: { kind: "preset", id: "bam" },
      density: "compact",
    });
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}")).toMatchObject({
      fontSize: "larger",
      threadLayout: "focus",
      prominentActive: true,
      wallpaper: { kind: "preset", id: "bam" },
      density: "compact",
    });
    expect(root().getAttribute("data-font-size")).toBe("larger");
    expect(root().getAttribute("data-thread-layout")).toBe("focus");
    expect(root().hasAttribute("data-prominent-active")).toBe(true);
    expect(root().getAttribute("data-wallpaper")).toBe("preset");
    expect(root().getAttribute("data-density")).toBe("compact");
    updateAppearance({ wallpaper: undefined, prominentActive: false });
    expect(root().hasAttribute("data-wallpaper")).toBe(false);
    expect(root().hasAttribute("data-prominent-active")).toBe(false);
  });
});

describe("루트 스탬프: 표 한 곳에서 나온 것만 찍힌다", () => {
  it("initTheme는 저장된 레코드의 표를 그대로 찍는다", () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      record({ scheme: "light", theme: "graphite", signal: { preset: "hongyeom" }, fontSize: "smaller" })
    );
    reloadAppearanceForTest();
    clearRoot();
    initTheme();
    const stamp = rootStamp(getAppearance());
    for (const name of STAMPED_ATTRIBUTES) {
      const value = stamp[name];
      if (value === null) expect(root().hasAttribute(name), name).toBe(false);
      else expect(root().getAttribute(name), name).toBe(value);
    }
  });

  it("옛 액센트와 신호는 한 근원에서 같이 찍힌다 (setAccent ↔ signal)", () => {
    setAccent("seongun");
    expect(getAccent()).toBe("seongun");
    expect(root().getAttribute("data-accent")).toBe("seongun");
    expect(root().getAttribute("data-signal")).toBe("seongun");
    expect(getAppearance().signal).toEqual({ preset: "seongun" });
    setAccent("dawn");
    expect(getAccent()).toBe("dawn");
    expect(root().getAttribute("data-accent")).toBe("dawn");
    expect(root().hasAttribute("data-signal")).toBe(false);
    expect(getAppearance().signal).toBeNull();
  });

  it("직접 고른 신호색이 있으면 setAccent(dawn)이 그것을 풀어 준다", () => {
    updateAppearance({ signal: { custom: hex("9c447c") } });
    expect(root().getAttribute("data-signal")).toBe("custom");
    expect(getAccent()).toBe("dawn");
    setAccent("dawn");
    expect(getAppearance().signal).toBeNull();
    expect(root().hasAttribute("data-signal")).toBe(false);
  });

  it("data-glass는 저장소가 찍지도 지우지도 않는다 (AP-3의 몫, planner 결정 2026-10-22)", () => {
    root().setAttribute(ROOT_ATTRIBUTES.glass, "");
    initTheme();
    setTheme("dark");
    updateAppearance({ glass: { on: true, opacity: 80 } });
    expect(root().getAttribute(ROOT_ATTRIBUTES.glass)).toBe("");
    root().removeAttribute(ROOT_ATTRIBUTES.glass);
    updateAppearance({ glass: { on: true, opacity: 70 } });
    expect(root().hasAttribute(ROOT_ATTRIBUTES.glass)).toBe(false);
    // 값은 레코드에 남아 AP-3가 읽는다.
    expect(getAppearance().glass).toEqual({ on: true, opacity: 70 });
  });
});

describe("단일 모드 테마: 스토어가 유효 스킴으로 data-theme를 찍는다 (AC 8)", () => {
  const lookup: ModesLookup = (ref) =>
    ref === "catalog:solo-dark" ? ["dark"] : ref === "catalog:solo-light" ? ["light"] : null;

  it("다크 단독 테마를 시스템에서 고르면 다크로 못 박히고, 첫 파티로 돌아오면 풀린다", () => {
    setThemeModesLookupForTest(lookup);
    setThemeRef("catalog:solo-dark");
    expect(getThemeRef()).toBe("catalog:solo-dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(root().getAttribute("data-palette")).toBe("derived");
    expect(root().getAttribute("data-theme-ref")).toBe("catalog:solo-dark");
    expect(getAppearance().scheme).toBe("system"); // 사람의 선택은 건드리지 않는다.
    setThemeRef("dawnsky");
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("라이트로 골라 둔 사람이 다크 단독 테마를 고르면 그 테마의 모드가 이긴다", () => {
    setThemeModesLookupForTest(lookup);
    setTheme("light");
    setThemeRef("catalog:solo-dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
    setThemeRef("catalog:solo-light");
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("조회가 없으면(카탈로그 전) 같은 참조도 둘 다로 본다", () => {
    setThemeRef("catalog:solo-dark");
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("모르는 참조 문자열은 새벽하늘이다", () => {
    setThemeRef("neon" as never);
    expect(getThemeRef()).toBe("dawnsky");
  });
});

describe("부트 캐시 정리", () => {
  it("테마가 바뀌면 낡은 캐시를 즉시 비운다", () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, record({ theme: "catalog:nord" }));
    localStorage.setItem(THEME_CACHE_STORAGE_KEY, cacheRaw("catalog:nord"));
    reloadAppearanceForTest();
    expect(localStorage.getItem(THEME_CACHE_STORAGE_KEY)).not.toBeNull(); // 파생 팔레트는 건드리지 않는다
    setThemeRef("catalog:dracula");
    expect(localStorage.getItem(THEME_CACHE_STORAGE_KEY)).toBeNull();
  });

  it("신호가 바뀌어도 비우고, 스킴만 바뀌면 둔다 (변수는 light-dark 쌍이라)", () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, record({ theme: "catalog:nord" }));
    localStorage.setItem(THEME_CACHE_STORAGE_KEY, cacheRaw("catalog:nord"));
    reloadAppearanceForTest();
    setTheme("dark");
    updateAppearance({ density: "compact", fontSize: "larger" });
    expect(localStorage.getItem(THEME_CACHE_STORAGE_KEY)).not.toBeNull();
    setAccent("gamram");
    expect(localStorage.getItem(THEME_CACHE_STORAGE_KEY)).toBeNull();
  });

  it("첫 파티 팔레트에서는 부트가 되꽂은 인라인 변수를 걷고 항목도 지운다", () => {
    localStorage.setItem(THEME_CACHE_STORAGE_KEY, cacheRaw("dawnsky", { "--ink": hex("2e3440"), "--line": hex("e7e4df") }));
    root().style.setProperty("--ink", hex("2e3440"));
    root().style.setProperty("--line", hex("e7e4df"));
    root().style.setProperty("--unrelated", "1");
    initTheme();
    expect(root().style.getPropertyValue("--ink")).toBe("");
    expect(root().style.getPropertyValue("--line")).toBe("");
    expect(root().style.getPropertyValue("--unrelated")).toBe("1");
    expect(localStorage.getItem(THEME_CACHE_STORAGE_KEY)).toBeNull();
  });

  it("파생 팔레트에서는 캐시와 인라인 변수를 건드리지 않는다 (엔진의 몫)", () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, record({ theme: "catalog:nord" }));
    reloadAppearanceForTest();
    localStorage.setItem(THEME_CACHE_STORAGE_KEY, cacheRaw("catalog:nord"));
    root().style.setProperty("--ink", hex("2e3440"));
    initTheme();
    expect(root().style.getPropertyValue("--ink")).toBe(hex("2e3440"));
    expect(localStorage.getItem(THEME_CACHE_STORAGE_KEY)).not.toBeNull();
  });
});

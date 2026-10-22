// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DERIVED_VAR_NAMES } from "@momo/core/design/derive";
import { WEB_THEME_CACHE_ENTRY, parseThemeCache, themeCacheKey } from "@momo/core/design/themeCache";
import type { ThemeRef } from "@momo/core/design/themeResolve";
import {
  getAppearance,
  reloadAppearanceForTest,
  setThemeModesLookupForTest,
  updateAppearance,
} from "@/design/theme";
import { startDerivedTheme } from "./applyDerived";
import { createDerivedApplier } from "./derivedApplier";
import { desktopEffects, registerGlassSourcesResolver, setDesktopEffectsForTest } from "@/features/settings/appearance/desktopEffects";
import { DERIVE_ENGINE_VERSION, derivedVarsFor, glassSourcesFor } from "./derived";

// =============================================================================
// 파생 테마를 루트에 꽂는 적용기 (ADR-0189 증보 3 D2, AP-1b #4188, AC 3·4). 진짜 저장소(`theme.ts`)와 진짜 문서(jsdom)와
// 진짜 엔진 위에서 잰다: 변수가 꽂히고, 바꾸거나 돌아가면 **자기가 꽂은 것이 하나도 안 남고**, 부트 캐시가 단일
// 모드 테마에서 mode를 들고, `meta theme-color`가 파생 바닥색을 따른다.
// =============================================================================

const root = document.documentElement;
const styleNames = () => Array.from({ length: root.style.length }, (_, i) => root.style.item(i));
const inlineVars = () => styleNames().filter((name) => name.startsWith("--"));
const metas = () => [...document.querySelectorAll<HTMLMetaElement>("meta[name='theme-color']")];
const cacheEntry = () => parseThemeCache(localStorage.getItem(WEB_THEME_CACHE_ENTRY));
const LIGHT_LINE = "(prefers-color-scheme: light)";
const DARK_LINE = "(prefers-color-scheme: dark)";
const SITE_LIGHT = "site-light";
const SITE_DARK = "site-dark";

function installMetas() {
  for (const [media, content] of [
    [LIGHT_LINE, SITE_LIGHT],
    [DARK_LINE, SITE_DARK],
  ]) {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("media", media);
    meta.setAttribute("content", content);
    document.head.append(meta);
  }
}

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("style");
  for (const name of ["data-theme", "data-palette", "data-theme-ref", "data-signal", "data-accent"]) root.removeAttribute(name);
  installMetas();
  reloadAppearanceForTest();
});

afterEach(() => {
  setThemeModesLookupForTest(undefined);
  for (const meta of metas()) meta.remove();
  localStorage.clear();
  root.removeAttribute("style");
  reloadAppearanceForTest();
  vi.restoreAllMocks();
});

describe("변수를 꽂는다 (모든 역할을 빠짐없이)", () => {
  it("다크 단독 테마(nord): 33개 변수가 색 하나로 서고, 값은 엔진의 것이다", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    applier.sync();
    const expected = derivedVarsFor("catalog:nord", null)!;
    expect(inlineVars().sort()).toEqual([...DERIVED_VAR_NAMES].sort());
    for (const [name, value] of Object.entries(expected.vars)) expect([name, root.style.getPropertyValue(name)]).toEqual([name, value]);
    expect(root.style.getPropertyValue("--ink")).not.toContain("light-dark");
    expect(root.getAttribute("data-palette")).toBe("derived");
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("쌍 테마(github): light-dark(라이트, 다크) 한 줄이다", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:github" });
    applier.sync();
    expect(inlineVars()).toHaveLength(33);
    for (const name of inlineVars()) expect(root.style.getPropertyValue(name), name).toMatch(/^(light-dark\(.+\)|#[0-9a-f]{6}|rgba\(.+\))$/);
    expect(root.style.getPropertyValue("--ink")).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
    expect(root.style.getPropertyValue("--pane")).toMatch(/^light-dark\(/);
  });

  it("인라인 style 속성이 아니라 CSS 변수만 만진다 (--로 시작하는 것뿐)", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:github" });
    applier.sync();
    expect(styleNames().every((name) => name.startsWith("--"))).toBe(true);
  });

  it("사람이 고른 신호가 받아들여지는 조합은 신호 네 값이 달라지고, 거절되는 조합은 테마의 신호로 선다", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    applier.sync();
    const base = root.style.getPropertyValue("--signal");
    updateAppearance({ signal: { preset: "hyeseong" } });
    applier.sync();
    expect(root.style.getPropertyValue("--signal")).not.toBe(base);
    updateAppearance({ signal: { preset: "hongyeom" } }); // nord 다크에서 near-danger로 거절된다
    applier.sync();
    expect(root.style.getPropertyValue("--signal")).toBe(base);
  });
});

describe("잔존 0: 바꾸거나 돌아가면 자기가 꽂은 변수를 전부 걷는다 (AC 3)", () => {
  it("첫 파티로 돌아가면 인라인 변수가 하나도 안 남는다", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    applier.sync();
    expect(inlineVars()).toHaveLength(33);
    updateAppearance({ theme: "dawnsky" });
    applier.sync();
    expect(inlineVars()).toEqual([]);
    expect(root.getAttribute("data-palette")).toBe("dawnsky");
  });

  it("부트 캐시를 못 쓰는 환경(프라이빗 모드)에서도 걷는다: 걷을 이름은 꽂을 때 적어 둔 것이다", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:github" });
    applier.sync();
    expect(inlineVars()).toHaveLength(33);
    expect(cacheEntry()).toBeNull(); // 캐시는 못 썼다
    updateAppearance({ theme: "graphite" });
    applier.sync();
    expect(inlineVars()).toEqual([]);
  });

  it("파생 테마에서 다른 파생 테마로: 이름 집합이 같고 값만 바뀌며 낡은 값이 없다", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    applier.sync();
    const first = Object.fromEntries(inlineVars().map((name) => [name, root.style.getPropertyValue(name)]));
    updateAppearance({ theme: "catalog:dracula", scheme: "dark" });
    applier.sync();
    const second = Object.fromEntries(inlineVars().map((name) => [name, root.style.getPropertyValue(name)]));
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
    expect(second["--ink"]).not.toBe(first["--ink"]);
    expect(second).toEqual(derivedVarsFor("catalog:dracula", null)!.vars);
  });

  it("단일 모드 테마에서 쌍 테마로: light-dark 값으로 바뀐다 (이름 집합은 같다)", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    applier.sync();
    updateAppearance({ theme: "catalog:github", scheme: "system" });
    applier.sync();
    expect(root.style.getPropertyValue("--ink")).toMatch(/^light-dark\(/);
    expect(inlineVars()).toHaveLength(33);
  });

  it("user: 참조나 모르는 참조는 아무것도 꽂지 않고 던지지도 않는다 (사용자 테마는 AP-5가 연다)", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:nord" });
    applier.sync();
    updateAppearance({ theme: "user:mine" });
    expect(() => applier.sync()).not.toThrow();
    expect(inlineVars()).toEqual([]);
  });
});

describe("부트 캐시 (첫 페인트가 읽는다, AC 4)", () => {
  it("단일 모드 테마는 mode를 같이 쓴다 (안 쓰면 부트와 런타임의 첫 프레임 data-theme가 어긋난다)", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:nord", scheme: "system" });
    applier.sync();
    const entry = cacheEntry();
    expect(entry).not.toBeNull();
    expect(entry!.mode).toBe("dark");
    expect(entry!.key).toBe(themeCacheKey(DERIVE_ENGINE_VERSION, { theme: "catalog:nord", signal: null }));
    expect(Object.keys(entry!.vars).sort()).toEqual([...DERIVED_VAR_NAMES].sort());
  });

  it("쌍 테마는 mode가 없다 (OS 스킴이 바뀌어도 다시 계산하지 않는다)", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:github" });
    applier.sync();
    expect(cacheEntry()!.mode).toBeUndefined();
  });

  it("키에 테마·신호가 든다: 신호를 바꾸면 캐시가 새 키와 새 값으로 다시 쓰인다", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:github" });
    applier.sync();
    const first = cacheEntry()!;
    updateAppearance({ signal: { preset: "gamram" } });
    applier.sync();
    const second = cacheEntry()!;
    expect(second.key).toBe(themeCacheKey(DERIVE_ENGINE_VERSION, { theme: "catalog:github", signal: { preset: "gamram" } }));
    expect(second.key).not.toBe(first.key);
    expect(second.vars["--signal"]).not.toBe(first.vars["--signal"]);
  });

  it("같은 상태로 다시 맞추면 캐시를 다시 쓰지 않는다 (매번 같은 항목을 덮어쓰지 않는다)", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:github" });
    applier.sync();
    const write = vi.spyOn(Storage.prototype, "setItem");
    applier.sync();
    applier.sync();
    expect(write.mock.calls.filter(([name]) => name === WEB_THEME_CACHE_ENTRY)).toHaveLength(0);
  });

  it("첫 파티로 돌아가면 캐시 항목은 저장소가 걷는다 (낡은 색이 다음 부팅 첫 프레임에 번쩍이지 않는다)", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:github" });
    applier.sync();
    expect(cacheEntry()).not.toBeNull();
    updateAppearance({ theme: "dawnsky" });
    applier.sync();
    expect(cacheEntry()).toBeNull();
  });
});

describe("meta theme-color (AC 4)", () => {
  it("쌍 테마 + 시스템: 줄마다 자기 모드의 바닥색이다", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:github", scheme: "system" });
    applier.sync();
    const out = derivedVarsFor("catalog:github", null)!;
    const byLine = Object.fromEntries(metas().map((meta) => [meta.getAttribute("media"), meta.getAttribute("content")]));
    expect(byLine[LIGHT_LINE]).toBe(out.canvas.light);
    expect(byLine[DARK_LINE]).toBe(out.canvas.dark);
    expect(out.canvas.light).not.toBe(out.canvas.dark);
  });

  it("고정이면 두 줄 모두 그 모드의 바닥색이다 (쌍 테마 라이트 고정, 단일 모드 테마)", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:github", scheme: "light" });
    applier.sync();
    const github = derivedVarsFor("catalog:github", null)!;
    expect(metas().map((m) => m.getAttribute("content"))).toEqual([github.canvas.light, github.canvas.light]);
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    applier.sync();
    const nord = derivedVarsFor("catalog:nord", null)!;
    expect(metas().map((m) => m.getAttribute("content"))).toEqual([nord.canvas.dark, nord.canvas.dark]);
  });

  it("첫 파티로 돌아가면 사이트의 원래 색으로 되돌아간다 (`applyTheme`가 되돌리는 쪽의 짝)", () => {
    const applier = createDerivedApplier();
    updateAppearance({ theme: "catalog:nord", scheme: "system" });
    applier.sync();
    expect(metas().map((m) => m.getAttribute("content"))).not.toEqual([SITE_LIGHT, SITE_DARK]);
    updateAppearance({ theme: "dawnsky", scheme: "system" });
    applier.sync();
    expect(metas().map((m) => m.getAttribute("content"))).toEqual([SITE_LIGHT, SITE_DARK]);
  });
});

describe("메인 번들의 얇은 문 (applyDerived)", () => {
  function deferred() {
    let resolve!: (value: { sync(): void }) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<{ sync(): void }>((ok, bad) => {
      resolve = ok;
      reject = bad;
    });
    return { promise, resolve, reject };
  }

  it("첫 파티면 적용기를 싣지 않는다 (첫 파티는 정적 CSS가 색을 준다)", () => {
    const load = vi.fn();
    const door = startDerivedTheme({ load });
    updateAppearance({ theme: "graphite" });
    updateAppearance({ scheme: "dark" });
    expect(load).not.toHaveBeenCalled();
    door.stop();
  });

  it("파생 테마가 되는 순간 한 번만 싣고, 로드 중 변경에도 다시 싣지 않는다 (적용기가 둘이면 기록이 갈린다)", async () => {
    const gate = deferred();
    const load = vi.fn(() => gate.promise);
    const sync = vi.fn();
    const door = startDerivedTheme({ load });
    updateAppearance({ theme: "catalog:nord" });
    updateAppearance({ signal: { preset: "gamram" } });
    updateAppearance({ scheme: "dark" });
    expect(load).toHaveBeenCalledTimes(1);
    gate.resolve({ sync });
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1)); // 로드 뒤 그때의 저장소로 한 번 맞춘다
    updateAppearance({ scheme: "light" });
    expect(sync).toHaveBeenCalledTimes(2); // 싣고 난 뒤의 모든 변경은 적용기에 넘긴다
    expect(load).toHaveBeenCalledTimes(1);
    door.stop();
  });

  it("로드를 기다리는 사이에 첫 파티로 돌아가도 낡은 선택을 적용하지 않는다 (그때의 저장소를 다시 읽는다)", async () => {
    const applier = createDerivedApplier();
    const gate = deferred();
    const door = startDerivedTheme({ load: () => gate.promise });
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    updateAppearance({ theme: "dawnsky" });
    gate.resolve(applier);
    await vi.waitFor(() => expect(getAppearance().theme).toBe("dawnsky"));
    await Promise.resolve();
    expect(inlineVars()).toEqual([]);
    door.stop();
  });

  it("로드가 실패하면 삼키고(앱은 기본 테마로 선다) 다음 변경에서 다시 시도한다", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("chunk")).mockResolvedValue({ sync: vi.fn() });
    const door = startDerivedTheme({ load });
    updateAppearance({ theme: "catalog:nord" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    updateAppearance({ scheme: "dark" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    door.stop();
  });

  it("진짜 적용기를 싣는다: 저장소 변경이 변수와 캐시로 닿는다 (구독 끝에서 끝까지)", async () => {
    const door = startDerivedTheme({ storage: localStorage });
    updateAppearance({ theme: "catalog:github", scheme: "dark" });
    await vi.waitFor(() => expect(inlineVars()).toHaveLength(33));
    expect(cacheEntry()?.key).toBe(themeCacheKey(DERIVE_ENGINE_VERSION, { theme: "catalog:github", signal: null }));
    updateAppearance({ theme: "dawnsky" });
    expect(inlineVars()).toEqual([]);
    door.stop();
  });

  it("앱 시작 때 이미 파생 테마가 저장돼 있으면 시작과 함께 싣고 맞춘다 (부트 캐시가 없어도)", async () => {
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    localStorage.removeItem(WEB_THEME_CACHE_ENTRY);
    root.removeAttribute("style");
    const door = startDerivedTheme({ storage: localStorage });
    await vi.waitFor(() => expect(inlineVars()).toHaveLength(33));
    expect(cacheEntry()?.mode).toBe("dark");
    door.stop();
  });
});

describe("데스크탑 유리가 카탈로그 테마의 색을 읽는다 (AP-3 `registerGlassSourcesResolver`)", () => {
  afterEach(() => {
    registerGlassSourcesResolver(null);
    setDesktopEffectsForTest(null);
  });

  it("`glassSourcesFor`: 쌍 테마는 두 모드, 단일 모드 테마는 있는 모드만 든다. 첫 파티·`user:`·모르는 항목은 null이다", () => {
    const pair = glassSourcesFor("catalog:github", null)!;
    expect(Object.keys(pair).sort()).toEqual(["dark", "light"]);
    expect(pair.light!.canvas).toHaveLength(3);
    expect(pair.light!.band).toBeNull();
    const nord = glassSourcesFor("catalog:nord", null)!;
    expect(Object.keys(nord)).toEqual(["dark"]);
    for (const ref of ["dawnsky", "user:mine", "catalog:no-such-theme", "catalog:"] as ThemeRef[]) expect([ref, glassSourcesFor(ref, null)]).toEqual([ref, null]);
  });

  it("고른 강조색이 유리가 읽는 신호에 들어간다(사이드바의 신호색이 유리 위에서 사라지지 않게)", () => {
    const base = glassSourcesFor("catalog:github", null)!.light!.color.signal;
    const chosen = glassSourcesFor("catalog:github", { preset: "gamram" })!.light!.color.signal;
    expect(chosen).not.toBe(base);
    // 같은 입력은 같은 객체다: 유리 쪽 범위 기억(`WeakMap`)이 일한다.
    expect(glassSourcesFor("catalog:github", null)!.light).toBe(glassSourcesFor("catalog:github", null)!.light);
  });

  it("적용기가 서기 전의 카탈로그 테마는 유리가 「색을 아직 못 읽음」이고, 선 뒤에는 그 테마의 하한이 읽힌다", () => {
    registerGlassSourcesResolver(null);
    setDesktopEffectsForTest(null);
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    const effects = desktopEffects();
    effects.refresh();
    expect(effects.getSnapshot().view.range).toBeNull();
    createDerivedApplier(); // 엔진이 선 자리에서 조회를 한 번 꽂는다(그 자리에서 유리가 다시 맞춘다)
    const range = effects.getSnapshot().view.range;
    expect(range).not.toBeNull();
    expect(range!.usable).toBe(true);
    expect(range!.min).toBeGreaterThan(0);
    expect(range!.min).toBeLessThanOrEqual(range!.max);
  });

  it("테마를 바꾸면 같은 조회가 새 테마를 읽는다: 첫 파티로 돌아가면 조회와 상관없이 첫 파티의 값이다", () => {
    const effects = desktopEffects();
    createDerivedApplier();
    updateAppearance({ theme: "catalog:github", scheme: "light" });
    effects.refresh();
    const github = effects.getSnapshot().view.range!.min;
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    effects.refresh();
    const nord = effects.getSnapshot().view.range!.min;
    expect(github).not.toBe(nord);
    updateAppearance({ theme: "dawnsky", scheme: "dark" });
    effects.refresh();
    expect(effects.getSnapshot().view.range).not.toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { WallpaperRef } from "@momo/core/design/appearance";
import { THEMES, type Mode } from "@momo/core/design/themes";
import { WALLPAPER_SOLIDS, WALLPAPER_VARS, wallpaperTokensOf, wallpaperTreatment } from "@momo/core/design/wallpaper";
import type { PhotoView } from "./store";
import { LIVE_ATTRIBUTE, createWallpaperRuntime, type WallpaperRuntimeDeps } from "./runtime";

// 문서에 올리는 일의 규칙을 가짜 문서·가짜 신호원으로 잰다 (AP-4 #4191). 진짜 브라우저에서 같은 규칙이 화면에
// 서는지는 캡처 스크립트의 단정이 잰다.

/** 팔레트 CSS가 칠하는 모양(`light-dark(색, 색)`)으로 첫 파티 테마의 변수를 낸다. */
function varsOf(theme: "dawnsky" | "graphite" | "noeul"): Record<string, string> {
  const pair = (light: string, dark: string) => `light-dark(${light.toLowerCase()}, ${dark.toLowerCase()})`;
  const l = THEMES[theme].light;
  const d = THEMES[theme].dark;
  const color = (role: keyof typeof l.color) => pair(l.color[role], d.color[role]);
  return {
    "--canvas-mid": pair(l.canvas[1], d.canvas[1]),
    "--ink": color("ink"),
    "--on-primary": color("on-primary"),
    "--on-signal": color("on-signal"),
    "--ink-muted": color("ink-muted"),
    "--signal-text": color("signal-text"),
    "--agent": color("agent"),
    "--ok": color("ok"),
    "--warn": color("warn"),
    "--danger": color("danger"),
    "--icon": color("icon"),
    "--signal": color("signal"),
    ...(l.band ? { "--band": pair(l.band.band, d.band?.band ?? l.band.band) } : {}),
  };
}

interface World {
  attrs: Map<string, string>;
  props: Map<string, string>;
  log: string[];
  layer: { style: { backgroundColor: string; backgroundImage: string } };
  appearance: { wallpaper?: WallpaperRef };
  photo: PhotoView;
  system: Mode;
  flags: { reduceTransparency: boolean; increaseContrast: boolean };
  cssVars: Record<string, string>;
  fire: { appearance(): void; photo(): void; system(): void; reduce(): void; contrast(): void; root(): void };
  deps: WallpaperRuntimeDeps;
  ensureLoaded: ReturnType<typeof vi.fn>;
  clearWallpaper: ReturnType<typeof vi.fn>;
  runtime: ReturnType<typeof createWallpaperRuntime>;
}

function world(theme: "dawnsky" | "graphite" | "noeul" = "dawnsky", wallpaper?: WallpaperRef): World {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  const log: string[] = [];
  const listeners = { appearance: new Set<() => void>(), photo: new Set<() => void>(), system: new Set<() => void>(), reduce: new Set<() => void>(), contrast: new Set<() => void>(), root: new Set<() => void>() };
  const layerState = { backgroundColor: "", backgroundImage: "" };
  const layer = {
    style: {
      get backgroundColor() { return layerState.backgroundColor; },
      set backgroundColor(value: string) { layerState.backgroundColor = value; log.push(`layer color ${value}`); },
      get backgroundImage() { return layerState.backgroundImage; },
      set backgroundImage(value: string) { layerState.backgroundImage = value; log.push(`layer image ${value.slice(0, 20)}`); },
    },
  };
  const w = {
    attrs, props, log, layer,
    appearance: { wallpaper } as { wallpaper?: WallpaperRef },
    photo: { status: "none" } as PhotoView,
    system: "light" as Mode,
    flags: { reduceTransparency: false, increaseContrast: false },
    cssVars: varsOf(theme),
  } as World;
  const fireAll = (set: Set<() => void>) => () => { for (const l of [...set]) l(); };
  w.fire = { appearance: fireAll(listeners.appearance), photo: fireAll(listeners.photo), system: fireAll(listeners.system), reduce: fireAll(listeners.reduce), contrast: fireAll(listeners.contrast), root: fireAll(listeners.root) };
  const sub = (set: Set<() => void>) => (listener: () => void) => { set.add(listener); return () => { set.delete(listener); }; };
  w.ensureLoaded = vi.fn();
  w.clearWallpaper = vi.fn(() => { delete w.appearance.wallpaper; w.fire.appearance(); });
  w.deps = {
    root: {
      getAttribute: (name) => attrs.get(name) ?? null,
      setAttribute: (name, value) => { attrs.set(name, value); log.push(`set ${name}`); },
      removeAttribute: (name) => { attrs.delete(name); log.push(`remove ${name}`); },
      style: {
        setProperty: (name, value) => { props.set(name, value); log.push(`prop ${name}`); },
        removeProperty: (name) => { props.delete(name); log.push(`unprop ${name}`); },
      },
    },
    readVar: (name) => w.cssVars[name] ?? "",
    appearance: { get: () => w.appearance, subscribe: sub(listeners.appearance) },
    clearWallpaper: w.clearWallpaper,
    photo: { get: () => w.photo, subscribe: sub(listeners.photo), ensureLoaded: w.ensureLoaded },
    systemScheme: { get: () => w.system, subscribe: sub(listeners.system) },
    reduceTransparency: { matches: () => w.flags.reduceTransparency, subscribe: sub(listeners.reduce) },
    increaseContrast: { matches: () => w.flags.increaseContrast, subscribe: sub(listeners.contrast) },
    observeRoot: sub(listeners.root),
  };
  w.runtime = createWallpaperRuntime(w.deps);
  return w;
}

const attach = (w: World) => w.runtime.attach(w.layer as unknown as HTMLElement);
const varCount = 2 * (1 + 9);

describe("단색을 깔 때", () => {
  it("그림을 먼저 칠하고 속성을 나중에 켠다 (요소가 보이는 첫 프레임에 이미 그림이 있다)", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    attach(w);
    const paint = w.log.findIndex((line) => line.startsWith("layer color"));
    const live = w.log.indexOf(`set ${LIVE_ATTRIBUTE}`);
    expect(paint).toBeGreaterThanOrEqual(0);
    expect(live).toBeGreaterThan(paint);
    expect(w.layer.style.backgroundColor).toBe(WALLPAPER_SOLIDS.slate.hex);
    expect(w.layer.style.backgroundImage).toBe("none");
  });

  it("두 모드의 scrim과 보정색을 루트 변수로 꽂는다", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    attach(w);
    const light = wallpaperTreatment(wallpaperTokensOf(THEMES.dawnsky.light), "light");
    expect(w.props.size).toBe(varCount);
    expect(w.props.get(WALLPAPER_VARS.scrim("light"))).toBe(light.scrim);
    expect(w.attrs.get(LIVE_ATTRIBUTE)).toBe("");
    expect(w.runtime.getPlan().decision.live).toBe(true);
  });

  it("입력이 같으면 DOM을 다시 쓰지 않는다 (서명이 같다): 루트 변경 신호가 여러 번 와도 쓰기는 한 번이다", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    attach(w);
    const writes = w.log.length;
    w.fire.root();
    w.fire.root();
    w.fire.appearance();
    expect(w.log.length).toBe(writes);
  });
});

describe("깔리지 않을 때는 루트에 아무것도 남기지 않는다", () => {
  it("고른 것이 없다", () => {
    const w = world();
    attach(w);
    expect(w.attrs.size).toBe(0);
    expect(w.props.size).toBe(0);
    expect(w.layer.style.backgroundColor).toBe("");
    expect(w.runtime.getPlan().decision).toEqual({ live: false, reason: null });
  });

  it("고르면 켜지고 「기본으로」를 누르면 속성·변수·그림이 모두 걷힌다 (잔존 0)", () => {
    const w = world();
    attach(w);
    w.appearance.wallpaper = { kind: "preset", id: "bam" };
    w.fire.appearance();
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(true);
    expect(w.props.size).toBe(varCount);
    delete w.appearance.wallpaper;
    w.fire.appearance();
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(false);
    expect(w.props.size).toBe(0);
    expect(w.layer.style.backgroundColor).toBe("");
    expect(w.layer.style.backgroundImage).toBe("");
  });

  it("속성을 먼저 끄고 그림을 걷는다", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    attach(w);
    w.log.length = 0;
    delete w.appearance.wallpaper;
    w.fire.appearance();
    expect(w.log.indexOf(`remove ${LIVE_ATTRIBUTE}`)).toBeLessThan(w.log.findIndex((line) => line.startsWith("layer color")));
  });

  it("시스템 접근성이 켜지면 선택은 남고 그림·변수가 걷히고 이유가 계획에 선다, 꺼지면 돌아온다", () => {
    const w = world("dawnsky", { kind: "preset", id: "bam" });
    attach(w);
    w.flags.reduceTransparency = true;
    w.fire.reduce();
    expect(w.appearance.wallpaper).toEqual({ kind: "preset", id: "bam" });
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(false);
    expect(w.props.size).toBe(0);
    expect(w.runtime.getPlan().decision).toEqual({ live: false, reason: "reduce-transparency" });
    w.flags.reduceTransparency = false;
    w.flags.increaseContrast = true;
    w.fire.reduce();
    w.fire.contrast();
    expect(w.runtime.getPlan().decision.reason).toBe("increase-contrast");
    w.flags.increaseContrast = false;
    w.fire.contrast();
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(true);
    expect(w.props.size).toBe(varCount);
  });

  it("떼면(로그아웃으로 셸이 사라지면) 루트에 속성·변수·그림이 하나도 남지 않고 계획도 비운다", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    attach(w);
    const seen = vi.fn();
    w.runtime.subscribe(seen);
    w.runtime.detach();
    expect(w.attrs.size).toBe(0);
    expect(w.props.size).toBe(0);
    expect(w.layer.style.backgroundColor).toBe("");
    expect(w.runtime.getPlan().decision.live).toBe(false);
    expect(seen).toHaveBeenCalled();
    // 뗀 뒤의 신호는 아무 일도 하지 않는다.
    w.log.length = 0;
    w.fire.appearance();
    w.fire.system();
    expect(w.log).toEqual([]);
  });

  it("모르는 id는 「없음」으로 거두고 아무것도 깔지 않는다", () => {
    const w = world("dawnsky", { kind: "solid", id: "future-color" });
    attach(w);
    expect(w.clearWallpaper).toHaveBeenCalledTimes(1);
    expect(w.attrs.size).toBe(0);
    expect(w.props.size).toBe(0);
  });

  it("테마의 색을 못 읽으면(읽을 수 없는 모양) 깔지 않고 이유를 말한다", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    // 읽을 수 없는 모양(함수형 색)이 입력이다.
    w.cssVars["--agent"] = "rgb(1, 2, 3)"; // design-preflight-allow
    attach(w);
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(false);
    expect(w.runtime.getPlan().decision).toEqual({ live: false, reason: "unresolved" });
  });
});

describe("모드", () => {
  it("루트에 못 박힌 스킴(data-theme)이 시스템 스킴보다 먼저다", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    w.attrs.set("data-theme", "dark");
    attach(w);
    expect(w.runtime.getPlan().mode).toBe("dark");
    expect(w.runtime.getPlan().treatment?.mode).toBe("dark");
  });

  it("못 박힌 것이 없으면 시스템 스킴을 따라가고, 바뀌면 다시 센다 (OS의 다크 전환)", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    attach(w);
    expect(w.runtime.getPlan().mode).toBe("light");
    w.system = "dark";
    w.fire.system();
    expect(w.runtime.getPlan().mode).toBe("dark");
    expect(w.runtime.getPlan().treatment?.alpha).toBeCloseTo(0.76, 5);
  });

  it("한 모드에서만 못 쓰는 테마는 그 모드가 될 때 꺼지고 돌아오면 켜진다", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    // 다크의 잉크를 바닥과 같게 만들어 하한이 95%를 넘게 한다.
    w.cssVars["--ink"] = `light-dark(${THEMES.dawnsky.light.color.ink.toLowerCase()}, ${THEMES.dawnsky.dark.canvas[1].toLowerCase()})`;
    attach(w);
    expect(w.runtime.getPlan().decision.live).toBe(true);
    w.system = "dark";
    w.fire.system();
    expect(w.runtime.getPlan().decision).toEqual({ live: false, reason: "unavailable" });
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(false);
    expect(w.props.size).toBe(0);
    w.system = "light";
    w.fire.system();
    expect(w.runtime.getPlan().decision.live).toBe(true);
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(true);
  });
});

describe("테마의 색이 바뀔 때(파생 테마가 변수를 비동기로 꽂는 경우)", () => {
  it("루트 변경 신호가 오면 새 색으로 다시 센다", () => {
    const w = world("dawnsky", { kind: "solid", id: "slate" });
    attach(w);
    const before = w.props.get(WALLPAPER_VARS.scrim("light"));
    w.cssVars = varsOf("graphite");
    w.fire.root();
    const after = w.props.get(WALLPAPER_VARS.scrim("light"));
    expect(after).not.toBe(before);
    expect(after).toBe(wallpaperTreatment(wallpaperTokensOf(THEMES.graphite.light), "light").scrim);
  });

  it("띠가 있는 테마를 읽으면 계획이 그것을 말한다", () => {
    const w = world("noeul", { kind: "solid", id: "slate" });
    attach(w);
    expect(w.runtime.getPlan().hasBand).toBe(true);
  });
});

describe("사진", () => {
  const ref: WallpaperRef = { kind: "image", width: 100, height: 80, rev: 3 };

  it("참조가 사진이고 아직 안 읽었으면 읽어 오라고 요청하고, 읽히기 전에는 깔지 않는다", () => {
    const w = world("dawnsky", ref);
    attach(w);
    expect(w.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(false);
    expect(w.runtime.getPlan().decision.reason).toBe("no-photo");
  });

  it("읽히면 사진을 칠하고 켠다. 같은 번호면 다시 칠하지 않고 번호가 바뀌면 다시 칠한다", () => {
    const w = world("dawnsky", ref);
    attach(w);
    w.photo = { status: "ready", dataUrl: "data:image/jpeg;base64,AAAA", thumb: null, rev: 3 };
    w.fire.photo();
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(true);
    expect(w.layer.style.backgroundImage).toBe('url("data:image/jpeg;base64,AAAA")');
    const paints = () => w.log.filter((line) => line.startsWith("layer image")).length;
    expect(paints()).toBe(1);
    w.fire.photo();
    w.fire.appearance();
    expect(paints()).toBe(1);
    w.photo = { status: "ready", dataUrl: "data:image/jpeg;base64,BBBB", thumb: null, rev: 4 };
    w.fire.photo();
    expect(paints()).toBe(2);
    expect(w.layer.style.backgroundImage).toBe('url("data:image/jpeg;base64,BBBB")');
  });

  it("사진을 잃으면(없음) 꺼진다", () => {
    const w = world("dawnsky", ref);
    w.photo = { status: "ready", dataUrl: "data:image/jpeg;base64,AAAA", thumb: null, rev: 3 };
    attach(w);
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(true);
    w.photo = { status: "none" };
    w.fire.photo();
    expect(w.attrs.has(LIVE_ATTRIBUTE)).toBe(false);
    expect(w.layer.style.backgroundImage).toBe("");
  });
});

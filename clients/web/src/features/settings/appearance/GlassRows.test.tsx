// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { firstPartyGlassSources, type GlassSource, type GlassSources } from "@momo/core/design/glass";
import type { ThemeRef } from "@momo/core/design/themeResolve";
import { THEMES } from "@momo/core/design/themes";
import {
  getAppearance,
  reloadAppearanceForTest,
  subscribeSystemScheme,
  subscribeTheme,
  systemScheme,
  updateAppearance,
} from "@/design/theme";
import { GLASS_ROWS_OPEN, GlassRows } from "./GlassRows";
import { GLASS_COPY } from "./glassCopy";
import {
  createDesktopEffects,
  setDesktopEffectsForTest,
  type DesktopEffects,
  type DesktopEffectsDeps,
} from "./desktopEffects";
import { FakeMedia, fromChannels } from "./desktopEffectsTestKit";

// =============================================================================
// AP-3(#4190) AC 3·4·5·9 — 설정 > 모양의 「유리 배경」 행. 행은 창 쪽 일과 **같은 판정**(`resolveGlass`)을 읽는다.
//
// 외양 저장소는 진짜(`@/design/theme`, jsdom localStorage)이고 셸 쪽(네이티브 호출·접근성 질의·플랫폼)만 가짜다.
// 그래서 스위치를 누르면 진짜 저장이 일어나고, 그 저장이 창 쪽 일을 거쳐 행으로 돌아오는 고리 전체가 선다.
// =============================================================================

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mounted: Root | null = null;
let host: HTMLElement | null = null;
let effects: DesktopEffects | null = null;
let stopEffects: (() => void) | null = null;

beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  reloadAppearanceForTest();
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  host?.remove();
  host = null;
  stopEffects?.();
  stopEffects = null;
  effects = null;
  setDesktopEffectsForTest(null);
  document.documentElement.removeAttribute("data-glass");
  document.documentElement.removeAttribute("style");
  localStorage.clear();
  reloadAppearanceForTest();
});

interface Env {
  supported?: boolean;
  vibrancy?: (enabled: boolean) => Promise<boolean>;
  catalog?: Record<string, GlassSources>;
  reduced?: boolean;
}

const nativeCalls: boolean[] = [];

function mount(env: Env = {}): HTMLElement {
  nativeCalls.length = 0;
  const media = new Map<string, FakeMedia>([
    ["(prefers-reduced-transparency: reduce)", new FakeMedia(env.reduced === true)],
    ["(prefers-contrast: more)", new FakeMedia(false)],
  ]);
  const deps: DesktopEffectsDeps = {
    root: () => document.documentElement,
    supported: () => env.supported ?? true,
    setVibrancy: async (enabled) => {
      nativeCalls.push(enabled);
      return env.vibrancy ? env.vibrancy(enabled) : true;
    },
    setAppTheme: async () => true,
    media: (query) => media.get(query) ?? null,
    onWake: () => () => {},
    getAppearance,
    setGlass: (glass) => updateAppearance({ glass }),
    subscribeAppearance: subscribeTheme,
    systemScheme,
    subscribeSystemScheme,
    sources: (ref, signal) => (ref.includes(":") ? (env.catalog?.[ref] ?? null) : firstPartyGlassSources(ref as "dawnsky", signal)),
  };
  effects = createDesktopEffects(deps);
  setDesktopEffectsForTest(effects);
  host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  act(() => mounted?.render(createElement(GlassRows)));
  stopEffects = effects.start();
  return host;
}

/** 비동기 고리(네이티브 호출)가 가라앉은 뒤의 화면. */
async function settled(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

const q = (testId: string): HTMLElement | null => host?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
const toggle = (): HTMLButtonElement => q("glass-background-toggle") as HTMLButtonElement;
const slider = (): HTMLInputElement | null => q("glass-opacity-slider") as HTMLInputElement | null;
const text = (testId: string): string => q(testId)?.textContent ?? "";

function press(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("GlassRows — 행이 열려 있다", () => {
  it("슬롯이 열렸다고 알린다(슬롯 시험의 「아무것도 안 그린다」에서 빠진다)", () => {
    expect(GLASS_ROWS_OPEN).toBe(true);
  });
});

describe("폴백 1: 브라우저·다른 OS (AC 5)", () => {
  it("스위치는 잠기고 꺼진 것으로 보이며 이유를 말한다. 슬라이더는 없다", async () => {
    mount({ supported: false });
    await settled();
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(text("glass-background-row")).toContain(GLASS_COPY.unsupported);
    expect(GLASS_COPY.unsupported).toBe("macOS 데스크탑 앱에서 쓸 수 있어요.");
    expect(slider()).toBeNull();
    expect(nativeCalls).toEqual([]);
  });

  it("저장된 켬이 있어도 유효 값은 꺼짐이고, 저장값은 지우지 않는다", async () => {
    updateAppearance({ glass: { on: true, opacity: 88 } });
    mount({ supported: false });
    await settled();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(slider()).toBeNull();
    expect(getAppearance().glass).toEqual({ on: true, opacity: 88 });
  });
});

describe("지원되는 맥 데스크탑: 켜기·슬라이더 (AC 3·4)", () => {
  it("꺼진 상태: 지원 문장이 서고 스위치가 열려 있고 슬라이더는 없다", async () => {
    mount();
    await settled();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(text("glass-background-row")).toContain(GLASS_COPY.supported);
    expect(slider()).toBeNull();
  });

  it("스위치를 누르면 저장되고, 네이티브가 켜지고, 슬라이더가 열린다", async () => {
    mount();
    await settled();
    act(() => toggle().click());
    await settled();
    expect(getAppearance().glass).toEqual({ on: true });
    expect(nativeCalls).toEqual([true]);
    expect(document.documentElement.hasAttribute("data-glass")).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    const input = slider();
    expect(input).not.toBeNull();
    // 새벽하늘 라이트(jsdom 기본은 시스템 라이트): 하한 70, 최대 95, 기본은 하한이다.
    expect(input?.min).toBe("70");
    expect(input?.max).toBe("95");
    expect(input?.value).toBe("70");
    expect(input?.getAttribute("aria-valuetext")).toBe("70% 불투명");
    expect(text("glass-opacity-value")).toBe("70%");
    expect(text("glass-opacity-row")).toContain("낮출수록 데스크탑이 더 비쳐요. 글자가 읽히도록 이 테마에서는 70% 아래로 내릴 수 없어요.");
  });

  it("키보드: 방향키 한 칸, PageUp·PageDown 열 칸, 하한과 95에서 멈춘다 — 저장·그림이 따라간다", async () => {
    updateAppearance({ glass: { on: true } });
    mount();
    await settled();
    const input = slider() as HTMLInputElement;
    // 기본은 하한(70)이다: 아래로는 움직이지 않는다.
    press(input, "ArrowLeft");
    await settled();
    expect(slider()?.value).toBe("70");
    expect(getAppearance().glass).toEqual({ on: true });
    press(input, "ArrowRight");
    await settled();
    expect(getAppearance().glass).toEqual({ on: true, opacity: 71 });
    expect(document.documentElement.style.getPropertyValue("--glass-tint-light")).toBe("71%");
    press(input, "PageUp");
    await settled();
    expect(getAppearance().glass).toEqual({ on: true, opacity: 81 });
    press(input, "PageDown");
    press(input, "PageDown");
    await settled();
    // 하한 70에서 멈춘다(81 → 71 → 70).
    expect(getAppearance().glass?.opacity).toBe(70);
    expect(slider()?.value).toBe("70");
    expect(slider()?.getAttribute("aria-valuetext")).toBe("70% 불투명");
    press(slider() as HTMLInputElement, "End");
    await settled();
    expect(getAppearance().glass?.opacity).toBe(95);
    expect(text("glass-opacity-value")).toBe("95%");
    press(slider() as HTMLInputElement, "Home");
    await settled();
    expect(slider()?.value).toBe("70");
  });

  it("리셋: 기본값이면 잠겨 있고, 바꾸면 열리고, 누르면 저장된 값을 지워 기본으로 돌아간다", async () => {
    updateAppearance({ glass: { on: true } });
    mount();
    await settled();
    const reset = q("glass-opacity-reset") as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    expect(reset.getAttribute("aria-label")).toBe("기본값으로 되돌리기");
    press(slider() as HTMLInputElement, "ArrowRight");
    await settled();
    expect((q("glass-opacity-reset") as HTMLButtonElement).disabled).toBe(false);
    act(() => (q("glass-opacity-reset") as HTMLButtonElement).click());
    await settled();
    expect(getAppearance().glass).toEqual({ on: true });
    expect(slider()?.value).toBe("70");
    expect((q("glass-opacity-reset") as HTMLButtonElement).disabled).toBe(true);
  });

  it("끄면 슬라이더가 사라지고 불투명도는 남는다(다시 켜면 돌아온다)", async () => {
    updateAppearance({ glass: { on: true, opacity: 91 } });
    mount();
    await settled();
    expect(slider()?.value).toBe("91");
    act(() => toggle().click());
    await settled();
    expect(getAppearance().glass).toEqual({ on: false, opacity: 91 });
    expect(slider()).toBeNull();
    expect(document.documentElement.hasAttribute("data-glass")).toBe(false);
    expect(nativeCalls).toEqual([true, false]);
    act(() => toggle().click());
    await settled();
    expect(slider()?.value).toBe("91");
  });

  it("다크 모드의 하한 78: 저장된 74는 다크에서 78로 올려 보인다", async () => {
    updateAppearance({ scheme: "dark", glass: { on: true, opacity: 74 } });
    mount();
    await settled();
    expect(slider()?.min).toBe("78");
    expect(slider()?.value).toBe("78");
    expect(getAppearance().glass?.opacity).toBe(74);
  });

  it("스위치와 슬라이더에는 행의 라벨과 설명이 걸려 있다", async () => {
    updateAppearance({ glass: { on: true } });
    mount();
    await settled();
    expect(toggle().getAttribute("aria-labelledby")).toBe("glass-background-label");
    expect(toggle().getAttribute("aria-describedby")).toBe("glass-background-description");
    expect(host?.querySelector("#glass-background-label")?.textContent).toBe("유리 배경");
    const input = slider() as HTMLInputElement;
    expect(input.getAttribute("aria-labelledby")).toBe("glass-opacity-label");
    expect(input.getAttribute("aria-describedby")).toBe("glass-opacity-description");
    expect(host?.querySelector("#glass-opacity-label")?.textContent).toBe("유리 불투명도");
  });
});

describe("쓸 수 없는 테마 (AC 4)", () => {
  /** catppuccin-latte 모양: 부드러운 잉크라 하한이 1.00이다. */
  const latte = (): GlassSource => ({
    canvas: [fromChannels(0xef, 0xf1, 0xf5), fromChannels(0xef, 0xf1, 0xf5), fromChannels(0xef, 0xf1, 0xf5)],
    band: null,
    color: { ...THEMES.graphite.light.color, ink: fromChannels(0x4c, 0x4f, 0x69) },
  });

  it("스위치가 잠기고 이유를 말한다. 슬라이더는 없고 네이티브는 켜지 않는다", async () => {
    updateAppearance({ scheme: "light", theme: "catalog:catppuccin" as ThemeRef, glass: { on: true } });
    mount({ catalog: { "catalog:catppuccin": { light: latte(), dark: THEMES.graphite.dark } } });
    await settled();
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(text("glass-background-row")).toContain("이 테마에서는 글자가 읽히도록 유리 배경을 쓸 수 없어요.");
    expect(slider()).toBeNull();
    expect(nativeCalls).toEqual([]);
  });

  it("하한이 95%인 테마는 쓸 수 있고 슬라이더는 한 점이라 잠긴다(경계)", async () => {
    const edge: GlassSource = {
      canvas: [fromChannels(0xf0, 0xf0, 0xf0), fromChannels(0xf0, 0xf0, 0xf0), fromChannels(0xf0, 0xf0, 0xf0)],
      band: null,
      color: { ...THEMES.graphite.light.color, ink: fromChannels(0x49, 0x49, 0x49) },
    };
    updateAppearance({ scheme: "light", theme: "catalog:edge" as ThemeRef, glass: { on: true } });
    mount({ catalog: { "catalog:edge": { light: edge, dark: edge } } });
    await settled();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    const input = slider() as HTMLInputElement;
    expect(input.min).toBe("95");
    expect(input.max).toBe("95");
    expect(input.disabled).toBe(true);
    expect((q("glass-opacity-reset") as HTMLButtonElement).disabled).toBe(true);
    expect(text("glass-opacity-row")).toContain("95% 아래로 내릴 수 없어요");
  });

  it("하한이 96%인 테마는 쓸 수 없다(경계 바로 너머)", async () => {
    const over: GlassSource = {
      canvas: [fromChannels(0xf0, 0xf0, 0xf0), fromChannels(0xf0, 0xf0, 0xf0), fromChannels(0xf0, 0xf0, 0xf0)],
      band: null,
      color: { ...THEMES.graphite.light.color, ink: fromChannels(0x4a, 0x4a, 0x4a) },
    };
    updateAppearance({ scheme: "light", theme: "catalog:over" as ThemeRef, glass: { on: true } });
    mount({ catalog: { "catalog:over": { light: over, dark: over } } });
    await settled();
    expect(toggle().disabled).toBe(true);
    expect(text("glass-background-row")).toContain(GLASS_COPY.unusable);
  });
});

describe("배경화면과의 공존 (결정 9, AC 9)", () => {
  it("배경화면이 켜져 있으면 스위치가 잠기고 문장으로 이유를 말한다. 끄면 돌아온다", async () => {
    updateAppearance({ glass: { on: true }, wallpaper: { kind: "solid", id: "slate" } });
    mount();
    await settled();
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(text("glass-background-row")).toContain(GLASS_COPY.wallpaper);
    expect(slider()).toBeNull();
    expect(nativeCalls).toEqual([]);
    act(() => updateAppearance({ wallpaper: undefined }));
    await settled();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(slider()).not.toBeNull();
  });
});

describe("폴백 3: 켜기 실패 (AC 5)", () => {
  it("행 안의 문장으로 말하고(토스트 아님), 스위치는 꺼진 채 열려 있고, 저장된 켬은 꺼진다", async () => {
    mount({ vibrancy: async (enabled) => !enabled });
    await settled();
    act(() => toggle().click());
    await settled();
    expect(nativeCalls).toEqual([true, false]);
    expect(getAppearance().glass).toBeUndefined();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(false);
    const failed = q("glass-background-failed");
    expect(failed?.textContent).toBe("이 기기에서는 유리 배경을 켜지 못했어요.");
    expect(failed?.getAttribute("role")).toBe("status");
    expect(slider()).toBeNull();
    expect(document.documentElement.hasAttribute("data-glass")).toBe(false);
  });

  it("다시 누르면 새 시도다: 이번엔 되면 문장이 사라지고 슬라이더가 열린다", async () => {
    let refuse = true;
    mount({ vibrancy: async (enabled) => (enabled ? !refuse : true) });
    await settled();
    act(() => toggle().click());
    await settled();
    expect(q("glass-background-failed")).not.toBeNull();
    refuse = false;
    act(() => toggle().click());
    await settled();
    expect(q("glass-background-failed")).toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(slider()).not.toBeNull();
    expect(document.documentElement.hasAttribute("data-glass")).toBe(true);
  });
});

describe("폴백 2: 투명도 줄이기·고대비 (AC 5)", () => {
  it("스위치는 켠 채로 두고 문장으로 이유를 말한다. 슬라이더는 걷는다(눌러도 안 바뀌는 컨트롤은 없다)", async () => {
    updateAppearance({ glass: { on: true } });
    mount({ reduced: true });
    await settled();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(toggle().disabled).toBe(false);
    expect(text("glass-background-row")).toContain("시스템 설정이 투명 효과를 끄고 있어요.");
    expect(slider()).toBeNull();
    expect(document.documentElement.hasAttribute("data-glass")).toBe(false);
    // 네이티브는 깔린 채다: 질의가 풀리면 호출 없이 그린다.
    expect(nativeCalls).toEqual([true]);
  });

  it("그 상태에서도 스위치를 눌러 끌 수 있다", async () => {
    updateAppearance({ glass: { on: true } });
    mount({ reduced: true });
    await settled();
    act(() => toggle().click());
    await settled();
    expect(getAppearance().glass).toBeUndefined();
    expect(nativeCalls).toEqual([true, false]);
  });
});

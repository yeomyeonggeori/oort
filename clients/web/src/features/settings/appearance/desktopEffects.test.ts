import { describe, expect, it } from "vitest";
import { GLASS_VARS, firstPartyGlassSources, type GlassSource, type GlassSources } from "@momo/core/design/glass";
import type { ThemeRef } from "@momo/core/design/themeResolve";
import { THEMES } from "@momo/core/design/themes";
import { GLASS_ATTRIBUTE, computeView } from "./desktopEffects";
import { Deferred, makeEnv, fromChannels, settle } from "./desktopEffectsTestKit";

// =============================================================================
// AP-3(#4190) AC 3·5·7 — 창 쪽 일의 순서와 폴백 세 갈래를 가짜 환경으로 잰다.
//
// 진짜 셸 없이도 규칙이 선다: DOM 조작과 네이티브 호출이 **한 줄의 기록**(`log`)에 섞여 쌓이므로 「블러가 선 뒤에
// `data-glass`」, 「`data-glass`를 걷은 뒤에 블러」 같은 순서를 문자열로 단정한다. 네이티브 호출은 시험이 쥔
// 약속(`Deferred`)이라 끝나기 전에 다른 입력을 넣어 경쟁 상태를 만든다. 도구는 `desktopEffectsTestKit.ts`다.
// =============================================================================

const ON = { on: true } as const;

describe("computeView — 설정 행과 창 쪽 일이 함께 읽는 판정", () => {
  const sources = firstPartyGlassSources("dawnsky");
  const base = { supported: true, failed: false, reducedTransparency: false, mode: "light" as const, sources };

  it("켬: 하한 70(새벽하늘 라이트), 저장이 없으면 기본은 하한 70, 슬라이더 값은 하한에 맞춘다", () => {
    const view = computeView({ glass: ON, wallpaper: undefined }, base);
    expect(view.decision).toMatchObject({ reason: null, checked: true, paintWanted: true });
    expect(view.range).toEqual({ usable: true, min: 70, max: 95, defaultPercent: 70 });
    expect(view.opacity).toBe(70);
    expect(computeView({ glass: { on: true, opacity: 50 }, wallpaper: undefined }, base).opacity).toBe(70);
    expect(computeView({ glass: { on: true, opacity: 99 }, wallpaper: undefined }, base).opacity).toBe(95);
  });

  it("모드마다 하한이 다르다(다크 78)", () => {
    const view = computeView({ glass: ON, wallpaper: undefined }, { ...base, mode: "dark" });
    expect(view.range?.min).toBe(78);
    expect(view.opacity).toBe(78);
  });

  it("색을 못 읽은 테마(조회 없음)는 범위가 없고 켠 채로 기다린다", () => {
    const view = computeView({ glass: ON, wallpaper: undefined }, { ...base, sources: null });
    expect(view.range).toBeNull();
    expect(view.opacity).toBeNull();
    expect(view.decision).toMatchObject({ reason: null, checked: true, nativeWanted: false, paintWanted: false });
  });

  it("배경화면이 있으면 유리는 잠긴다(결정 9)", () => {
    const view = computeView({ glass: ON, wallpaper: { kind: "solid", id: "slate" } }, base);
    expect(view.decision).toMatchObject({ reason: "wallpaper", toggleDisabled: true, checked: false });
  });

  it("단일 모드 테마에서 모드가 어긋나면 있는 모드를 쓴다", () => {
    const onlyDark: GlassSources = { dark: firstPartyGlassSources("graphite").dark as GlassSource };
    const view = computeView({ glass: ON, wallpaper: undefined }, { ...base, mode: "light", sources: onlyDark });
    expect(view.range?.min).toBe(73);
  });
});

describe("미지원(폴백 1): 브라우저·다른 OS", () => {
  it("아무것도 하지 않는다: 네이티브 호출 0, 루트 변경 0, 앱 테마 호출 0", async () => {
    const env = makeEnv({ supported: false, glass: ON });
    env.effects.start();
    await settle();
    expect(env.log).toEqual([]);
    expect(env.effects.getSnapshot().view.decision).toMatchObject({
      reason: "unsupported",
      toggleDisabled: true,
      checked: false,
    });
    expect(env.effects.getSnapshot().status).toMatchObject({ supported: false, painted: false, native: false });
  });
});

describe("켜기와 끄기의 순서 (AC 3)", () => {
  it("켜기: 네이티브가 선 뒤에야 변수 → 인라인 투명 → data-glass 순으로 꽂는다", async () => {
    const pending = new Deferred<boolean>();
    const env = makeEnv({ glass: ON, vibrancy: (enabled) => (enabled ? pending.promise : Promise.resolve(true)) });
    env.effects.start();
    await settle();
    // 네이티브가 아직 답하지 않았다: 루트는 한 글자도 안 바뀌었다.
    expect(env.log).toEqual(["native:on"]);
    expect(env.painted()).toBe(false);
    pending.resolve(true);
    await settle();
    const after = env.log.slice(1);
    const firstAttr = after.indexOf(`attr+${GLASS_ATTRIBUTE}`);
    expect(firstAttr).toBeGreaterThan(0);
    // 속성 앞에는 변수와 인라인 투명뿐이고, 속성이 마지막이다.
    expect(after.slice(0, firstAttr).every((entry) => entry === "var+" || entry === "bg+")).toBe(true);
    expect(after.slice(0, firstAttr)).toContain("bg+");
    expect(after[after.length - 1]).toBe(`attr+${GLASS_ATTRIBUTE}`);
    expect(env.painted()).toBe(true);
    expect(env.root.vars.get("background")).toBe("transparent");
    expect(env.root.vars.get(GLASS_VARS.tintLight)).toBe("70%");
    expect(env.root.vars.get(GLASS_VARS.tintDark)).toBe("78%");
    expect(env.effects.getSnapshot().status).toMatchObject({ native: true, painted: true });
  });

  it("끄기: data-glass를 먼저 걷고, 인라인 투명과 변수를 거둔 뒤에 네이티브를 거둔다", async () => {
    const env = makeEnv({ glass: ON });
    env.effects.start();
    await settle();
    expect(env.painted()).toBe(true);
    const painted = env.log.length;
    env.set({ glass: undefined });
    await settle();
    const off = env.log.slice(painted);
    expect(off[0]).toBe(`attr-${GLASS_ATTRIBUTE}`);
    expect(off.indexOf("native:off")).toBeGreaterThan(off.indexOf(`attr-${GLASS_ATTRIBUTE}`));
    expect(off.indexOf("native:off")).toBeGreaterThan(off.lastIndexOf("bg-"));
    expect(off.indexOf("native:off")).toBeGreaterThan(off.lastIndexOf("var-"));
    expect(env.painted()).toBe(false);
    expect(env.root.vars.size).toBe(0);
    expect(env.nativeCalls).toEqual([true, false]);
  });

  it("처음부터 꺼져 있으면 네이티브도 루트도 건드리지 않는다", async () => {
    const env = makeEnv({});
    env.effects.start();
    await settle();
    expect(env.log).toEqual([]);
  });

  it("start는 한 번이다: 두 번 불러도 구독이 겹치지 않고 네이티브는 한 번만 켠다", async () => {
    const env = makeEnv({ glass: ON });
    const stop = env.effects.start();
    env.effects.start();
    await settle();
    expect(env.nativeCalls).toEqual([true]);
    stop();
    env.set({ glass: undefined });
    await settle();
    // 구독을 풀었으므로 저장소가 바뀌어도 더는 따르지 않는다.
    expect(env.nativeCalls).toEqual([true]);
  });
});

describe("경쟁 상태 — 마지막 바람이 이긴다", () => {
  it("켜는 중에 끄면: 켜기가 끝난 뒤 한 번도 그리지 않고 네이티브를 거둔다", async () => {
    const gate = new Deferred<boolean>();
    const env = makeEnv({ glass: ON, vibrancy: (enabled) => (enabled ? gate.promise : Promise.resolve(true)) });
    env.effects.start();
    await settle();
    env.set({ glass: undefined });
    await settle();
    expect(env.painted()).toBe(false);
    gate.resolve(true);
    await settle();
    expect(env.painted()).toBe(false);
    expect(env.log.includes(`attr+${GLASS_ATTRIBUTE}`)).toBe(false);
    expect(env.nativeCalls).toEqual([true, false]);
    expect(env.effects.getSnapshot().status.native).toBe(false);
  });

  it("끄는 중에 켜면: 끄기가 끝난 뒤 다시 켜서 그린다", async () => {
    const gate = new Deferred<boolean>();
    const env = makeEnv({ glass: ON, vibrancy: (enabled) => (enabled ? Promise.resolve(true) : gate.promise) });
    env.effects.start();
    await settle();
    expect(env.painted()).toBe(true);
    env.set({ glass: undefined });
    await settle();
    expect(env.nativeCalls).toEqual([true, false]);
    env.set({ glass: ON });
    await settle();
    gate.resolve(true);
    await settle();
    expect(env.nativeCalls).toEqual([true, false, true]);
    expect(env.painted()).toBe(true);
  });

  it("켜고 끄고 켜기를 연달아 해도 네이티브 호출은 서로 겹치지 않고 마지막 상태로 끝난다", async () => {
    let inFlight = 0;
    let overlapped = false;
    const env = makeEnv({
      glass: ON,
      vibrancy: async () => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return true;
      },
    });
    env.effects.start();
    env.set({ glass: undefined });
    env.set({ glass: ON });
    env.set({ glass: undefined });
    env.set({ glass: ON });
    await settle();
    expect(overlapped).toBe(false);
    expect(env.effects.getSnapshot().status).toMatchObject({ native: true, painted: true });
    expect(env.nativeCalls[env.nativeCalls.length - 1]).toBe(true);
  });
});

describe("켜기 실패(폴백 3)", () => {
  it("거절되면: 반쯤 깔린 층을 거두고, 저장된 켬을 끄고, 그리지 않고, 문장을 남긴다", async () => {
    const env = makeEnv({ glass: { on: true, opacity: 82 }, vibrancy: async (enabled) => !enabled });
    env.effects.start();
    await settle();
    expect(env.painted()).toBe(false);
    // 켜기(거절) → 거두기(성공).
    expect(env.nativeCalls).toEqual([true, false]);
    expect(env.appearance().glass).toEqual({ on: false, opacity: 82 });
    const snap = env.effects.getSnapshot();
    expect(snap.status).toMatchObject({ failed: true, native: false, painted: false });
    expect(snap.view.decision).toMatchObject({ reason: "failed", checked: false, toggleDisabled: false });
    expect(env.appThemeCalls).toEqual([]);
  });

  it("사람이 다시 켜면(기억을 지우고) 새 시도를 한다. 이번엔 성공하면 그린다", async () => {
    let refuse = true;
    const env = makeEnv({ glass: ON, vibrancy: async (enabled) => (enabled ? !refuse : true) });
    env.effects.start();
    await settle();
    expect(env.effects.getSnapshot().status.failed).toBe(true);
    refuse = false;
    env.effects.clearFailure();
    expect(env.effects.getSnapshot().status.failed).toBe(false);
    env.set({ glass: ON });
    await settle();
    expect(env.painted()).toBe(true);
    expect(env.effects.getSnapshot().view.decision.reason).toBeNull();
  });

  it("실패는 던지지 않는다: 켜기 호출이 거절돼도 이 고리는 끝나고 다음 입력을 받는다", async () => {
    const env = makeEnv({ glass: ON, vibrancy: async (enabled) => !enabled });
    env.effects.start();
    await settle();
    env.set({ theme: "graphite" });
    await settle();
    expect(env.painted()).toBe(false);
  });
});

describe("투명도 줄이기·고대비(폴백 2)", () => {
  it("시작할 때 이미 켜져 있으면: 켠 채로 두되 네이티브만 깔고 그리지 않는다. 질의가 풀리면 호출 없이 그린다", async () => {
    const env = makeEnv({ glass: ON, reduced: "(prefers-reduced-transparency: reduce)" });
    env.effects.start();
    await settle();
    expect(env.painted()).toBe(false);
    expect(env.nativeCalls).toEqual([true]);
    expect(env.effects.getSnapshot().view.decision).toMatchObject({
      reason: "reduced-transparency",
      checked: true,
      toggleDisabled: false,
    });
    env.medias.get("(prefers-reduced-transparency: reduce)")!.fire(false);
    await settle();
    expect(env.painted()).toBe(true);
    expect(env.nativeCalls).toEqual([true]);
  });

  it("고대비(prefers-contrast: more)로 바뀌면: 그림을 걷되 네이티브는 깔린 채다", async () => {
    const env = makeEnv({ glass: ON });
    env.effects.start();
    await settle();
    expect(env.painted()).toBe(true);
    env.medias.get("(prefers-contrast: more)")!.fire(true);
    await settle();
    expect(env.painted()).toBe(false);
    expect(env.root.vars.size).toBe(0);
    expect(env.effects.getSnapshot().status).toMatchObject({ native: true, reducedTransparency: true });
    expect(env.effects.getSnapshot().view.decision).toMatchObject({
      reason: "reduced-transparency",
      checked: true,
      paintWanted: false,
    });
    // 네이티브는 거두지 않았다: 질의가 풀리면 다시 호출 없이 그린다.
    expect(env.nativeCalls).toEqual([true]);
    env.medias.get("(prefers-contrast: more)")!.fire(false);
    await settle();
    expect(env.painted()).toBe(true);
    expect(env.nativeCalls).toEqual([true]);
  });

  it("prefers-reduced-transparency도 같다(질의 목록의 첫 쪽)", async () => {
    const env = makeEnv({ glass: ON });
    env.effects.start();
    await settle();
    env.medias.get("(prefers-reduced-transparency: reduce)")!.fire(true);
    await settle();
    expect(env.painted()).toBe(false);
    expect(env.effects.getSnapshot().view.decision.reason).toBe("reduced-transparency");
  });

  it("WKWebView가 change를 안 쏠 때: 창이 깨어날 때 다시 읽는다", async () => {
    const env = makeEnv({ glass: ON });
    env.effects.start();
    await settle();
    expect(env.painted()).toBe(true);
    // 이벤트 없이 값만 바뀐다.
    env.medias.get("(prefers-contrast: more)")!.matches = true;
    expect(env.painted()).toBe(true);
    env.wake();
    await settle();
    expect(env.painted()).toBe(false);
    expect(env.effects.getSnapshot().status.reducedTransparency).toBe(true);
  });
});

describe("배경화면과의 공존 (결정 9, AC 9)", () => {
  it("배경화면이 켜지면: 그림을 걷고 네이티브를 거둔다. 끄면 저장된 켬이 돌아온다(지우지 않았다)", async () => {
    const env = makeEnv({ glass: { on: true, opacity: 90 } });
    env.effects.start();
    await settle();
    expect(env.painted()).toBe(true);
    env.set({ wallpaper: { kind: "preset", id: "dawn" } });
    await settle();
    expect(env.painted()).toBe(false);
    expect(env.nativeCalls).toEqual([true, false]);
    expect(env.appearance().glass).toEqual({ on: true, opacity: 90 });
    expect(env.effects.getSnapshot().view.decision).toMatchObject({ reason: "wallpaper", toggleDisabled: true });
    env.set({ wallpaper: undefined });
    await settle();
    expect(env.painted()).toBe(true);
    expect(env.root.vars.get(GLASS_VARS.tintLight)).toBe("90%");
  });
});

describe("쓸 수 없는 테마 (AC 4)", () => {
  /** catppuccin-latte 모양: 부드러운 잉크라 하한이 1.00이다. */
  const latte = (): GlassSource => ({
    canvas: [fromChannels(0xef, 0xf1, 0xf5), fromChannels(0xef, 0xf1, 0xf5), fromChannels(0xef, 0xf1, 0xf5)],
    band: null,
    color: { ...THEMES.graphite.light.color, ink: fromChannels(0x4c, 0x4f, 0x69) },
  });

  it("스위치가 잠기고 네이티브를 켜지도 그리지도 않는다. 저장된 켬은 지우지 않는다", async () => {
    const env = makeEnv({
      glass: ON,
      theme: "catalog:catppuccin" as ThemeRef,
      catalog: { "catalog:catppuccin": { light: latte(), dark: THEMES.graphite.dark } },
      scheme: "light",
    });
    env.effects.start();
    await settle();
    expect(env.log).toEqual([]);
    expect(env.effects.getSnapshot().view.decision).toMatchObject({
      reason: "unusable",
      toggleDisabled: true,
      checked: false,
    });
    expect(env.effects.getSnapshot().view.range?.usable).toBe(false);
    expect(env.appearance().glass).toEqual(ON);
  });

  it("같은 테마의 쓸 수 있는 모드(다크)로 바꾸면 그린다: 하한은 모드마다 다르다", async () => {
    const env = makeEnv({
      glass: ON,
      theme: "catalog:catppuccin" as ThemeRef,
      catalog: { "catalog:catppuccin": { light: latte(), dark: THEMES.graphite.dark } },
      scheme: "light",
    });
    env.effects.start();
    await settle();
    expect(env.painted()).toBe(false);
    env.set({ scheme: "dark" });
    await settle();
    expect(env.painted()).toBe(true);
    expect(env.effects.getSnapshot().view.range?.min).toBe(73);
  });
});

describe("테마의 색을 아직 못 읽은 동안", () => {
  it("파생 테마 조회가 없으면 켠 채로 기다리고 네이티브·그림은 하지 않는다. 조회가 오면 그린다", async () => {
    const catalog: Record<string, GlassSources> = {};
    const env = makeEnv({ glass: ON, theme: "catalog:nord" as ThemeRef, catalog });
    env.effects.start();
    await settle();
    expect(env.log).toEqual([]);
    expect(env.effects.getSnapshot().view.decision).toMatchObject({ checked: true, paintWanted: false });
    catalog["catalog:nord"] = firstPartyGlassSources("graphite");
    env.effects.refresh();
    await settle();
    expect(env.painted()).toBe(true);
  });
});

describe("앱 네이티브 appearance (AC 7)", () => {
  it("그리는 동안 색 모드가 고정이면 그 스킴으로 맞추고, 바뀌면 따라가고, 시스템이나 끄기에서는 system으로 돌려준다", async () => {
    const env = makeEnv({ glass: ON, scheme: "dark" });
    env.effects.start();
    await settle();
    expect(env.appThemeCalls).toEqual(["dark"]);
    env.set({ scheme: "light" });
    await settle();
    expect(env.appThemeCalls).toEqual(["dark", "light"]);
    env.set({ scheme: "system" });
    await settle();
    expect(env.appThemeCalls).toEqual(["dark", "light", "system"]);
    env.set({ scheme: "dark" });
    await settle();
    expect(env.appThemeCalls).toEqual(["dark", "light", "system", "dark"]);
    env.set({ glass: undefined });
    await settle();
    expect(env.appThemeCalls).toEqual(["dark", "light", "system", "dark", "system"]);
  });

  it("그리지 않는 동안에는 부르지 않는다: 꺼짐·시스템 모드·투명도 줄이기", async () => {
    const off = makeEnv({ scheme: "dark" });
    off.effects.start();
    await settle();
    expect(off.appThemeCalls).toEqual([]);

    const system = makeEnv({ glass: ON });
    system.effects.start();
    await settle();
    expect(system.painted()).toBe(true);
    expect(system.appThemeCalls).toEqual([]);

    const reduced = makeEnv({ glass: ON, scheme: "dark" });
    reduced.effects.start();
    await settle();
    expect(reduced.appThemeCalls).toEqual(["dark"]);
    reduced.medias.get("(prefers-contrast: more)")!.fire(true);
    await settle();
    expect(reduced.appThemeCalls).toEqual(["dark", "system"]);
  });

  it("같은 값을 되풀이해 보내지 않는다(불투명도를 끄는 동안 수십 번 바뀌어도 한 번)", async () => {
    const env = makeEnv({ glass: ON, scheme: "dark" });
    env.effects.start();
    await settle();
    for (let value = 78; value <= 95; value += 1) {
      env.set({ glass: { on: true, opacity: value } });
      await settle();
    }
    expect(env.appThemeCalls).toEqual(["dark"]);
    expect(env.nativeCalls).toEqual([true]);
  });
});

describe("값이 바뀌면 다시 꽂는다", () => {
  it("불투명도: 변수가 바뀌고 네이티브는 다시 부르지 않는다", async () => {
    const env = makeEnv({ glass: ON });
    env.effects.start();
    await settle();
    expect(env.root.vars.get(GLASS_VARS.tintLight)).toBe("70%");
    env.set({ glass: { on: true, opacity: 93 } });
    await settle();
    expect(env.root.vars.get(GLASS_VARS.tintLight)).toBe("93%");
    expect(env.root.vars.get(GLASS_VARS.tintDark)).toBe("93%");
    expect(env.nativeCalls).toEqual([true]);
  });

  it("하한 아래로 저장돼 있으면 모드마다 하한으로 올려 그린다(저장값은 그대로)", async () => {
    const env = makeEnv({ glass: { on: true, opacity: 72 } });
    env.effects.start();
    await settle();
    expect(env.root.vars.get(GLASS_VARS.tintLight)).toBe("72%");
    expect(env.root.vars.get(GLASS_VARS.tintDark)).toBe("78%");
    expect(env.appearance().glass).toEqual({ on: true, opacity: 72 });
  });

  it("테마·강조색이 바뀌면 보정 색이 다시 꽂힌다", async () => {
    const env = makeEnv({ glass: ON });
    env.effects.start();
    await settle();
    const before = env.root.vars.get(GLASS_VARS.role("signal"));
    env.set({ signal: { preset: "seongun" } });
    await settle();
    expect(env.root.vars.get(GLASS_VARS.role("signal"))).not.toBe(before);
    const dawn = env.root.vars.get(GLASS_VARS.tintDark);
    env.set({ theme: "graphite" });
    await settle();
    expect(env.root.vars.get(GLASS_VARS.tintDark)).not.toBe(dawn);
    expect(env.painted()).toBe(true);
  });

  it("그리는 동안 이름이 줄어든 변수는 걷는다(남은 변수 0)", async () => {
    const env = makeEnv({ glass: ON });
    env.effects.start();
    await settle();
    const names = new Set(env.root.vars.keys());
    env.set({ glass: undefined });
    await settle();
    for (const name of names) expect(env.root.vars.has(name), name).toBe(false);
  });
});

describe("스냅샷 — 설정 행의 입력", () => {
  it("바뀔 때만 알리고, 바뀌지 않으면 같은 객체를 돌려준다", async () => {
    const env = makeEnv({});
    env.effects.start();
    await settle();
    let calls = 0;
    const off = env.effects.subscribe(() => {
      calls += 1;
    });
    const first = env.effects.getSnapshot();
    env.set({ density: "compact" });
    await settle();
    expect(env.effects.getSnapshot()).toBe(first);
    expect(calls).toBe(0);
    env.set({ glass: ON });
    await settle();
    expect(calls).toBeGreaterThan(0);
    expect(env.effects.getSnapshot()).not.toBe(first);
    off();
  });

  it("시스템 스킴이 바뀌면 모드가 따라간다(고정이 없을 때)", async () => {
    const env = makeEnv({ glass: ON, system: "light" });
    env.effects.start();
    await settle();
    expect(env.effects.getSnapshot().view.mode).toBe("light");
    expect(env.effects.getSnapshot().view.range?.min).toBe(70);
    env.setSystem("dark");
    await settle();
    expect(env.effects.getSnapshot().view.mode).toBe("dark");
    expect(env.effects.getSnapshot().view.range?.min).toBe(78);
  });
});

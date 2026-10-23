import { afterEach, describe, expect, it, vi } from "vitest";

// AP-3(#4190): `setWindowVibrancy`·`setAppTheme`는 맥 데스크탑 셸에서만 Rust 명령을 부르고, 그 밖에서는
// `@tauri-apps/api/core`를 요청하지도 않는다. 실패는 던지지 않고 `false`로 돌려준다(행이 문장으로 말한다).

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./env");
  vi.doUnmock("@tauri-apps/api/core");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load(options: { tauri: boolean; platform?: string; invoke?: Invoke }) {
  vi.resetModules();
  const call = vi.fn<Invoke>(options.invoke ?? (() => Promise.resolve(undefined)));
  const core = vi.fn(() => ({ invoke: call }));
  vi.doMock("@tauri-apps/api/core", core);
  vi.doMock("./env", async (original) => ({
    ...(await original<typeof import("./env")>()),
    IS_TAURI: options.tauri,
  }));
  vi.stubGlobal("navigator", { platform: options.platform ?? "MacIntel", userAgent: "" });
  const tauri = await import("./tauri");
  return { tauri, call, core };
}

describe("isMacDesktop", () => {
  it("셸이 아니면 거짓이다(브라우저 탭은 맥이어도)", async () => {
    const { tauri } = await load({ tauri: false, platform: "MacIntel" });
    expect(tauri.isMacDesktop()).toBe(false);
  });

  it("셸 + 맥 플랫폼이면 참, 셸 + 다른 OS면 거짓이다", async () => {
    expect((await load({ tauri: true, platform: "MacIntel" })).tauri.isMacDesktop()).toBe(true);
    expect((await load({ tauri: true, platform: "Win32" })).tauri.isMacDesktop()).toBe(false);
    expect((await load({ tauri: true, platform: "Linux x86_64" })).tauri.isMacDesktop()).toBe(false);
  });
});

describe("setWindowVibrancy", () => {
  it("브라우저 탭: 거짓을 돌려주고 Tauri core 모듈을 요청하지 않는다", async () => {
    const { tauri, call, core } = await load({ tauri: false });
    expect(await tauri.setWindowVibrancy(true)).toBe(false);
    expect(await tauri.setWindowVibrancy(false)).toBe(false);
    expect(core).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("셸이지만 맥이 아니다: 거짓이다. Rust 명령이 Ok(())만 답하는 곳에서 켜졌다고 말하지 않는다", async () => {
    const { tauri, call } = await load({ tauri: true, platform: "Win32" });
    expect(await tauri.setWindowVibrancy(true)).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("맥 셸: 명령 이름과 인자(`enabled`, 재질 `sidebar`)를 정확히 보내고 참을 돌려준다", async () => {
    const { tauri, call } = await load({ tauri: true });
    expect(await tauri.setWindowVibrancy(true)).toBe(true);
    expect(await tauri.setWindowVibrancy(false)).toBe(true);
    expect(call.mock.calls).toEqual([
      ["window_vibrancy_set", { enabled: true, material: "sidebar" }],
      ["window_vibrancy_set", { enabled: false, material: "sidebar" }],
    ]);
  });

  it("셸이 거절하면(Err) 던지지 않고 거짓을 돌려준다(켜기 실패 갈래)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tauri } = await load({ tauri: true, invoke: () => Promise.reject("no vibrancy") });
    await expect(tauri.setWindowVibrancy(true)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("setAppTheme", () => {
  it("브라우저 탭: 거짓이고 아무것도 요청하지 않는다", async () => {
    const { tauri, call, core } = await load({ tauri: false });
    expect(await tauri.setAppTheme("dark")).toBe(false);
    expect(core).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("셸: 세 값을 그대로 보낸다", async () => {
    const { tauri, call } = await load({ tauri: true });
    for (const scheme of ["light", "dark", "system"] as const) expect(await tauri.setAppTheme(scheme)).toBe(true);
    expect(call.mock.calls).toEqual([
      ["app_theme_set", { scheme: "light" }],
      ["app_theme_set", { scheme: "dark" }],
      ["app_theme_set", { scheme: "system" }],
    ]);
  });

  it("셸이 거절하면 던지지 않고 거짓이다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tauri } = await load({ tauri: true, invoke: () => Promise.reject(new Error("denied")) });
    await expect(tauri.setAppTheme("light")).resolves.toBe(false);
  });
});

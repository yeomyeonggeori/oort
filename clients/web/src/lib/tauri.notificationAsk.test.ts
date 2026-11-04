import { afterEach, describe, expect, it, vi } from "vitest";

// #5196: 「창을 닫아도 메뉴 막대에 남아요」 안내는 창이 막 사라진 순간에 뜬다 — OS 알림 권한을 그때 묻지 않는다(`ask: false`).
// 기존 호출(옵션 없음)은 그대로 한 번 묻는다. 둘 다 `notification_*` 명령 이름·인자까지 글자로 잰다.

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./env");
  vi.doUnmock("@tauri-apps/api/core");
});

async function load(permission: "granted" | "denied" | "default") {
  vi.resetModules();
  const call = vi.fn<Invoke>(async (command) => {
    if (command === "notification_permission") return permission;
    // 묻는다면 사용자가 허용한다고 치자: 묻는지 아닌지가 시험의 요점이다.
    if (command === "notification_request_permission") return "granted";
    if (command === "notification_show") return true;
    return undefined;
  });
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: call }));
  vi.doMock("./env", async (original) => ({
    ...(await original<typeof import("./env")>()),
    IS_TAURI: true,
  }));
  const tauri = await import("./tauri");
  const names = () => call.mock.calls.map((c) => c[0]);
  return { tauri, call, names };
}

describe("showNotification 의 권한", () => {
  it("`ask: false`: 결정된 적 없는 권한(default)을 묻지 않고, 보이지도 않는다", async () => {
    const { tauri, names } = await load("default");
    expect(await tauri.showNotification("t", undefined, { ask: false })).toBe(false);
    expect(names()).toEqual(["notification_permission"]);
  });

  it("`ask: false`: 이미 허용이면 보인다", async () => {
    const { tauri, call } = await load("granted");
    expect(await tauri.showNotification("t", undefined, { ask: false })).toBe(true);
    expect(call).toHaveBeenLastCalledWith("notification_show", { title: "t", body: undefined });
  });

  it("옵션이 없으면 예전 그대로다: 결정된 적 없으면 한 번 묻고 허용되면 보인다", async () => {
    const { tauri, names } = await load("default");
    expect(await tauri.showNotification("t")).toBe(true);
    expect(names()).toEqual(["notification_permission", "notification_request_permission", "notification_show"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

// #5193: 메뉴 막대 아이콘의 상태를 셸에 보내는 길(`setTrayStatus`)과 메뉴에서 고른 것을 받는 길(`onTrayAction`)의 웹 쪽 다리.
// Rust 쪽 명령 이름·인자 모양·이벤트 이름은 `clients/desktop/src-tauri/src/tray.rs` 와 한 짝이다 — 이름이 어긋나면 앱 안에서만
// 조용히 죽으므로(셸이 거절한 상태는 메뉴가 옛 모습에 멈춘다) 여기서 문자 그대로 적는다.

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./env");
  vi.doUnmock("@tauri-apps/api/core");
  vi.doUnmock("@tauri-apps/api/event");
  vi.restoreAllMocks();
});

async function load(options: { tauri: boolean; invoke?: Invoke }) {
  vi.resetModules();
  const call = vi.fn<Invoke>(options.invoke ?? (() => Promise.resolve(undefined)));
  const core = vi.fn(() => ({ invoke: call }));
  vi.doMock("@tauri-apps/api/core", core);
  const unlistenShell = vi.fn();
  const shell: { deliver: ((event: { payload: unknown }) => void) | null; name: string | null } = {
    deliver: null,
    name: null,
  };
  const listen = vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    shell.name = name;
    shell.deliver = handler;
    return Promise.resolve(unlistenShell);
  });
  const eventModule = vi.fn(() => ({ listen }));
  vi.doMock("@tauri-apps/api/event", eventModule);
  vi.doMock("./env", async (original) => ({
    ...(await original<typeof import("./env")>()),
    IS_TAURI: options.tauri,
  }));
  const tauri = await import("./tauri");
  return { tauri, call, core, listen, eventModule, shell, unlistenShell };
}

const status = {
  unread: 3,
  compose: true,
  labels: { running: "Running", none: "Nothing running", newMessage: "New message", open: "Open oort", quit: "Quit oort" },
  running: [{ id: "0", title: "김인턴", state: "Waiting" }],
  more: null,
};

describe("setTrayStatus", () => {
  it("브라우저 탭: 거짓이고 Tauri core 모듈을 요청하지 않는다", async () => {
    const { tauri, call, core } = await load({ tauri: false });
    expect(await tauri.setTrayStatus(status)).toBe(false);
    expect(core).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("셸: `tray_status_set` 에 `{ status }` 하나를 그대로 보낸다", async () => {
    const { tauri, call } = await load({ tauri: true });
    expect(await tauri.setTrayStatus(status)).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("tray_status_set", { status });
  });

  it("수는 셸의 u32가 받는 정수로 다듬는다: 음수·소수·너무 큰 수·숫자가 아닌 값", async () => {
    const sent = async (unread: number) => {
      const { tauri, call } = await load({ tauri: true });
      await tauri.setTrayStatus({ ...status, unread });
      return (call.mock.calls[0]?.[1] as { status: { unread: number } }).status.unread;
    };
    expect(await sent(-3)).toBe(0);
    expect(await sent(2.9)).toBe(2);
    expect(await sent(1e12)).toBe(0xffffffff);
    expect(await sent(Number.NaN)).toBe(0);
    expect(await sent(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("셸이 거절해도(옛 셸·검증 실패) 던지지 않고 거짓을 돌려준다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tauri } = await load({ tauri: true, invoke: () => Promise.reject(new Error("invalid-tray-label")) });
    expect(await tauri.setTrayStatus(status)).toBe(false);
  });
});

describe("onTrayAction", () => {
  it("브라우저 탭: 즉시 no-op 으로 풀리고 이벤트 모듈을 요청하지 않는다", async () => {
    const { tauri, eventModule } = await load({ tauri: false });
    const handler = vi.fn();
    const unlisten = await tauri.onTrayAction(handler);
    expect(() => unlisten()).not.toThrow();
    expect(eventModule).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("셸: `momo:tray-action` 을 듣고 payload 를 읽지 않은 채 그대로 건네며, 해제하면 셸의 해제를 부른다", async () => {
    const { tauri, shell, listen, unlistenShell } = await load({ tauri: true });
    const handler = vi.fn();
    const unlisten = await tauri.onTrayAction(handler);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(shell.name).toBe("momo:tray-action");
    shell.deliver?.({ payload: { action: "run", id: "0" } });
    expect(handler).toHaveBeenCalledWith({ action: "run", id: "0" });
    unlisten();
    expect(unlistenShell).toHaveBeenCalledTimes(1);
  });
});

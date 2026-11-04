import { afterEach, describe, expect, it, vi } from "vitest";

// #5059: 셸이 배너의 클릭을 알려 주는지 묻는 길(`notificationClickSupported`), 클릭을 알려 주는 배너를 띄우는 길
// (`showClickableNotification`), 그 클릭 이벤트를 듣는 길(`onNotificationClick`)의 웹 쪽 다리. Rust 쪽 명령 이름·인자·답 단어는
// `clients/desktop/src-tauri/src/notification.rs` 와 한 짝이다 — 이름이 어긋나면 앱 안에서만 조용히 죽으므로 여기서 문자 그대로 적는다.

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

/** 권한 확인은 허락으로, 나머지 명령은 `answers` 의 값으로 답한다. */
const granted =
  (answers: Record<string, unknown>): Invoke =>
  (command) => {
    if (command === "notification_permission") return Promise.resolve("granted");
    if (command in answers) {
      const answer = answers[command];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    return Promise.resolve(undefined);
  };

describe("notificationClickSupported", () => {
  it("브라우저 탭: 거짓이고 Tauri core 모듈을 요청하지 않는다", async () => {
    const { tauri, call, core } = await load({ tauri: false });
    expect(await tauri.notificationClickSupported()).toBe(false);
    expect(core).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("셸이 `true` 라고 답하면 참이고, 그 밖의 어떤 값도 참이 아니다", async () => {
    expect(
      await (await load({ tauri: true, invoke: () => Promise.resolve(true) })).tauri.notificationClickSupported()
    ).toBe(true);
    for (const answer of [false, undefined, null, "true", 1, {}]) {
      const { tauri } = await load({ tauri: true, invoke: () => Promise.resolve(answer) });
      expect(await tauri.notificationClickSupported(), `답 ${JSON.stringify(answer)}`).toBe(false);
    }
  });

  it("옛 셸(명령이 없어 호출이 거절된다): 던지지 않고 거짓이다 — 옛 어림이 그대로 남는다", async () => {
    const { tauri } = await load({
      tauri: true,
      invoke: () => Promise.reject(new Error("notification_click_supported not allowed")),
    });
    await expect(tauri.notificationClickSupported()).resolves.toBe(false);
  });

  it("한 번만 묻고 기억한다 — 배너를 보내는 쪽과 무장하는 쪽이 같은 답을 쓴다", async () => {
    const { tauri, call } = await load({ tauri: true, invoke: () => Promise.resolve(true) });
    const answers = await Promise.all([
      tauri.notificationClickSupported(),
      tauri.notificationClickSupported(),
    ]);
    answers.push(await tauri.notificationClickSupported());
    expect(answers).toEqual([true, true, true]);
    expect(call.mock.calls).toEqual([["notification_click_supported", undefined]]);
  });
});

describe("showClickableNotification", () => {
  const click = { id: "n-abc-1", target: "/c/0a?msg=ff" };

  it("브라우저 탭: 거절이고 아무것도 부르지 않는다", async () => {
    const { tauri, call } = await load({ tauri: false });
    expect(await tauri.showClickableNotification("제목", "본문", click)).toBe("refused");
    expect(call).not.toHaveBeenCalled();
  });

  it("셸: 명령 이름과 인자(title·body·id·target)를 정확히 보내고, 셸의 답을 그대로 돌려준다", async () => {
    for (const outcome of ["clickable", "plain"] as const) {
      const { tauri, call } = await load({
        tauri: true,
        invoke: granted({ notification_show_clickable: outcome }),
      });
      expect(await tauri.showClickableNotification("제목", "본문", click)).toBe(outcome);
      expect(call).toHaveBeenLastCalledWith("notification_show_clickable", {
        title: "제목",
        body: "본문",
        id: "n-abc-1",
        target: "/c/0a?msg=ff",
      });
    }
  });

  it("OS 권한이 허락이 아니면 셸에 배너를 요청하지 않는다(거절)", async () => {
    const { tauri, call } = await load({
      tauri: true,
      invoke: (command) =>
        Promise.resolve(command === "notification_permission" ? "denied" : "clickable"),
    });
    expect(await tauri.showClickableNotification("제목", undefined, click)).toBe("refused");
    expect(call.mock.calls.map((c) => c[0])).not.toContain("notification_show_clickable");
  });

  it("셸이 알 수 없는 말을 하거나 거절하면 던지지 않고 거절로 읽는다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const unknown = await load({ tauri: true, invoke: granted({ notification_show_clickable: "maybe" }) });
    expect(await unknown.tauri.showClickableNotification("제목", undefined, click)).toBe("refused");
    const thrown = await load({
      tauri: true,
      invoke: granted({ notification_show_clickable: new Error("boom") }),
    });
    expect(await thrown.tauri.showClickableNotification("제목", undefined, click)).toBe("refused");
  });
});

describe("onNotificationClick", () => {
  it("브라우저 탭: 즉시 no-op 으로 풀리고 이벤트 모듈을 요청하지 않는다", async () => {
    const { tauri, eventModule } = await load({ tauri: false });
    const handler = vi.fn();
    const unlisten = await tauri.onNotificationClick(handler);
    expect(() => unlisten()).not.toThrow();
    expect(eventModule).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("셸: `momo:notification-click` 을 듣고 payload 를 그대로 건네며, 해제하면 셸의 해제를 부른다", async () => {
    const { tauri, shell, listen, unlistenShell } = await load({ tauri: true });
    const handler = vi.fn();
    const unlisten = await tauri.onNotificationClick(handler);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(shell.name).toBe("momo:notification-click");
    shell.deliver?.({ payload: { id: "n-abc-1", target: "/c/0a" } });
    expect(handler).toHaveBeenCalledWith({ id: "n-abc-1", target: "/c/0a" });
    unlisten();
    expect(unlistenShell).toHaveBeenCalledTimes(1);
  });
});

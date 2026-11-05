// @vitest-environment jsdom
// #4508 (ADR-0206 D4): 웹·데스크탑이 「지금 쓰는 중」 신호를 보내는 배선. 주기·멈춤·거절 처리의
// 본체는 core(activityBeat.test.ts)가 재고, 여기서는 실제 창 이벤트(포커스·탭 가시성·입력)에서
// PUT 하나가 나가는지, 입력이 솎아지는지, 마운트 해제가 구독을 푸는지를 잰다.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";

const authedRequest = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/lib/api", async (orig) => ({
  ...(await orig<typeof import("@momo/core/lib/api")>()),
  authedRequest,
}));

const desktop = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/tauri", async (orig) => ({
  ...(await orig<typeof import("@/lib/tauri")>()),
  isDesktop: () => desktop.on,
}));

import {
  ACTIVITY_BEAT_INTERVAL_MS,
  ACTIVITY_IDLE_LIMIT_MS,
  resetActivityBeatForTests,
} from "@momo/core/features/presence/activityBeat";
import { ApiError } from "@momo/core/lib/api";
import { ActivityBeat } from "./ActivityBeat";
import { ACTIVITY_INPUT_THROTTLE_MS, documentActivity } from "./activityPort";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;
let visibility: "visible" | "hidden" = "visible";
let focused = true;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  resetActivityBeatForTests();
  authedRequest.mockReset();
  authedRequest.mockResolvedValue(undefined);
  visibility = "visible";
  focused = true;
  desktop.on = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function sessionFor(workspaceId: string): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function mount(workspaceId = WS): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(createElement(SessionProvider, { value: sessionFor(workspaceId) }, createElement(ActivityBeat)))
  );
}

const input = (name = "keydown") => act(() => void window.dispatchEvent(new Event(name)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const PATH = `/v1/workspaces/${WS}/presence/activity`;

describe("ActivityBeat (웹·데스크탑 셸에 한 벌)", () => {
  it("마운트만으로는 보내지 않고, 첫 입력에서 본문 없는 PUT 하나를 보낸 뒤 주기로 돈다", async () => {
    mount();
    expect(host?.textContent).toBe("");
    await advance(60_000);
    expect(authedRequest).not.toHaveBeenCalled();
    input("pointerdown");
    expect(authedRequest).toHaveBeenCalledTimes(1);
    // 경로·메서드뿐: 본문도 채널 id도 없다(내용 없이 「지금 쓰는 중」만 말한다).
    expect(authedRequest).toHaveBeenCalledWith(PATH, { method: "PUT" });
    await advance(ACTIVITY_BEAT_INTERVAL_MS);
    expect(authedRequest).toHaveBeenCalledTimes(2);
  });

  it("창이 포커스를 잃거나 탭이 가려지면 멈추고, 돌아오면 바로 한 번 보낸다", async () => {
    mount();
    input();
    expect(authedRequest).toHaveBeenCalledTimes(1);
    focused = false;
    act(() => void window.dispatchEvent(new Event("blur")));
    await advance(60_000);
    expect(authedRequest).toHaveBeenCalledTimes(1);
    focused = true;
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(authedRequest).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await advance(60_000);
    expect(authedRequest).toHaveBeenCalledTimes(2);
    visibility = "visible";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(authedRequest).toHaveBeenCalledTimes(3);
  });

  it("마지막 입력 5분 뒤에는 보내지 않는다. 새 입력이 다시 시작한다", async () => {
    mount();
    input();
    await advance(ACTIVITY_IDLE_LIMIT_MS + ACTIVITY_BEAT_INTERVAL_MS);
    const sent = authedRequest.mock.calls.length;
    expect(sent).toBe(20);
    await advance(ACTIVITY_IDLE_LIMIT_MS);
    expect(authedRequest).toHaveBeenCalledTimes(sent);
    input("wheel");
    expect(authedRequest).toHaveBeenCalledTimes(sent + 1);
  });

  it("데스크탑 셸은 hasFocus()가 거짓이어도 앞으로 읽는다(이벤트로만 추적)", async () => {
    desktop.on = true;
    focused = false;
    mount();
    input();
    expect(authedRequest).toHaveBeenCalledTimes(1);
    act(() => void window.dispatchEvent(new Event("blur")));
    await advance(60_000);
    expect(authedRequest).toHaveBeenCalledTimes(1);
  });

  it("옛 서버의 404면 다시 보내지 않고, 403이면 이 세션에서 멈춘다", async () => {
    authedRequest.mockRejectedValue(new ApiError(404, "not found"));
    mount();
    input();
    await advance(ACTIVITY_BEAT_INTERVAL_MS * 4);
    input();
    expect(authedRequest).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    root = null;
    host?.remove();
    resetActivityBeatForTests();
    authedRequest.mockReset();
    authedRequest.mockRejectedValue(new ApiError(403, "forbidden"));
    mount();
    input();
    await advance(ACTIVITY_BEAT_INTERVAL_MS * 4);
    input();
    expect(authedRequest).toHaveBeenCalledTimes(1);
  });

  it("마운트를 해제하면 멈추고 창 이벤트 구독을 모두 푼다", async () => {
    const removed = vi.spyOn(window, "removeEventListener");
    mount();
    input();
    expect(vi.getTimerCount()).toBe(1);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
    const names = removed.mock.calls.map(([name]) => name);
    for (const name of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "focus", "blur"]) {
      expect(names).toContain(name);
    }
    input();
    await advance(ACTIVITY_BEAT_INTERVAL_MS * 3);
    expect(authedRequest).toHaveBeenCalledTimes(1);
  });
});

describe("documentActivity 입력 구독", () => {
  it("입력 알림은 초당 한 번쯤으로 솎아진다(포인터 이동은 수십 번 온다)", async () => {
    const seen = vi.fn();
    const off = documentActivity.subscribeInput(seen);
    for (let i = 0; i < 50; i += 1) window.dispatchEvent(new Event("pointermove"));
    expect(seen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_INPUT_THROTTLE_MS);
    window.dispatchEvent(new Event("keydown"));
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    await vi.advanceTimersByTimeAsync(ACTIVITY_INPUT_THROTTLE_MS);
    window.dispatchEvent(new Event("keydown"));
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("안쪽 핸들러가 전파를 끊어도 입력으로 센다(capture)", () => {
    const seen = vi.fn();
    const off = documentActivity.subscribeInput(seen);
    const inner = document.createElement("button");
    document.body.append(inner);
    inner.addEventListener("keydown", (event) => event.stopPropagation());
    inner.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    inner.remove();
  });
});

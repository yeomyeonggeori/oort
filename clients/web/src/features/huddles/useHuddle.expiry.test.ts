// @vitest-environment jsdom

// #2757 (H-1): the LiveKit join token TTL (600s) must not end a connected
// huddle. LiveKit checks `exp` only when a client connects and refreshes the
// token over the signal channel afterwards, so a client-side timer on
// `expiresAtMs` was the sole reason every huddle ended at 10 minutes.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { huddleErrorCopy } from "@momo/core/features/huddles/huddleModel";

const fetchActiveHuddle = vi.fn();
const startHuddle = vi.fn();
const joinHuddle = vi.fn();
const leaveHuddle = vi.fn();
const leaveHuddleOnPageExit = vi.fn();
const connectHuddleAudio = vi.fn();
const disconnectAudio = vi.fn();

vi.mock("@momo/core/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@momo/core/lib/api")>(
    "@momo/core/lib/api"
  );
  return {
    ...actual,
    fetchActiveHuddle: (...args: unknown[]) => fetchActiveHuddle(...args),
    startHuddle: (...args: unknown[]) => startHuddle(...args),
    joinHuddle: (...args: unknown[]) => joinHuddle(...args),
    leaveHuddle: (...args: unknown[]) => leaveHuddle(...args),
    leaveHuddleOnPageExit: (...args: unknown[]) =>
      leaveHuddleOnPageExit(...args),
  };
});

vi.mock("./huddleRuntimeLoader", () => ({
  loadHuddleRuntime: () =>
    Promise.resolve({
      connectHuddleAudio: (...args: unknown[]) => connectHuddleAudio(...args),
    }),
}));

import { useHuddle } from "./useHuddle";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const workspaceId = "00000000-0000-7000-8000-000000000001";
const channelId = "00000000-0000-7000-8000-000000000201";
const huddleId = "00000000-0000-7000-8000-000000000757";
const huddle = {
  id: huddleId,
  workspaceId,
  channelId,
  startedBy: workspaceId,
  startedAtMs: 1,
  participants: [],
};

const NOW_MS = Date.UTC(2026, 8, 26, 9, 0, 0);
const SERVER_TTL_MS = 600_000; // server-rust livekit.rs TOKEN_TTL_SECONDS
const FIFTEEN_MINUTES_MS = 15 * 60_000;

let mountedRoot: Root | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // Fake before mount/join so any timer the hook arms is under test control.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW_MS);
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  for (const mock of [
    fetchActiveHuddle,
    startHuddle,
    joinHuddle,
    leaveHuddle,
    leaveHuddleOnPageExit,
    connectHuddleAudio,
    disconnectAudio,
  ]) {
    mock.mockReset();
  }
  fetchActiveHuddle.mockResolvedValue(null);
  startHuddle.mockResolvedValue(huddle);
  joinHuddle.mockResolvedValue({
    huddle,
    livekitUrl: "wss://livekit.test",
    token: "tok",
    expiresAtMs: NOW_MS + SERVER_TTL_MS,
    ttlSeconds: SERVER_TTL_MS / 1000,
  });
  leaveHuddle.mockResolvedValue({ huddle, ended: false });
  disconnectAudio.mockResolvedValue(undefined);
  connectHuddleAudio.mockResolvedValue({
    disconnect: disconnectAudio,
    setMicrophoneMuted: vi.fn().mockResolvedValue(undefined),
    setMicrophoneDeviceId: vi.fn(),
    setMicrophoneGain: vi.fn(),
  });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(() => {
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

function Probe(): ReactElement {
  const state = useHuddle(workspaceId, channelId, null, false);
  return createElement(
    "div",
    null,
    createElement("button", {
      type: "button",
      "data-testid": "join",
      onClick: () => void state.startOrJoin(),
    }),
    createElement("span", {
      "data-testid": "joined",
      children: state.joined ? "yes" : "no",
    }),
    createElement("span", {
      "data-testid": "notice",
      children: state.notice ?? "",
    })
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function mountAndJoin(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(createElement(Probe));
  });
  await flush();
  await act(async () => {
    host.querySelector<HTMLButtonElement>("[data-testid='join']")?.click();
  });
  await flush();
  return host;
}

const text = (host: HTMLElement, id: string) =>
  host.querySelector(`[data-testid='${id}']`)?.textContent;

describe("useHuddle token expiry (#2757)", () => {
  it("keeps a connected huddle for 15 minutes past the 600s token TTL", async () => {
    const host = await mountAndJoin();
    expect(connectHuddleAudio).toHaveBeenCalledTimes(1);
    expect(text(host, "joined")).toBe("yes");

    for (let elapsed = 0; elapsed < FIFTEEN_MINUTES_MS; elapsed += 60_000) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    expect(Date.now()).toBeGreaterThan(NOW_MS + SERVER_TTL_MS);

    expect(leaveHuddle).not.toHaveBeenCalled();
    expect(disconnectAudio).not.toHaveBeenCalled();
    expect(text(host, "joined")).toBe("yes");
    expect(text(host, "notice")).toBe("");
  });

  it("still leaves when LiveKit itself reports the disconnect after the TTL", async () => {
    const host = await mountAndJoin();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES_MS);
    });
    expect(leaveHuddle).not.toHaveBeenCalled();

    const options = connectHuddleAudio.mock.calls[0]?.[0] as {
      onDisconnected: () => void;
    };
    await act(async () => {
      options.onDisconnected();
    });
    await flush();

    expect(leaveHuddle).toHaveBeenCalledTimes(1);
    expect(disconnectAudio).toHaveBeenCalledTimes(1);
    expect(text(host, "joined")).toBe("no");
    expect(text(host, "notice")).toBe(huddleErrorCopy("connection"));
  });

  it("ends with the expired copy when the token expired before connecting", async () => {
    joinHuddle.mockResolvedValue({
      huddle,
      livekitUrl: "wss://livekit.test",
      token: "tok",
      expiresAtMs: NOW_MS - 1,
      ttlSeconds: SERVER_TTL_MS / 1000,
    });
    const host = await mountAndJoin();

    expect(connectHuddleAudio).not.toHaveBeenCalled();
    expect(leaveHuddle).toHaveBeenCalledTimes(1);
    expect(text(host, "joined")).toBe("no");
    expect(text(host, "notice")).toBe(huddleErrorCopy("expired"));
  });
});

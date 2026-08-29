// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchActiveHuddle = vi.fn();
const startHuddle = vi.fn();
const joinHuddle = vi.fn();
const leaveHuddle = vi.fn();
const leaveHuddleOnPageExit = vi.fn();
const connectHuddleAudio = vi.fn();
const setMicrophoneDeviceId = vi.fn();
const setMicrophoneGain = vi.fn();
const setMicrophoneMuted = vi.fn();
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

import { useHuddle, type HuddleController } from "./useHuddle";
import {
  HUDDLE_MIC_STORAGE_KEY,
  resetHuddleMicDeviceForTests,
  writeHuddleMicDeviceId,
} from "./micDeviceStore";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
const memory = new Map<string, string>();

const workspaceId = "00000000-0000-7000-8000-000000000001";
const channelId = "00000000-0000-7000-8000-000000000201";
const huddleId = "00000000-0000-7000-8000-000000000643";

const huddle = {
  id: huddleId,
  workspaceId,
  channelId,
  startedBy: workspaceId,
  startedAtMs: 1,
  participants: [],
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  resetHuddleMicDeviceForTests();
  fetchActiveHuddle.mockReset();
  startHuddle.mockReset();
  joinHuddle.mockReset();
  leaveHuddle.mockReset();
  leaveHuddleOnPageExit.mockReset();
  connectHuddleAudio.mockReset();
  setMicrophoneDeviceId.mockReset();
  setMicrophoneGain.mockReset();
  setMicrophoneMuted.mockReset();
  disconnectAudio.mockReset();
  fetchActiveHuddle.mockResolvedValue(null);
  startHuddle.mockResolvedValue(huddle);
  joinHuddle.mockResolvedValue({
    huddle,
    livekitUrl: "wss://livekit.test",
    token: "tok",
    expiresAtMs: Date.now() + 60_000,
    ttlSeconds: 60,
  });
  leaveHuddle.mockResolvedValue({ huddle, ended: false });
  connectHuddleAudio.mockResolvedValue({
    disconnect: disconnectAudio,
    setMicrophoneMuted,
    setMicrophoneDeviceId,
    setMicrophoneGain,
  });
  setMicrophoneDeviceId.mockResolvedValue(undefined);
  setMicrophoneMuted.mockResolvedValue(undefined);
  disconnectAudio.mockResolvedValue(undefined);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

function Probe({
  onReady,
}: {
  onReady: (huddle: HuddleController) => void;
}): ReactElement {
  const huddleState = useHuddle(workspaceId, channelId, null, false);
  return createElement(
    "div",
    null,
    createElement("button", {
      type: "button",
      "data-testid": "join",
      onClick: () => void huddleState.startOrJoin(),
    }),
    createElement("button", {
      type: "button",
      "data-testid": "switch",
      onClick: () => void huddleState.setMicrophoneDevice("mic-2"),
    }),
    createElement("button", {
      type: "button",
      "data-testid": "leave",
      onClick: () => void huddleState.leave(),
    }),
    createElement("span", {
      "data-testid": "joined",
      children: huddleState.joined ? "yes" : "no",
    }),
    createElement("button", {
      type: "button",
      "data-hidden": "true",
      onClick: () => onReady(huddleState),
    })
  );
}

async function mountProbe(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(createElement(Probe, { onReady: () => undefined }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

describe("useHuddle microphone persistence", () => {
  it("applies the stored device on join, republishes once on select, and reuses it next join", async () => {
    writeHuddleMicDeviceId("mic-1");
    const host = await mountProbe();

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='join']")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(connectHuddleAudio).toHaveBeenCalledTimes(1);
    expect(connectHuddleAudio.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        microphoneDeviceId: "mic-1",
        livekitUrl: "wss://livekit.test",
      })
    );
    expect(host.querySelector("[data-testid='joined']")?.textContent).toBe(
      "yes"
    );

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='switch']")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(setMicrophoneDeviceId).toHaveBeenCalledTimes(1);
    expect(setMicrophoneDeviceId).toHaveBeenCalledWith("mic-2");
    expect(memory.get(HUDDLE_MIC_STORAGE_KEY)).toBe("mic-2");

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='leave']")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='join']")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(connectHuddleAudio).toHaveBeenCalledTimes(2);
    expect(connectHuddleAudio.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ microphoneDeviceId: "mic-2" })
    );
  });
});

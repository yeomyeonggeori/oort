// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  classifyAudioInputDevices,
  useAudioInputDevices,
  type AudioInputDevicesState,
} from "./useAudioInputDevices";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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

function row(
  kind: MediaDeviceKind,
  deviceId: string,
  label: string
): MediaDeviceInfo {
  return {
    deviceId,
    kind,
    label,
    groupId: "g",
    toJSON: () => ({}),
  } as MediaDeviceInfo;
}

function Probe({
  onState,
}: {
  onState: (state: AudioInputDevicesState) => void;
}): ReactElement {
  const state = useAudioInputDevices();
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return createElement("span", {
    "data-testid": "permission",
    children: state.permission,
  });
}

describe("classifyAudioInputDevices", () => {
  it("treats empty labels as permission not yet granted", () => {
    expect(
      classifyAudioInputDevices([
        row("audioinput", "", ""),
        row("audiooutput", "out", "Speakers"),
      ])
    ).toEqual({ devices: [], permission: "prompt" });
  });

  it("maps labeled capture devices once permission is granted", () => {
    const classified = classifyAudioInputDevices([
      row("audioinput", "mic-1", "MacBook Pro 마이크"),
      row("audioinput", "mic-2", "HD Pro Webcam"),
      row("videoinput", "cam", "HD Pro Webcam"),
    ]);
    expect(classified.permission).toBe("granted");
    expect(classified.devices).toEqual([
      { deviceId: "mic-1", label: "MacBook Pro 마이크" },
      { deviceId: "mic-2", label: "HD Pro Webcam" },
    ]);
  });

  it("names unlabeled devices after a granted hint", () => {
    const classified = classifyAudioInputDevices(
      [row("audioinput", "mic-1", "")],
      "granted"
    );
    expect(classified).toEqual({
      permission: "granted",
      devices: [{ deviceId: "mic-1", label: "마이크 1" }],
    });
  });

  it("hides the list when permission is denied", () => {
    expect(
      classifyAudioInputDevices(
        [row("audioinput", "mic-1", "Mic")],
        "denied"
      )
    ).toEqual({ devices: [], permission: "denied" });
  });
});

describe("useAudioInputDevices", () => {
  it("enumerates audioinput devices and refreshes on devicechange", async () => {
    const listeners = new Set<EventListener>();
    const enumerate = vi
      .fn()
      .mockResolvedValueOnce([row("audioinput", "mic-1", "Built-in")])
      .mockResolvedValueOnce([
        row("audioinput", "mic-1", "Built-in"),
        row("audioinput", "mic-2", "USB Mic"),
      ]);
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        enumerateDevices: enumerate,
        addEventListener: (type: string, listener: EventListener) => {
          if (type === "devicechange") listeners.add(listener);
        },
        removeEventListener: (type: string, listener: EventListener) => {
          if (type === "devicechange") listeners.delete(listener);
        },
      },
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });

    const seen: AudioInputDevicesState[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    await act(async () => {
      mountedRoot?.render(
        createElement(Probe, { onState: (state) => seen.push(state) })
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual({
      permission: "granted",
      devices: [{ deviceId: "mic-1", label: "Built-in" }],
    });

    await act(async () => {
      for (const listener of listeners) listener(new Event("devicechange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(enumerate).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)?.devices.map((device) => device.deviceId)).toEqual([
      "mic-1",
      "mic-2",
    ]);
  });

  it("keeps the pre-permission state when labels are empty", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        enumerateDevices: vi
          .fn()
          .mockResolvedValue([row("audioinput", "", "")]),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "prompt" }),
      },
    });

    const seen: AudioInputDevicesState[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    await act(async () => {
      mountedRoot?.render(
        createElement(Probe, { onState: (state) => seen.push(state) })
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(seen.at(-1)).toEqual({ devices: [], permission: "prompt" });
  });
});

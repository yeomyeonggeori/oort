// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const disconnectMock = vi.fn();
const setMicrophoneEnabledMock = vi.fn();

vi.mock("livekit-client", () => {
  class Room {
    localParticipant = {
      setMicrophoneEnabled: setMicrophoneEnabledMock,
    };
    on() {
      return this;
    }
    connect(...args: unknown[]) {
      return connectMock(...args);
    }
    disconnect() {
      return disconnectMock();
    }
  }
  return {
    Room,
    RoomEvent: {
      TrackSubscribed: "TrackSubscribed",
      TrackUnsubscribed: "TrackUnsubscribed",
      Disconnected: "Disconnected",
    },
    Track: { Kind: { Audio: "audio" } },
  };
});

import { connectHuddleAudio } from "./huddleRuntime";

const FUNNEL_SIGNAL = "wss://momo.tail123.ts.net:10000";

class FakePeerConnection {
  configuration: RTCConfiguration | undefined;
  constructor(configuration?: RTCConfiguration) {
    this.configuration = configuration;
  }
}

const originalPeerConnection = globalThis.RTCPeerConnection;

beforeEach(() => {
  globalThis.RTCPeerConnection =
    FakePeerConnection as unknown as typeof RTCPeerConnection;
  connectMock.mockReset();
  disconnectMock.mockReset();
  setMicrophoneEnabledMock.mockReset();
  connectMock.mockResolvedValue(undefined);
  disconnectMock.mockResolvedValue(undefined);
  setMicrophoneEnabledMock.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.RTCPeerConnection = originalPeerConnection;
});

describe("huddleRuntime shim lifetime", () => {
  it("keeps the shim through connect and mic publish, then restores on disconnect", async () => {
    const session = await connectHuddleAudio({
      livekitUrl: FUNNEL_SIGNAL,
      token: "tok",
      onDisconnected: () => undefined,
    });

    expect(connectMock).toHaveBeenCalled();
    expect(setMicrophoneEnabledMock).toHaveBeenCalledWith(true);
    expect(globalThis.RTCPeerConnection).not.toBe(FakePeerConnection);

    await session.disconnect();
    expect(globalThis.RTCPeerConnection).toBe(FakePeerConnection);

    await session.disconnect();
    expect(globalThis.RTCPeerConnection).toBe(FakePeerConnection);
  });

  it("restores the original constructor when connect fails", async () => {
    connectMock.mockRejectedValue(new Error("network"));

    await expect(
      connectHuddleAudio({
        livekitUrl: FUNNEL_SIGNAL,
        token: "tok",
        onDisconnected: () => undefined,
      })
    ).rejects.toThrow("network");

    expect(disconnectMock).toHaveBeenCalled();
    expect(globalThis.RTCPeerConnection).toBe(FakePeerConnection);
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const disconnectMock = vi.fn();
const setMicrophoneEnabledMock = vi.fn();
const getTrackPublicationMock = vi.fn();
const switchActiveDeviceMock = vi.fn();
const setDeviceIdMock = vi.fn();
const getDeviceIdMock = vi.fn();
const setAudioContextMock = vi.fn();
const setProcessorMock = vi.fn();
const stopProcessorMock = vi.fn();

vi.mock("livekit-client", () => {
  class Room {
    localParticipant = {
      setMicrophoneEnabled: setMicrophoneEnabledMock,
      getTrackPublication: getTrackPublicationMock,
    };
    switchActiveDevice = switchActiveDeviceMock;
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
    Track: {
      Kind: { Audio: "audio" },
      Source: { Microphone: "microphone" },
    },
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

function publishedMic() {
  return {
    audioTrack: {
      setDeviceId: setDeviceIdMock,
      getDeviceId: getDeviceIdMock,
      setAudioContext: setAudioContextMock,
      setProcessor: setProcessorMock,
      stopProcessor: stopProcessorMock,
    },
  };
}

beforeEach(() => {
  globalThis.RTCPeerConnection =
    FakePeerConnection as unknown as typeof RTCPeerConnection;
  connectMock.mockReset();
  disconnectMock.mockReset();
  setMicrophoneEnabledMock.mockReset();
  getTrackPublicationMock.mockReset();
  switchActiveDeviceMock.mockReset();
  setDeviceIdMock.mockReset();
  getDeviceIdMock.mockReset();
  setAudioContextMock.mockReset();
  setProcessorMock.mockReset();
  stopProcessorMock.mockReset();
  connectMock.mockResolvedValue(undefined);
  disconnectMock.mockResolvedValue(undefined);
  setMicrophoneEnabledMock.mockResolvedValue(publishedMic());
  getTrackPublicationMock.mockReturnValue(publishedMic());
  switchActiveDeviceMock.mockResolvedValue(true);
  setDeviceIdMock.mockResolvedValue(true);
  getDeviceIdMock.mockResolvedValue("mic-2");
  setProcessorMock.mockResolvedValue(undefined);
  stopProcessorMock.mockResolvedValue(undefined);
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

describe("huddleRuntime microphone device", () => {
  it("starts capture on the remembered deviceId", async () => {
    await connectHuddleAudio({
      livekitUrl: FUNNEL_SIGNAL,
      token: "tok",
      microphoneDeviceId: "mic-built-in",
      onDisconnected: () => undefined,
    });

    expect(setMicrophoneEnabledMock).toHaveBeenCalledTimes(1);
    expect(setMicrophoneEnabledMock).toHaveBeenCalledWith(true, {
      deviceId: "mic-built-in",
    });
  });

  it("falls back to the default capture when the remembered device is gone", async () => {
    setMicrophoneEnabledMock.mockRejectedValueOnce(new Error("Overconstrained"));
    setMicrophoneEnabledMock.mockResolvedValueOnce(publishedMic());

    await connectHuddleAudio({
      livekitUrl: FUNNEL_SIGNAL,
      token: "tok",
      microphoneDeviceId: "missing-webcam",
      onDisconnected: () => undefined,
    });

    expect(setMicrophoneEnabledMock).toHaveBeenNthCalledWith(1, true, {
      deviceId: "missing-webcam",
    });
    expect(setMicrophoneEnabledMock).toHaveBeenNthCalledWith(2, true);
  });

  it("republishes the live track once when the device changes", async () => {
    const session = await connectHuddleAudio({
      livekitUrl: FUNNEL_SIGNAL,
      token: "tok",
      onDisconnected: () => undefined,
    });

    const result = await session.setMicrophoneDeviceId("mic-2");
    expect(setDeviceIdMock).toHaveBeenCalledTimes(1);
    expect(setDeviceIdMock).toHaveBeenCalledWith("mic-2");
    expect(getDeviceIdMock).toHaveBeenCalled();
    expect(result).toEqual({ applied: true, deviceId: "mic-2" });
    expect(switchActiveDeviceMock).not.toHaveBeenCalled();
  });

  it("reports applied=false and the real device when setDeviceId lands elsewhere", async () => {
    setDeviceIdMock.mockResolvedValueOnce(false);
    getDeviceIdMock.mockResolvedValueOnce("mic-fallback");
    const session = await connectHuddleAudio({
      livekitUrl: FUNNEL_SIGNAL,
      token: "tok",
      onDisconnected: () => undefined,
    });

    const result = await session.setMicrophoneDeviceId("mic-2");
    expect(result).toEqual({ applied: false, deviceId: "mic-fallback" });
  });

  it("falls back to the default device when the selected id cannot restart", async () => {
    setDeviceIdMock.mockRejectedValueOnce(new Error("not found"));
    const session = await connectHuddleAudio({
      livekitUrl: FUNNEL_SIGNAL,
      token: "tok",
      onDisconnected: () => undefined,
    });

    await session.setMicrophoneDeviceId("gone");
    expect(setDeviceIdMock).toHaveBeenNthCalledWith(1, "gone");
    expect(setDeviceIdMock).toHaveBeenNthCalledWith(2, "default");
  });

  it("routes gain through the LiveKit audio processor when WebAudio exists", async () => {
    const outputTrack = { id: "gained", kind: "audio", stop: vi.fn() };
    class FakeAudioContext {
      state = "running";
      resume() {
        return Promise.resolve();
      }
      close() {
        this.state = "closed";
        return Promise.resolve();
      }
      createGain() {
        return {
          gain: { value: 1 },
          connect() {
            return this;
          },
          disconnect() {},
        };
      }
      createMediaStreamSource() {
        return {
          connect() {
            return this;
          },
          disconnect() {},
        };
      }
      createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => [outputTrack] } };
      }
    }
    class FakeMediaStream {
      constructor(public tracks: unknown[] = []) {}
      getAudioTracks() {
        return this.tracks;
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("MediaStream", FakeMediaStream);

    try {
      const session = await connectHuddleAudio({
        livekitUrl: FUNNEL_SIGNAL,
        token: "tok",
        microphoneGain01: 0.5,
        onDisconnected: () => undefined,
      });
      expect(setAudioContextMock).toHaveBeenCalled();
      expect(setProcessorMock).toHaveBeenCalledTimes(1);
      const processor = setProcessorMock.mock.calls[0]?.[0] as {
        name: string;
        setGain: (value: number) => void;
      };
      expect(processor.name).toBe("momo-mic-gain");
      session.setMicrophoneGain(0.25);
      await session.disconnect();
      expect(stopProcessorMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

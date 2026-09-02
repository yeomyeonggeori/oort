// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  clampGainPercent,
  gainPercentTo01,
  MicGainProcessor,
  type MicGainRestartOptions,
} from "./micGain";

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
    return {
      stream: { getAudioTracks: () => [outputTrack] },
      disconnect() {},
    };
  }
}

class FakeMediaStream {
  constructor(public tracks: unknown[] = []) {}
  getAudioTracks() {
    return this.tracks;
  }
}

function fakeTrack(id: string): MediaStreamTrack {
  return { id, kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
}

describe("gain scale boundary", () => {
  it("names percent and 0-1 conversions so 100 cannot be passed as unity", () => {
    expect(clampGainPercent(100)).toBe(100);
    expect(gainPercentTo01(100)).toBe(1);
    expect(gainPercentTo01(50)).toBe(0.5);
    expect(gainPercentTo01(0)).toBe(0);
    expect(gainPercentTo01(Number.NaN)).toBe(1);
  });
});

describe("MicGainProcessor restart", () => {
  it("rebuilds from the cached AudioContext when livekit omits audioContext", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const context = new FakeAudioContext() as unknown as AudioContext;
    const processor = new MicGainProcessor(0.5);
    await processor.init({
      kind: "audio" as never,
      track: fakeTrack("capture-1"),
      audioContext: context,
    });
    expect(processor.processedTrack).toBe(outputTrack);

    // livekit-client 2.21.0 LocalTrack.restart — the only caller — passes
    // { track, kind, element, localTrack } and never audioContext.
    const livekitRestart: MicGainRestartOptions = {
      track: fakeTrack("capture-2"),
      kind: "audio" as never,
      element: undefined,
      localTrack: { id: "local-audio" },
    };
    expect("audioContext" in livekitRestart).toBe(false);

    await expect(processor.restart(livekitRestart)).resolves.toBeUndefined();
    expect(processor.processedTrack).toBe(outputTrack);
    vi.unstubAllGlobals();
  });

  it("does not throw TypeError when restart options have no audioContext field", async () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const processor = new MicGainProcessor(1);
    processor.setAudioContext(new FakeAudioContext() as unknown as AudioContext);
    const opts = {
      track: fakeTrack("capture-3"),
      kind: "audio",
    };
    await expect(
      processor.restart(opts as MicGainRestartOptions)
    ).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});

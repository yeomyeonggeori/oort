import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from "livekit-client";

function clamp01(gain01: number): number {
  if (!Number.isFinite(gain01)) return 1;
  return Math.min(1, Math.max(0, gain01));
}

export function clampGainPercent(gainPercent: number): number {
  if (!Number.isFinite(gainPercent)) return 100;
  return Math.min(100, Math.max(0, Math.round(gainPercent)));
}

export function gainPercentTo01(gainPercent: number): number {
  return clampGainPercent(gainPercent) / 100;
}

/**
 * livekit-client 2.21.0 LocalTrack.restart calls processor.restart with
 * { track, kind, element, localTrack } and never passes audioContext
 * (esm.mjs processor.restart). AudioProcessorOptions claims it is required.
 * Cache the context from init / setAudioContext, the same way livekit's own
 * track-processors do, and ignore a missing opts.audioContext on restart.
 */
export type MicGainRestartOptions = {
  track: MediaStreamTrack;
  kind: Track.Kind;
  element?: HTMLMediaElement;
  localTrack?: unknown;
  audioContext?: AudioContext;
};

/**
 * Capture-side gain via a WebAudio GainNode. LiveKit has no first-class
 * microphone volume API; LocalAudioTrack.setProcessor is the supported
 * insertion point and restarts this graph when the device changes.
 */
export class MicGainProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  readonly name = "momo-mic-gain";
  processedTrack?: MediaStreamTrack;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private audioContext: AudioContext | null = null;
  private value: number;

  constructor(initialGain01: number) {
    this.value = clamp01(initialGain01);
  }

  setAudioContext(audioContext: AudioContext): void {
    this.audioContext = audioContext;
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    this.cacheAudioContext(opts.audioContext);
    await this.build(opts.track);
  }

  async restart(opts: MicGainRestartOptions): Promise<void> {
    this.cacheAudioContext(opts.audioContext);
    this.teardownGraph();
    await this.build(opts.track);
  }

  async destroy(): Promise<void> {
    this.teardownGraph();
    this.processedTrack = undefined;
    this.audioContext = null;
  }

  setGain(gain01: number): void {
    this.value = clamp01(gain01);
    if (this.gain) this.gain.gain.value = this.value;
  }

  private cacheAudioContext(audioContext: AudioContext | undefined): void {
    if (audioContext) this.audioContext = audioContext;
  }

  private async build(track: MediaStreamTrack): Promise<void> {
    const context = this.audioContext;
    if (!context) {
      throw new Error("MicGainProcessor has no AudioContext");
    }
    if (context.state === "suspended") {
      await context.resume();
    }
    this.source = context.createMediaStreamSource(new MediaStream([track]));
    this.gain = context.createGain();
    this.gain.gain.value = this.value;
    this.dest = context.createMediaStreamDestination();
    this.source.connect(this.gain);
    this.gain.connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
  }

  private teardownGraph(): void {
    this.source?.disconnect();
    this.gain?.disconnect();
    this.dest?.disconnect?.();
    this.source = null;
    this.gain = null;
    this.dest = null;
  }
}

export function tryCreateAudioContext(): AudioContext | null {
  const Candidate =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (typeof Candidate !== "function") return null;
  try {
    return new Candidate();
  } catch {
    return null;
  }
}

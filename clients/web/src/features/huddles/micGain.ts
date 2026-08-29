import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from "livekit-client";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

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
  private value: number;

  constructor(initialGain01: number) {
    this.value = clamp01(initialGain01);
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    await this.build(opts);
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    this.teardownGraph();
    await this.build(opts);
  }

  async destroy(): Promise<void> {
    this.teardownGraph();
    this.processedTrack = undefined;
  }

  setGain(gain01: number): void {
    this.value = clamp01(gain01);
    if (this.gain) this.gain.gain.value = this.value;
  }

  private async build(opts: AudioProcessorOptions): Promise<void> {
    const context = opts.audioContext;
    if (context.state === "suspended") {
      await context.resume();
    }
    this.source = context.createMediaStreamSource(new MediaStream([opts.track]));
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
    this.dest?.disconnect();
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

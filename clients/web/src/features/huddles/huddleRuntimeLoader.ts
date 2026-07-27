import type {
  ConnectHuddleAudioOptions,
  HuddleAudioSession,
} from "./huddleRuntime";

type HuddleRuntime = {
  connectHuddleAudio: (
    options: ConnectHuddleAudioOptions
  ) => Promise<HuddleAudioSession>;
};

/**
 * Keep LiveKit outside the channel-open bundle. The huddle browser gate uses a
 * compile-time-only connector because it intentionally has no media server or
 * microphone; normal and design builds retain the real dynamic import.
 */
export function loadHuddleRuntime(): Promise<HuddleRuntime> {
  if (import.meta.env.MODE === "huddle-gate") {
    return Promise.resolve({
      connectHuddleAudio: async () => ({
        disconnect: async () => undefined,
        setMicrophoneMuted: async () => undefined,
      }),
    });
  }
  return import("./huddleRuntime");
}

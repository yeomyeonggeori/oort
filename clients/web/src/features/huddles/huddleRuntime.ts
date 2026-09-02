// =============================================================================
// The LiveKit browser runtime, isolated behind one module so Vite code-splits it.
//
// Huddles are optional and LiveKit is a large media dependency. Importing it in
// ChatShell would charge its parse/download cost to every channel open, even for
// people who never join audio. This module is imported only after the user asks
// to start or join a huddle, matching terminalRuntime.ts's xterm boundary.
//
// The SDK is installed from npm and bundled locally (Apache-2.0): no CDN, remote
// script, font, or asset. The server-provided livekitUrl is passed through
// verbatim; this module never derives an address from the momo server.
// =============================================================================

import {
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type RemoteTrack,
} from "livekit-client";
import { cspBlockedHost } from "@/features/work/observerStream";
import { installHuddleTurnRewriteShim } from "./huddleTurnRewrite";
import { MicGainProcessor, tryCreateAudioContext } from "./micGain";

class HuddleCspBlockedError extends Error {
  override name = "HuddleCspBlockedError";
}

class HuddleMicrophoneError extends Error {
  override name = "HuddleMicrophoneError";

  constructor(cause: unknown) {
    super("LiveKit microphone publication failed", { cause });
  }
}

export type MicrophoneDeviceSwitch = {
  applied: boolean;
  deviceId: string;
};

export interface HuddleAudioSession {
  disconnect: () => Promise<void>;
  setMicrophoneMuted: (muted: boolean) => Promise<void>;
  setMicrophoneDeviceId: (deviceId: string) => Promise<MicrophoneDeviceSwitch>;
  setMicrophoneGain: (gain01: number) => void;
}

export interface ConnectHuddleAudioOptions {
  livekitUrl: string;
  token: string;
  onDisconnected: () => void;
  microphoneDeviceId?: string | null;
  microphoneGain01?: number;
}

function publishedMicrophone(room: Room): LocalAudioTrack | undefined {
  return room.localParticipant.getTrackPublication(Track.Source.Microphone)
    ?.audioTrack;
}

/**
 * Connect audio-only, publish the local microphone, and attach subscribed
 * remote audio tracks. Camera/video capture is never requested in this v0.
 */
export async function connectHuddleAudio(
  options: ConnectHuddleAudioOptions
): Promise<HuddleAudioSession> {
  const room = new Room({ adaptiveStream: false, dynacast: false });
  const attachedAudio = new Set<HTMLMediaElement>();
  let intentionalDisconnect = false;
  const gain = new MicGainProcessor(options.microphoneGain01 ?? 1);
  const audioContext = tryCreateAudioContext();
  let gainAttached = false;

  const attachAudio = (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    element.setAttribute("data-huddle-audio", "");
    element.setAttribute("aria-hidden", "true");
    document.body.append(element);
    attachedAudio.add(element);
  };
  const detachAudio = (track: RemoteTrack) => {
    for (const element of track.detach()) {
      attachedAudio.delete(element);
      element.remove();
    }
  };

  room.on(RoomEvent.TrackSubscribed, attachAudio);
  room.on(RoomEvent.TrackUnsubscribed, detachAudio);
  room.on(RoomEvent.Disconnected, () => {
    for (const element of attachedAudio) element.remove();
    attachedAudio.clear();
    if (!intentionalDisconnect) options.onDisconnected();
  });

  let restoreTurnRewrite: () => void = () => undefined;

  try {
    // Like the observer socket, a connect-src refusal may never reach the
    // socket callbacks. Listen on document before dialling so a deployment
    // policy failure is named immediately instead of becoming a retryable
    // timeout or a misleading microphone SecurityError.
    let rejectPolicy: ((reason: HuddleCspBlockedError) => void) | null = null;
    const policyRefusal = new Promise<never>((_resolve, reject) => {
      rejectPolicy = reject;
    });
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (!cspBlockedHost(event, options.livekitUrl)) return;
      rejectPolicy?.(new HuddleCspBlockedError());
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    // JoinResponse iceServers carry the TURN credential. rtcConfig cannot
    // rewrite them without dropping that credential (livekit-client keeps
    // server iceServers only when rtcConfig.iceServers is unset), so the
    // PeerConnection constructor and prototype.setConfiguration are shimmed
    // for the huddle session. livekit-client builds an empty PC then injects
    // ICE via setConfiguration (#1847).
    // Host-gated: rewrite is turns:signalHost:443 only, so other PCs are
    // unaffected while the shim stays installed.
    restoreTurnRewrite = installHuddleTurnRewriteShim(options.livekitUrl);
    try {
      await Promise.race([
        room.connect(options.livekitUrl, options.token, {
          autoSubscribe: true,
        }),
        policyRefusal,
      ]);
    } finally {
      document.removeEventListener("securitypolicyviolation", onViolation);
    }
    try {
      // Preferred device is best-effort. An unplugged remembered id must not
      // fail the join: fall back to the browser default with no error.
      let published = false;
      if (options.microphoneDeviceId) {
        try {
          await room.localParticipant.setMicrophoneEnabled(true, {
            deviceId: options.microphoneDeviceId,
          });
          published = true;
        } catch (publishError) {
          void publishError;
        }
      }
      if (!published) {
        await room.localParticipant.setMicrophoneEnabled(true);
      }
      const microphone = publishedMicrophone(room);
      if (microphone && audioContext) {
        try {
          gain.setAudioContext(audioContext);
          microphone.setAudioContext(audioContext);
          await microphone.setProcessor(gain);
          gainAttached = true;
        } catch {
          // Gain is additive. A processor the browser cannot run must not
          // fail the join; device selection still works on the raw track.
        }
      }
    } catch (error) {
      // SecurityError only means microphone denial in this explicit media
      // capture phase. The connection phase has its own CSP classification.
      throw new HuddleMicrophoneError(error);
    }
  } catch (error) {
    intentionalDisconnect = true;
    try {
      await room.disconnect();
    } finally {
      restoreTurnRewrite();
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close();
      }
    }
    throw error;
  }

  return {
    async disconnect() {
      intentionalDisconnect = true;
      const microphone = publishedMicrophone(room);
      if (gainAttached && microphone) {
        try {
          await microphone.stopProcessor();
        } catch {
          // Session is ending; a processor that already tore down is fine.
        }
      }
      try {
        await room.disconnect();
      } finally {
        restoreTurnRewrite();
        if (audioContext && audioContext.state !== "closed") {
          void audioContext.close();
        }
      }
      for (const element of attachedAudio) element.remove();
      attachedAudio.clear();
    },
    async setMicrophoneMuted(muted: boolean) {
      try {
        await room.localParticipant.setMicrophoneEnabled(!muted);
      } catch (error) {
        throw new HuddleMicrophoneError(error);
      }
    },
    async setMicrophoneDeviceId(deviceId: string) {
      const microphone = publishedMicrophone(room);
      const target = deviceId.trim() === "" ? "default" : deviceId.trim();
      try {
        if (microphone) {
          let applied = false;
          try {
            applied = Boolean(await microphone.setDeviceId(target));
          } catch (switchError) {
            if (target === "default") throw switchError;
            await microphone.setDeviceId("default");
            applied = false;
          }
          const actual = (await microphone.getDeviceId()) ?? "";
          if (target === "default") {
            return { applied: true, deviceId: actual };
          }
          return { applied, deviceId: actual };
        }
        const switched = await room.switchActiveDevice("audioinput", target);
        return {
          applied: Boolean(switched),
          deviceId: target === "default" ? "" : target,
        };
      } catch (error) {
        throw new HuddleMicrophoneError(error);
      }
    },
    setMicrophoneGain(gain01: number) {
      gain.setGain(gain01);
    },
  };
}

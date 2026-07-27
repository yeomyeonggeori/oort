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
  type RemoteTrack,
} from "livekit-client";

export interface HuddleAudioSession {
  disconnect: () => Promise<void>;
  setMicrophoneMuted: (muted: boolean) => Promise<void>;
}

export interface ConnectHuddleAudioOptions {
  livekitUrl: string;
  token: string;
  onDisconnected: () => void;
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

  try {
    await room.connect(options.livekitUrl, options.token, {
      autoSubscribe: true,
    });
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch (error) {
    intentionalDisconnect = true;
    await room.disconnect();
    throw error;
  }

  return {
    async disconnect() {
      intentionalDisconnect = true;
      await room.disconnect();
      for (const element of attachedAudio) element.remove();
      attachedAudio.clear();
    },
    async setMicrophoneMuted(muted: boolean) {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    },
  };
}

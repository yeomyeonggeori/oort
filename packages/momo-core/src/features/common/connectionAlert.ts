import type { RealtimeStatus } from "../../lib/realtimeEvents";
import { HEALED_MS, RETRY_WINDOW_MS, SUSTAINED_DOWN_MS } from "../connection/thresholds";

// =============================================================================
// What the shell says when the realtime rail is not up (goal B8 B2).
//
// The QA sweep found a session where the socket NEVER connected (the Centrifugo
// origin refused the handshake) and the only thing on screen that knew was an
// 8px unlabelled dot in the workspace rail. Nothing named the state, nothing
// offered a way out, and every surface below kept rendering as if it were live.
//
// The existing offline banner could not have caught it: it keys off
// `disconnected`, and centrifuge only reports that once it has been connected
// at least once (lib/realtime.ts `everConnected`). A rail that never came up at
// all sits in `connecting` forever, which is also the honest word for the first
// two seconds of every session. So the distinguishing fact is not the status,
// it is DURATION, which is what `sustained` carries.
//
// Pure, because the three cases below read the same on screen and are three
// different sentences: "you are offline" is not "the server never answered" is
// not "we lost the connection we had".
// =============================================================================

export type ConnectionAlertKind =
  | "browser-offline"
  | "never-connected"
  | "dropped";

export interface ConnectionAlert {
  kind: ConnectionAlertKind;
  /** One line. The banner is a line, not a paragraph. */
  message: string;
  /** Whether re-dialling the rail is a thing the reader can usefully do. */
  canRetry: boolean;
}

// The clocks behind this banner now live in one place, `features/connection/thresholds.ts`
// (#5219): how long a down rail waits before the banner is worth the space
// (`SUSTAINED_DOWN_MS`), how long a reconnect has to HOLD before the down-clock is
// forgiven (`HEALED_MS`), and how long the banner waits for a hand-pressed reconnect
// before saying it did not work (`RETRY_WINDOW_MS`). The names and values are the
// banner's own and unchanged; this file only points at them.
export { HEALED_MS, RETRY_WINDOW_MS, SUSTAINED_DOWN_MS };

export interface ConnectionAlertInput {
  /** `navigator.onLine === false`. */
  browserOffline: boolean;
  connStatus: RealtimeStatus;
  /** The rail has been not-connected for at least `SUSTAINED_DOWN_MS`. */
  sustained: boolean;
}

export function connectionAlert(
  input: ConnectionAlertInput
): ConnectionAlert | null {
  // The browser's own answer needs no dwell: it is not a guess about a socket,
  // it is the machine saying it has no network. Waiting 15s to repeat what the
  // OS already told the user is the wrong kind of caution.
  if (input.browserOffline) {
    return {
      kind: "browser-offline",
      message:
        "네트워크가 끊겼습니다. 지금 보이는 내용은 마지막으로 확인된 상태입니다.",
      canRetry: false,
    };
  }
  if (input.connStatus === "connected" || !input.sustained) return null;
  if (input.connStatus === "connecting") {
    return {
      kind: "never-connected",
      message:
        "실시간 연결을 아직 맺지 못했습니다. 새 메시지는 채널을 다시 열어야 도착합니다.",
      canRetry: true,
    };
  }
  // Same contract as the never-connected sentence above: state the consequence,
  // then the way out. A banner that only reports a fact leaves the reader with
  // nothing to do but stare at it.
  return {
    kind: "dropped",
    message:
      "실시간 연결이 끊겼습니다. 새 메시지는 채널을 다시 열어야 도착합니다.",
    canRetry: true,
  };
}

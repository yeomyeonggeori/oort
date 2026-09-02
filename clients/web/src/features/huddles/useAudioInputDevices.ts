import { useEffect, useState } from "react";

// =============================================================================
// Audio-input enumeration for huddle mic pick (BF-A3 / #1886).
//
// Grammar is the buzz huddle hook: enumerateDevices on mount, subscribe to
// `devicechange`, map audioinput rows. Labels are empty strings until the
// page has microphone permission; that is a distinct state, not a missing
// device. A denied permission is a sentence, not a radio list of ghosts.
// =============================================================================

export type AudioInputDevice = {
  deviceId: string;
  label: string;
};

export type AudioInputPermission = "prompt" | "granted" | "denied";

export type AudioInputDevicesState = {
  devices: AudioInputDevice[];
  permission: AudioInputPermission;
};

type DeviceRow = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

export function classifyAudioInputDevices(
  devices: ReadonlyArray<DeviceRow>,
  permissionHint?: AudioInputPermission
): AudioInputDevicesState {
  if (permissionHint === "denied") {
    return { devices: [], permission: "denied" };
  }
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const withId = inputs.filter((device) => device.deviceId !== "");
  const labeled = withId.filter((device) => device.label !== "");
  if (labeled.length > 0 || permissionHint === "granted") {
    return {
      devices: withId.map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `마이크 ${index + 1}`,
      })),
      permission: "granted",
    };
  }
  return { devices: [], permission: "prompt" };
}

async function queryMicrophonePermission(): Promise<AudioInputPermission | null> {
  try {
    const permissions = navigator.permissions;
    if (!permissions?.query) return null;
    const status = await permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "denied") return "denied";
    if (status.state === "granted") return "granted";
    if (status.state === "prompt") return "prompt";
    return null;
  } catch {
    return null;
  }
}

const INITIAL: AudioInputDevicesState = {
  devices: [],
  permission: "prompt",
};

/**
 * Lists capture devices and keeps the list current while the huddle is live.
 * Does not call getUserMedia: joining already did that. Selection and gain
 * live on the huddle controller, not here.
 */
export function useAudioInputDevices(): AudioInputDevicesState {
  const [state, setState] = useState<AudioInputDevicesState>(INITIAL);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) {
      setState({ devices: [], permission: "denied" });
      return;
    }

    let cancelled = false;

    function refreshDevices() {
      const hintPromise = queryMicrophonePermission();
      media
        .enumerateDevices()
        .then(async (devices) => {
          const hint = await hintPromise;
          if (cancelled) return;
          setState(classifyAudioInputDevices(devices, hint ?? undefined));
        })
        .catch(async (error: unknown) => {
          const hint = await hintPromise;
          if (cancelled) return;
          const denied =
            hint === "denied" ||
            (error instanceof DOMException &&
              (error.name === "NotAllowedError" || error.name === "SecurityError"));
          setState({
            devices: [],
            permission: denied ? "denied" : "prompt",
          });
        });
    }

    refreshDevices();
    media.addEventListener("devicechange", refreshDevices);
    return () => {
      cancelled = true;
      media.removeEventListener("devicechange", refreshDevices);
    };
  }, []);

  return state;
}

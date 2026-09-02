// =============================================================================
// Remembered huddle microphone (BF-A3 / #1886).
//
// The chosen capture device is this-device state, not a server fact. The house
// key shape is `momo.web.*`. A missing or unplugged id is not an error: the
// next join falls back to the browser default.
// =============================================================================

export const HUDDLE_MIC_STORAGE_KEY = "momo.web.huddle.mic.v1";

function readRaw(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(HUDDLE_MIC_STORAGE_KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

export function readHuddleMicDeviceId(): string | null {
  return readRaw();
}

export function writeHuddleMicDeviceId(deviceId: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    const trimmed = deviceId?.trim() ?? "";
    if (trimmed === "") localStorage.removeItem(HUDDLE_MIC_STORAGE_KEY);
    else localStorage.setItem(HUDDLE_MIC_STORAGE_KEY, trimmed);
  } catch {
    // Private mode / quota: the choice does not survive a reload.
  }
}

/** Test helper. Not for product code. */
export function resetHuddleMicDeviceForTests(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(HUDDLE_MIC_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

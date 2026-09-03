export const DEVICE_LINK_LIVE_KEY = "momo.web.deviceLinkLive.v1";

export interface DeviceLinkLiveRecord {
  id: string;
  expiresAt: number;
  deepLink?: string;
  sas?: string;
  confirmed?: boolean;
}

export function readDeviceLinkLive(): DeviceLinkLiveRecord | null {
  try {
    const raw = sessionStorage.getItem(DEVICE_LINK_LIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeviceLinkLiveRecord;
    if (typeof parsed.id !== "string" || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeDeviceLinkLive(record: DeviceLinkLiveRecord | null): void {
  try {
    if (!record) sessionStorage.removeItem(DEVICE_LINK_LIVE_KEY);
    else sessionStorage.setItem(DEVICE_LINK_LIVE_KEY, JSON.stringify(record));
  } catch {
    // Private mode.
  }
}

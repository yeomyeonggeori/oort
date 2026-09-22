// Linked-device list/revoke (ADR-0180 D5 / openapi listLinkedDevices ·
// revokeLinkedDevice). Transport is the shared rotating client
// (`authedRequest` in lib/api.ts): a 401 rotates once, and only a 401 that
// survives rotation is allowed to mean expiry.
//
// GET    /v1/auth/devices        { devices: [{ id, label, platform, linkedAt,
//                                  lastSeenAt?, current }] }
// DELETE /v1/auth/devices/{id}   204 / 400 cannot_revoke_current / 404
//
// Distinct from the issuer QR flow (`./deviceLink`) and from the push-token
// registry at `/v1/workspaces/{ws}/devices`. This file does not log.

import { ApiError, authedRequest } from "../../lib/api";
import { arrayField, bool, num, record, str, WireShapeError } from "../../lib/wire";

export const CANNOT_REVOKE_CURRENT = "cannot_revoke_current";

export interface LinkedDevice {
  id: string;
  label: string;
  platform: string;
  linkedAt: number;
  lastSeenAt?: number;
  current: boolean;
}

export interface LinkedDeviceList {
  devices: LinkedDevice[];
}

export function parseLinkedDevice(value: unknown): LinkedDevice {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const label = str(source, "label");
  const platform = str(source, "platform");
  const linkedAt = num(source, "linkedAt");
  const current = bool(source, "current");
  if (!id || !label || !platform || linkedAt === undefined || current === undefined) {
    throw new WireShapeError();
  }
  const lastSeenAt = num(source, "lastSeenAt");
  return {
    id,
    label,
    platform,
    linkedAt,
    current,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  };
}

export function parseLinkedDeviceList(value: unknown): LinkedDeviceList {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const rows = arrayField(source, "devices");
  if (rows === null) throw new WireShapeError();
  return { devices: rows.map(parseLinkedDevice) };
}

export async function listLinkedDevices(): Promise<LinkedDeviceList> {
  const res = await authedRequest("/v1/auth/devices", { cache: "no-store" });
  return parseLinkedDeviceList(res.json<unknown>());
}

export async function revokeLinkedDevice(id: string): Promise<void> {
  const res = await authedRequest(
    `/v1/auth/devices/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  if (res.status !== 204) throw new WireShapeError();
}

export function isCannotRevokeCurrent(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    error.message === CANNOT_REVOKE_CURRENT
  );
}

/** Product label for a redeem `platform` token. Unknown values pass through. */
export function linkedDevicePlatformLabel(platform: string): string {
  const key = platform.trim().toLowerCase();
  switch (key) {
    case "ios":
    case "iphone":
      return "iOS";
    case "ipad":
    case "ipados":
      return "iPadOS";
    case "android":
      return "Android";
    case "macos":
    case "darwin":
    case "mac":
      return "macOS";
    case "windows":
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "web":
      return "웹";
    default:
      return platform.trim();
  }
}

export function isPhonePlatform(platform: string): boolean {
  const key = platform.trim().toLowerCase();
  return (
    key === "ios" ||
    key === "iphone" ||
    key === "ipad" ||
    key === "ipados" ||
    key === "android"
  );
}

// REST client for linked-device list/revoke (ADR-0180 D5 / openapi
// listLinkedDevices · revokeLinkedDevice).
//
// GET    /v1/auth/devices        { devices: [{ id, label, platform, linkedAt,
//                                  lastSeenAt?, current }] }
// DELETE /v1/auth/devices/{id}   204 / 400 cannot_revoke_current / 404
//
// Distinct from the issuer QR flow (`./deviceLink`) and from the push-token
// registry at `/v1/workspaces/{ws}/devices`. This file does not log.

import { ApiError } from "../../lib/api";
import { fetchWithDeadline } from "../../lib/http";
import { apiBase, coreSession } from "../../runtime/host";
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

async function linkedDevicesRequest(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const token = coreSession().getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetchWithDeadline(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = res.jsonOrNull<{ error?: { message?: string } }>();
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return { status: res.status, body: res.jsonOrNull<unknown>() };
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
  const { body } = await linkedDevicesRequest("/v1/auth/devices", {
    cache: "no-store",
  });
  return parseLinkedDeviceList(body);
}

export async function revokeLinkedDevice(id: string): Promise<void> {
  const { status } = await linkedDevicesRequest(
    `/v1/auth/devices/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  if (status !== 204) throw new WireShapeError();
}

export function isCannotRevokeCurrent(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    error.message === CANNOT_REVOKE_CURRENT
  );
}

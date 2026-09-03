// REST client for issuer-side device-link (ADR-0180 / openapi device-link).
//
// POST /v1/auth/device-link                  issue (201, raw token once)
// GET  /v1/auth/device-link/{id}             poll
// POST /v1/auth/device-link/{id}/confirm-sas confirm
//
// Redeem is the phone's job (M0m). This file does not log: the 201 body carries
// a one-time voucher.

import { ApiError } from "../../lib/api";
import { fetchWithDeadline } from "../../lib/http";
import { apiBase, coreSession } from "../../runtime/host";
import { num, record, str, WireShapeError } from "../../lib/wire";

export const DEVICE_LINK_POLL_INTERVAL_MS = 2_000;
export const DEVICE_LINK_TTL_SECONDS = 120;
export const DEVICE_LINK_ANNOUNCE_SECONDS = 30;

export type DeviceLinkStatusKind = "pending" | "consumed" | "expired";

export interface DeviceLinkDevice {
  name: string;
  platform: string;
}

export interface DeviceLinkIssue {
  id: string;
  token: string;
  expiresAt: number;
  sas?: string;
  deepLink: string;
}

export interface DeviceLinkStatus {
  status: DeviceLinkStatusKind;
  device?: DeviceLinkDevice;
}

export interface DeviceLinkConfirm {
  status: "confirmed";
}

async function deviceLinkRequest(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const token = coreSession().getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetchWithDeadline(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = res.jsonOrNull<{ error?: { message?: string } }>();
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return { status: res.status, body: res.jsonOrNull<unknown>() };
}

function parseDevice(value: unknown): DeviceLinkDevice | undefined {
  const source = record(value);
  if (source === null) return undefined;
  const name = str(source, "name");
  const platform = str(source, "platform");
  if (!name || !platform) return undefined;
  return { name, platform };
}

export function parseDeviceLinkIssue(value: unknown): DeviceLinkIssue {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const token = str(source, "token");
  const expiresAt = num(source, "expiresAt");
  const deepLink = str(source, "deepLink");
  const sas = str(source, "sas");
  if (!id || !token || expiresAt === undefined || !deepLink) {
    throw new WireShapeError();
  }
  return {
    id,
    token,
    expiresAt,
    deepLink,
    ...(sas ? { sas } : {}),
  };
}

export function parseDeviceLinkStatus(value: unknown): DeviceLinkStatus {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const status = str(source, "status");
  if (status !== "pending" && status !== "consumed" && status !== "expired") {
    throw new WireShapeError();
  }
  const device = parseDevice(source.device);
  return device ? { status, device } : { status };
}

export function parseDeviceLinkConfirm(value: unknown): DeviceLinkConfirm {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  if (str(source, "status") !== "confirmed") throw new WireShapeError();
  return { status: "confirmed" };
}

export async function issueDeviceLink(): Promise<DeviceLinkIssue> {
  const { body } = await deviceLinkRequest("/v1/auth/device-link", {
    method: "POST",
    body: "{}",
    cache: "no-store",
  });
  return parseDeviceLinkIssue(body);
}

export async function getDeviceLink(id: string): Promise<DeviceLinkStatus> {
  const { body } = await deviceLinkRequest(
    `/v1/auth/device-link/${encodeURIComponent(id)}`
  );
  return parseDeviceLinkStatus(body);
}

export async function confirmDeviceLinkSas(id: string): Promise<DeviceLinkConfirm> {
  const { body } = await deviceLinkRequest(
    `/v1/auth/device-link/${encodeURIComponent(id)}/confirm-sas`,
    { method: "POST", body: "{}" }
  );
  return parseDeviceLinkConfirm(body);
}

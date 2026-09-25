import {fetchWithDeadline, type HttpResponse} from '@momo/core/lib/http';
import {apiBase, coreSession} from '@momo/core/runtime/host';

import {PUSH_TOPIC} from './contract';
import type {ApnsEnvironment} from './native';

// =============================================================================
// Device registration REST (goal RN-N1).
//
// Written here rather than in `packages/momo-core` on purpose. The core is
// shared with clients/web, and a browser has no APNs token, no device id and no
// notion of an APNs environment — putting this there would export a surface only
// one host can ever call. `momo-core` also has no devices client today
// (verified), so nothing is being duplicated.
//
// Wire shape is fixed on both ends and was read from both:
//   server-rust/bins/momo-server/src/dto.rs:1965-1978 (RegisterDeviceRequest)
//   server-rust/bins/momo-server/src/lib.rs:344-349   (routes)
//   clients/iOS/MomoiOSKit/Sources/MomoiOSKit/PushRegistration.swift:88-105
// The Swift client is the reference implementation and is still shipping, so the
// body below is deliberately identical field for field.
// =============================================================================

export interface RegisterDeviceInput {
  workspaceId: string;
  /** Stable per-install UUID. Not the APNs token — that rotates. */
  deviceId: string;
  /** Lowercase hex of the APNs token bytes. */
  apnsToken: string;
  env: ApnsEnvironment;
  appBuild: string | null;
}

export type RegisterDeviceOutcome =
  | {kind: 'registered'}
  /** 409 RegistrationConflict — the server says retry (devices.rs:41-66). */
  | {kind: 'retryable'; status: number}
  /** 403 / 404 / other 4xx: retrying cannot help. */
  | {kind: 'rejected'; status: number}
  | {kind: 'unreachable'; reason: string};

function authHeaders(): Headers {
  const headers = new Headers({'Content-Type': 'application/json'});
  const token = coreSession().getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/**
 * POST the APNs token for this device.
 *
 * 201 on first registration, 200 when an existing device refreshes its token
 * (devices.rs:99-103) — both are success, and treating 200 as "already done" or
 * 201 as "unexpected" would be wrong on alternate launches.
 */
export async function registerDevice(
  input: RegisterDeviceInput,
): Promise<RegisterDeviceOutcome> {
  const body = JSON.stringify({
    deviceId: input.deviceId,
    platform: 'ios',
    appBuild: input.appBuild,
    apnsToken: input.apnsToken,
    env: input.env,
    topic: PUSH_TOPIC,
  });

  let response: HttpResponse;
  try {
    response = await fetchWithDeadline(
      `${apiBase()}/v1/workspaces/${input.workspaceId}/devices`,
      {method: 'POST', headers: authHeaders(), body},
    );
  } catch (cause) {
    return {
      kind: 'unreachable',
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (response.ok) return {kind: 'registered'};
  if (response.status === 409) return {kind: 'retryable', status: 409};
  return {kind: 'rejected', status: response.status};
}

/**
 * Deadline for the sign-out DELETE (#2677 review L6).
 *
 * The request runs inside the core's `beforeRevoke` window, and the core
 * AWAITS it before `POST /v1/auth/logout` — the call that actually ends the
 * session (and, on a current server, the registration with it). On the shared
 * 15-second deadline a stalled DELETE held that revocation back for up to 15
 * seconds, and an app killed in that window lost both requests. The session
 * connection is warm when a person signs out, so a healthy server answers in
 * well under a second; 4 seconds still covers a slow cellular link with a fresh
 * TLS handshake, while capping the delay the revocation can suffer. Losing the
 * DELETE on a stalled link costs little: the current server ends the
 * registration with the session.
 */
export const REVOKE_DEVICE_TIMEOUT_MS = 4_000;

/**
 * Revoke this device on sign-out (ADR-0120 D4), so the server stops sending
 * pushes a signed-out phone can no longer resolve — which the notification
 * extension would otherwise show as the relay's placeholder, badge included
 * (#2677).
 *
 * `accessToken` is explicit because the caller runs after the local wipe:
 * `logout()` clears the session store first, so `authHeaders()` would send
 * nothing. It is the leaving session's token, captured by the core and handed
 * to `beforeRevoke`, and this request has to land before `/v1/auth/logout`
 * kills it.
 *
 * Best effort. A server that ends a session's registrations itself (#2677
 * server half) does not need this call; an older self-hosted one does, and on
 * either it makes the device row's state true immediately.
 *
 * Bounded by {@link REVOKE_DEVICE_TIMEOUT_MS}, not the shared 15-second
 * deadline, because the server revocation waits for it.
 */
export async function revokeDevice(
  workspaceId: string,
  deviceId: string,
  accessToken: string,
): Promise<boolean> {
  try {
    const response = await fetchWithDeadline(
      `${apiBase()}/v1/workspaces/${workspaceId}/devices/${deviceId}`,
      {method: 'DELETE', headers: {Authorization: `Bearer ${accessToken}`}},
      REVOKE_DEVICE_TIMEOUT_MS,
    );
    return response.ok;
  } catch {
    return false;
  }
}

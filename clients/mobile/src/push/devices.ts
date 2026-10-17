import {ApiError, authedRequest, rotateAfterUnauthorized} from '@momo/core/lib/api';
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

  const url = `${apiBase()}/v1/workspaces/${input.workspaceId}/devices`;
  let response: HttpResponse;
  try {
    response = await fetchWithDeadline(url, {
      method: 'POST',
      headers: authHeaders(),
      body,
    });
    // 한 번만 회전하고 다시 보낸다 (#3924). 등록은 대개 앱을 켠 직후, 방금 회전한 토큰으로
    // 일어났다. 이제는 사람이 스위치를 켠 **그때**도 등록한다 — 시트를 열어 둔 채 15분
    // 수명이 지난 access 토큰으로 가는 것이 현실이다. 그 401 을 「거부됨」으로 읽으면
    // 재시도 없이 끝나 스위치만 켜진 채 등록이 없다. 끝난 세션을 선언하는 일
    // (`markAuthExpired`)은 이 호출의 몫이 아니다 — 회전해도 401 이면 그대로 `rejected` 로
    // 둔다. 갱신이 서버에 닿지 못하면 코어가 `NetworkError` 를 던지고, 아래 catch 가
    // `unreachable` 로 접어 재시도 정책이 일하게 한다 (#4008).
    if (
      response.status === 401 &&
      coreSession().getRefreshToken() !== null &&
      (await rotateAfterUnauthorized())
    ) {
      response = await fetchWithDeadline(url, {
        method: 'POST',
        headers: authHeaders(),
        body,
      });
    }
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

export type RevokeOwnDeviceOutcome =
  /** 서버가 이 기기의 살아 있는 토큰을 무효로 했다. 두 번째 호출도 이 답이다(멱등). */
  | {kind: 'revoked'}
  /**
   * 404 — 서버에 이 기기 행이 없다. 등록이 서버에 닿은 적이 없다는 뜻이고, 그러면
   * 끌 것이 없다: 「이 폰에 살아 있는 등록이 없다」는 끄려던 결과가 이미 참이다.
   */
  | {kind: 'gone'}
  /** 403·5xx 등 서버가 답하고 거절했다. */
  | {kind: 'rejected'; status: number}
  /** 아무도 답하지 않았다(망·기한). */
  | {kind: 'unreachable'; reason: string};

/**
 * 사람이 푸시 스위치를 껐다 — 이 폰의 서버 등록을 지운다 (#3924, ADR-0204 D1).
 *
 * `revokeDevice` 와 같은 `DELETE` 이지만 **다른 순간**을 위한 다른 함수다. 그쪽은
 * 로그아웃의 `beforeRevoke` 창에서 로컬 세션이 이미 지워진 뒤 떠나는 토큰을 직접
 * 들고 가고, 서버 로그아웃을 붙잡지 않도록 4초에서 끊는다. 이쪽은 세션이 살아 있는
 * 채로 사람이 기다리는 요청이다:
 *
 *   * 15분짜리 access 토큰이 이미 죽었을 수 있다(사람이 시트를 열어 둔 채 앉아 있었다).
 *     코어의 `authedRequest` 가 401 에 한 번 회전하고 다시 보낸다 — 이 요청이 401 로
 *     끝나면 스위치는 꺼졌다고 말하는데 서버는 계속 보낸다.
 *   * 결과를 구분해야 한다. 끝난 것(`revoked`·`gone`)과 끝나지 않은 것(`rejected`·
 *     `unreachable`)을 한 불리언으로 접으면 「이 폰에 등록이 없다」(404)가 실패로 읽혀
 *     한 번도 등록되지 못한 폰은 영영 끌 수 없다.
 */
export async function revokeOwnDevice(
  workspaceId: string,
  deviceId: string,
): Promise<RevokeOwnDeviceOutcome> {
  try {
    await authedRequest(`/v1/workspaces/${workspaceId}/devices/${deviceId}`, {
      method: 'DELETE',
    });
    return {kind: 'revoked'};
  } catch (cause) {
    if (cause instanceof ApiError) {
      return cause.status === 404
        ? {kind: 'gone'}
        : {kind: 'rejected', status: cause.status};
    }
    return {
      kind: 'unreachable',
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

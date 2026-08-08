import {NON_SECRET_KEYS, nonSecretStore} from '../storage/kv';
import {registerDevice, type RegisterDeviceOutcome} from './devices';
import type {ApnsEnvironment} from './native';

// =============================================================================
// Device-registration policy (goal RN-N1).
//
// The retry rule is carried over deliberately from
// `PushNotificationCoordinator.swift:185-227`: try TWICE immediately, and if
// both fail, once more when the app next returns to the foreground — at most
// once, ever.
//
// The 2026-08-02 audit listed this as an asset that a JS rewrite would most
// likely lose (§7.3), and the reason it matters is the failure's shape:
// registration failing is completely invisible. Nothing errors, no screen
// changes; pushes simply never arrive, and the person has no way to tell that
// from "nobody messaged me". Without a retry, one flaky request at launch costs
// every notification until the next cold start.
//
// The bound matters as much as the retry. Unbounded retries against a server
// that is answering 403 would hammer it forever on a phone nobody is looking at.
// =============================================================================

export const IMMEDIATE_ATTEMPTS = 2;

/** Stable per-install device id, minted on first use. */
export function pushDeviceId(): string {
  const store = nonSecretStore();
  const existing = store.getString(NON_SECRET_KEYS.pushDeviceId);
  if (existing) return existing;
  const created = crypto.randomUUID();
  store.set(NON_SECRET_KEYS.pushDeviceId, created);
  return created;
}

export interface PushRegistrationRequest {
  workspaceId: string;
  apnsToken: string;
  env: ApnsEnvironment;
  appBuild: string | null;
}

export interface PushRegistrationResult {
  outcome: RegisterDeviceOutcome;
  attempts: number;
  /** True when the caller should try once more on the next foreground return. */
  owesForegroundRetry: boolean;
}

/** Which failures are worth trying again at all. A 403 means this member may not
 *  register this device; repeating the request cannot change that. */
function worthRetrying(outcome: RegisterDeviceOutcome): boolean {
  return outcome.kind === 'unreachable' || outcome.kind === 'retryable';
}

/**
 * Register, retrying immediately per the policy above.
 *
 * `register` is injectable so the policy can be tested without a server; the
 * default is the real REST call.
 */
export async function registerWithRetry(
  request: PushRegistrationRequest,
  register: typeof registerDevice = registerDevice,
): Promise<PushRegistrationResult> {
  const deviceId = pushDeviceId();
  let outcome: RegisterDeviceOutcome = {
    kind: 'unreachable',
    reason: 'not attempted',
  };

  for (let attempt = 1; attempt <= IMMEDIATE_ATTEMPTS; attempt += 1) {
    outcome = await register({
      workspaceId: request.workspaceId,
      deviceId,
      apnsToken: request.apnsToken,
      env: request.env,
      appBuild: request.appBuild,
    });
    if (outcome.kind === 'registered') {
      return {outcome, attempts: attempt, owesForegroundRetry: false};
    }
    if (!worthRetrying(outcome)) {
      return {outcome, attempts: attempt, owesForegroundRetry: false};
    }
  }

  return {
    outcome,
    attempts: IMMEDIATE_ATTEMPTS,
    owesForegroundRetry: true,
  };
}

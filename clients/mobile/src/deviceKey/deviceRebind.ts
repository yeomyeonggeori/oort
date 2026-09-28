import {
  fetchSigningContext,
  rebindDeviceKey,
  type DeviceKey,
  type SigningContext,
} from '@momo/core/features/auth/deviceKeys';

import {bytesToBase64} from './base64';
import {HumanControlInputError, serverNow} from './humanControl';
import {signWithDeviceKey} from './native';
import {utf8} from './sha256';

// =============================================================================
// The phone's key moves itself onto a new sign-in (#3103; ADR-0146 D-7 증보
// #3097, server PR #3102).
//
// A refresh-token reuse or an expiry ends the sign-in a key was registered
// under WITHOUT revoking the key. The row stays — with its id and the Mac's
// approval — but signs nothing (`lineageLive: false`) until the key itself
// signs `momo.human.device_rebind.v1` naming the caller's new sign-in:
//
//   momo.human.device_rebind.v1
//   {workspace_id}
//   {member_id}
//   {key_id}
//   {public_key_b64}
//   {session_id}        signing-context `sessionId` — the caller's own lineage
//   {signed_at_ms}      server clock ± 5 min
//
// The bytes are momo-wire's `DeviceRebind` (fixture
// `__tests__/fixtures/device-rebind.vector.json`, printed by momo-wire; the
// desktop shell and the Swift allow-list read the same file). The enclave
// signs them only because `MomoDeviceKeyStore.signingSchemas` names this
// schema with exactly 7 lines, and only when the public-key line is its own.
// No password and no new approval: the key's own signature is the proof.
// =============================================================================

export const DEVICE_REBIND_SCHEMA = 'momo.human.device_rebind.v1';

/** Face ID's reason line for a rebind. 해요체 (ADR-0193 D11). */
export const DEVICE_REBIND_REASON = '이 폰의 지시 키를 새 로그인에 다시 연결해요';

export interface DeviceRebindFields {
  workspaceId: string;
  memberId: string;
  keyId: string;
  /** Compressed SEC1, base64 — this enclave's own. */
  publicKey: string;
  /** `signing-context` `sessionId`. */
  sessionId: string;
  signedAtMs: number;
}

function line(name: string, value: string): string {
  // eslint-disable-next-line no-control-regex -- the point is to find them.
  if (value === '' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new HumanControlInputError(`${name} is empty or has a control character`);
  }
  return value;
}

/** The exact 7 lines the key signs. Pure. */
export function deviceRebindBytes(fields: DeviceRebindFields): Uint8Array {
  if (!Number.isSafeInteger(fields.signedAtMs) || fields.signedAtMs <= 0) {
    throw new HumanControlInputError('signedAtMs is not a positive whole number');
  }
  return utf8(
    [
      DEVICE_REBIND_SCHEMA,
      line('workspaceId', fields.workspaceId),
      line('memberId', fields.memberId),
      line('keyId', fields.keyId),
      line('publicKey', fields.publicKey),
      line('sessionId', fields.sessionId),
      String(fields.signedAtMs),
    ].join('\n'),
  );
}

/** A rebind this sign-in cannot make: the server gave no lineage (a server
 *  from before #3097, or a sign-in from before lineages). */
export class RebindUnavailableError extends Error {
  constructor() {
    super('device_key_no_session');
    this.name = 'RebindUnavailableError';
  }
}

export interface RebindDeps {
  context: (workspaceId: string) => Promise<SigningContext>;
  sign: (message: Uint8Array, reason: string) => Promise<Uint8Array>;
  post: typeof rebindDeviceKey;
  now: () => number;
}

const DEFAULT_DEPS: RebindDeps = {
  context: fetchSigningContext,
  sign: signWithDeviceKey,
  post: rebindDeviceKey,
  now: () => Date.now(),
};

/**
 * Move `row` (this phone's live key on an ended sign-in) onto the caller's
 * sign-in: read the signing context (its `sessionId`, its clock), build the
 * letter, Face ID, post it. Resolves with the moved row, which
 * `rebindDeviceKey` has already checked is `current` — anything else rejects
 * (`DeviceKeyRebindError`), and the caller says so.
 */
export async function rebindPhoneKey(
  input: {workspaceId: string; memberId: string; row: DeviceKey; publicKey: string},
  deps: RebindDeps = DEFAULT_DEPS,
): Promise<DeviceKey> {
  const before = deps.now();
  const context = await deps.context(input.workspaceId);
  const readAt = Math.round((before + deps.now()) / 2);
  if (!context.sessionId) throw new RebindUnavailableError();
  const signedAtMs = Math.round(serverNow(context, readAt, deps.now()));
  const bytes = deviceRebindBytes({
    workspaceId: input.workspaceId,
    memberId: input.memberId,
    keyId: input.row.id,
    publicKey: input.publicKey,
    sessionId: context.sessionId,
    signedAtMs,
  });
  const signature = await deps.sign(bytes, DEVICE_REBIND_REASON);
  return deps.post(input.workspaceId, {
    publicKey: input.publicKey,
    platform: 'ios',
    label: input.row.label,
    rebind: {signedAtMs, signature: bytesToBase64(signature)},
  });
}

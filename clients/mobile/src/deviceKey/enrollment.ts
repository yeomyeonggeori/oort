import {
  DEVICE_KEY_REFUSAL,
  listDeviceKeys,
  registerPhoneDeviceKey,
  type DeviceKey,
} from '@momo/core/features/auth/deviceKeys';
import {ApiError} from '@momo/core/lib/api';

import {deviceKeyFingerprint} from './fingerprint';
import {
  createDeviceKey,
  deleteDeviceKey,
  DeviceKeyError,
  deviceKeyPublicKey,
  deviceKeyStatus,
  type DeviceKeyStatus,
} from './native';

// =============================================================================
// 「지시 기기」 — the phone's key, registered and waiting for the root Mac
// (#3026 stage 2; ADR-0146 개정 2026-09-28 D-2 · D-6 ② · D-7).
//
//   QR 연결 ─> 키 생성(Face ID 불필요) ─> 서버 등록(「지시 불가」 unendorsed)
//          ─> 맥이 지문을 보여 주고 `device_endorse.v1` 서명 ─> endorsed(승인됨)
//
// Two rules this file carries:
//
// 1. **Nothing here deletes a key on its own.** `invalidated` is shown, and the
//    person presses 「새 키로 다시 등록」 (`replaceInvalidatedKey`), which checks
//    the status again first. A quiet re-registration would hand the Mac a key it
//    has never seen under a label it trusts. The only other deletion is sign-out
//    (`forgetDeviceKeyOnSignOut`): the server ends the key with the lineage
//    (D-7), and a key no row honours must not outlive the person on a shared
//    phone.
// 2. **The server row is found by public key**, not by `current`: a key whose
//    lineage ended (refresh reuse, the Mac unlinking this phone) still has a
//    row — `revoked` — and that is what the person needs to see.
// =============================================================================

/** What the 「지시 기기」 surfaces show. */
export type DeviceKeyView =
  | {kind: 'loading'}
  /** No Secure Enclave (every simulator), or the module is not in this build. */
  | {kind: 'unsupported'}
  /** The build lacks the keychain group entitlement. */
  | {kind: 'misconfigured'}
  /** No key, and Face ID is not set up or is off for this app. */
  | {kind: 'biometryOff'}
  /** Face ID re-enrolled — the key can never sign again (D-2). */
  | {kind: 'invalidated'}
  /** No key yet, or a key the server has no row for. */
  | {kind: 'unregistered'; fingerprint: string | null}
  | {kind: 'pending'; fingerprint: string; row: DeviceKey; biometryOff: boolean}
  | {kind: 'approved'; fingerprint: string; row: DeviceKey; biometryOff: boolean}
  | {kind: 'revoked'; fingerprint: string; row: DeviceKey; biometryOff: boolean}
  /** The key is here but the server list did not load. */
  | {kind: 'serverError'; fingerprint: string}
  | {kind: 'localError'};

export interface LocalDeviceKey {
  status: DeviceKeyStatus;
  /** Compressed SEC1, base64 — null when there is no readable key. */
  publicKey: string | null;
}

/** Reads the enclave side. A module absent from this build is `unsupported`. */
export async function readLocalDeviceKey(): Promise<LocalDeviceKey> {
  const status = await deviceKeyStatus();
  if (status !== 'ready' && status !== 'biometryUnavailable') {
    return {status, publicKey: null};
  }
  const key = await deviceKeyPublicKey();
  return {status, publicKey: key?.publicKey ?? null};
}

/** The row for `publicKey`: the live one when there is one, otherwise the
 *  newest revoked one. Several rows can share a key — a re-registration after a
 *  revoke makes a new row (the server's uniqueness is live-only). */
export function rowForPublicKey(
  rows: readonly DeviceKey[],
  publicKey: string,
): DeviceKey | undefined {
  const mine = rows
    .filter(row => row.platform === 'ios' && row.publicKey === publicKey)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  return mine.find(row => row.state !== 'revoked') ?? mine[0];
}

export function deriveDeviceKeyView(input: {
  local: LocalDeviceKey | undefined;
  localError: unknown;
  rows: readonly DeviceKey[] | undefined;
  rowsError: unknown;
}): DeviceKeyView {
  const {local, localError, rows, rowsError} = input;
  if (localError) {
    const code = localError instanceof DeviceKeyError ? localError.code : null;
    if (code === 'DEVICE_KEY_NOT_LINKED' || code === 'DEVICE_KEY_UNSUPPORTED') {
      return {kind: 'unsupported'};
    }
    if (code === 'DEVICE_KEY_MISCONFIGURED') return {kind: 'misconfigured'};
    return {kind: 'localError'};
  }
  if (!local) return {kind: 'loading'};
  switch (local.status) {
    case 'unsupported':
      return {kind: 'unsupported'};
    case 'invalidated':
      return {kind: 'invalidated'};
    case 'absent':
      return {kind: 'unregistered', fingerprint: null};
    case 'biometryUnavailable':
    case 'ready':
      break;
  }
  if (local.publicKey === null) {
    // `biometryUnavailable` with no key: Face ID is not there to bind one to.
    return local.status === 'biometryUnavailable'
      ? {kind: 'biometryOff'}
      : {kind: 'localError'};
  }
  const fingerprint = deviceKeyFingerprint(local.publicKey);
  if (fingerprint === null) return {kind: 'localError'};
  if (rowsError) return {kind: 'serverError', fingerprint};
  if (!rows) return {kind: 'loading'};
  const row = rowForPublicKey(rows, local.publicKey);
  if (!row) return {kind: 'unregistered', fingerprint};
  const biometryOff = local.status === 'biometryUnavailable';
  switch (row.state) {
    case 'unendorsed':
      return {kind: 'pending', fingerprint, row, biometryOff};
    case 'endorsed':
    case 'root':
      return {kind: 'approved', fingerprint, row, biometryOff};
    case 'revoked':
      return {kind: 'revoked', fingerprint, row, biometryOff};
  }
}

// ---- actions ------------------------------------------------------------------

export type EnrollOutcome =
  | {kind: 'registered'; publicKey: string}
  | {kind: 'unsupported'}
  | {kind: 'biometryOff'}
  | {kind: 'invalidated'};

/** A failure with a sentence for the person. */
export class EnrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollError';
  }
}

function enrollFailure(error: unknown): EnrollError {
  if (error instanceof EnrollError) return error;
  if (error instanceof DeviceKeyError) {
    switch (error.code) {
      case 'DEVICE_KEY_MISCONFIGURED':
        return new EnrollError(
          '이 빌드에는 서명 키를 보관할 권한이 없습니다. 팀 배포 앱에서 하세요.',
        );
      default:
        return new EnrollError('이 폰의 서명 키를 만들지 못했습니다. 다시 시도하세요.');
    }
  }
  if (error instanceof ApiError) {
    if (error.code === DEVICE_KEY_REFUSAL.lineageEnded) {
      return new EnrollError(
        '이 로그인으로는 더 이상 키를 등록할 수 없습니다. 다시 로그인하세요.',
      );
    }
    if (error.status === 403) {
      return new EnrollError('이 워크스페이스에서 키를 등록할 수 없습니다.');
    }
  }
  return new EnrollError(
    '지시 기기로 등록하지 못했습니다. 연결을 확인하고 다시 시도하세요.',
  );
}

async function register(
  workspaceId: string,
  label: string,
  publicKey: string,
): Promise<void> {
  try {
    await registerPhoneDeviceKey(workspaceId, {publicKey, label});
  } catch (error) {
    // Already live — a retry after a lost response. The list tells the rest.
    if (
      error instanceof ApiError &&
      error.code === DEVICE_KEY_REFUSAL.alreadyRegistered
    ) {
      const rows = await listDeviceKeys(workspaceId);
      const row = rowForPublicKey(rows, publicKey);
      if (row && row.state !== 'revoked') return;
    }
    throw error;
  }
}

/**
 * Makes sure this phone's key exists and has a live row: creates one if there
 * is none, and (re-)registers a key the server has no live row for. Never
 * deletes: `invalidated` comes back as an outcome for the person to act on.
 */
export async function enrollDeviceKey(input: {
  workspaceId: string;
  label: string;
}): Promise<EnrollOutcome> {
  try {
    const local = await readLocalDeviceKey();
    let publicKey: string;
    switch (local.status) {
      case 'unsupported':
        return {kind: 'unsupported'};
      case 'invalidated':
        return {kind: 'invalidated'};
      case 'absent':
        publicKey = await createOrReuse();
        break;
      case 'biometryUnavailable':
      case 'ready':
        if (local.publicKey === null) {
          if (local.status === 'biometryUnavailable') return {kind: 'biometryOff'};
          throw new EnrollError('이 폰의 서명 키를 읽지 못했습니다. 다시 시도하세요.');
        }
        publicKey = local.publicKey;
        break;
    }
    const rows = await listDeviceKeys(input.workspaceId);
    const row = rowForPublicKey(rows, publicKey);
    if (!row || row.state === 'revoked') {
      await register(input.workspaceId, input.label, publicKey);
    }
    return {kind: 'registered', publicKey};
  } catch (error) {
    if (
      error instanceof DeviceKeyError &&
      error.code === 'DEVICE_KEY_BIOMETRY_UNAVAILABLE'
    ) {
      return {kind: 'biometryOff'};
    }
    if (
      error instanceof DeviceKeyError &&
      (error.code === 'DEVICE_KEY_UNSUPPORTED' || error.code === 'DEVICE_KEY_NOT_LINKED')
    ) {
      return {kind: 'unsupported'};
    }
    throw enrollFailure(error);
  }
}

/** `create`, or — when another call made one between the status read and
 *  here (the native side serializes creates) — the key that now exists. */
async function createOrReuse(): Promise<string> {
  try {
    return (await createDeviceKey()).publicKey;
  } catch (error) {
    if (error instanceof DeviceKeyError && error.code === 'DEVICE_KEY_ALREADY_EXISTS') {
      const existing = await deviceKeyPublicKey();
      if (existing) return existing.publicKey;
    }
    throw error;
  }
}

/**
 * The person pressed 「새 키로 다시 등록」 on an invalidated key. Re-reads the
 * status first: only a key the enclave has PROVEN unusable is deleted
 * (`native.ts` `invalidated`), so a stale screen cannot delete a good key.
 */
export async function replaceInvalidatedKey(input: {
  workspaceId: string;
  label: string;
}): Promise<EnrollOutcome> {
  let status: DeviceKeyStatus;
  try {
    status = await deviceKeyStatus();
  } catch (error) {
    throw enrollFailure(error);
  }
  if (status !== 'invalidated') return enrollDeviceKey(input);
  try {
    await deleteDeviceKey();
  } catch (error) {
    throw enrollFailure(error);
  }
  return enrollDeviceKey(input);
}

/**
 * Sign-out: the server revokes this lineage's key (D-7); the enclave key goes
 * with it so the next sign-in — possibly someone else's — starts from a fresh
 * key the Mac approves anew. Fire and forget, like the rest of sign-out.
 */
export function forgetDeviceKeyOnSignOut(): void {
  deleteDeviceKey().catch(() => {
    // Not linked (simulator) or nothing to delete: the same end state.
  });
}

import { requireOptionalNativeModule } from 'expo-modules-core';
import type {
  RefreshDeviceProof,
  RefreshProofRequest,
} from '@momo/core/runtime/host';

import { base64ToBytes } from './base64';

// =============================================================================
// The phone's REFRESH key (#3106; ADR-0146 D-7 증보 #3079) — the JS side of
// `MomoRefreshKeyStore.swift`.
//
// Every `POST /v1/auth/refresh` carries `momo.human.refresh_proof.v1`, signed by
// a Secure Enclave P-256 key that is NOT the instruction key: PrivateKeyUsage
// only (no Face ID — refreshes run in the background), AfterFirstUnlock
// ThisDeviceOnly, the app-only keychain group. The core asks through
// `SessionPort.signRefreshProof` (`src/storage/secureSession.ts`).
//
// What crosses the bridge is typed fields in and a proof out. Native builds the
// bytes, picks the nonce and signs only that statement; there is no call here
// that hands native bytes to sign with this key.
//
// `null` means "this device has no refresh key" — every simulator, a build
// without the module, a build without the access group. The refresh then goes
// without a proof, which a server in `observe` answers as before.
// =============================================================================

interface NativeRefreshProof {
  publicKey: string;
  nonce: string;
  signedAtMs: number;
  signature: string;
}

interface MomoRefreshKeyNativeModule {
  readonly secureEnclaveAvailable: boolean;
  signRefreshProof(
    workspaceId: string,
    memberId: string,
    refreshToken: string,
    signedAtMs: number,
  ): Promise<NativeRefreshProof>;
}

const defaultModule = requireOptionalNativeModule<MomoRefreshKeyNativeModule>(
  'MomoDeviceKeyNative',
);

/** Refusals that mean "no key can exist here", not a fault. */
const NO_KEY_CODES = new Set(['DEVICE_KEY_UNSUPPORTED', 'DEVICE_KEY_MISCONFIGURED']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The proof native returned, checked: a malformed one would only fail on the
 *  server, where under `require` it reads as another key's. */
function checked(
  proof: NativeRefreshProof | null | undefined,
  signedAtMs: number,
): RefreshDeviceProof {
  const key = typeof proof?.publicKey === 'string' ? base64ToBytes(proof.publicKey) : null;
  const signature =
    typeof proof?.signature === 'string' ? base64ToBytes(proof.signature) : null;
  if (
    !proof ||
    !key ||
    key.length !== 33 ||
    (key[0] !== 0x02 && key[0] !== 0x03) ||
    !signature ||
    signature.length !== 64 ||
    typeof proof.nonce !== 'string' ||
    !UUID.test(proof.nonce) ||
    proof.signedAtMs !== signedAtMs
  ) {
    throw new Error('native returned a malformed refresh proof');
  }
  return {
    publicKey: proof.publicKey,
    nonce: proof.nonce,
    signedAtMs: proof.signedAtMs,
    signature: proof.signature,
  };
}

/** True only when this binary links the module AND the hardware has an
 *  enclave — the only case where a refresh key can exist. False on every
 *  simulator, so the gate builds keep their exact refresh count. */
export function refreshKeySupported(
  native: MomoRefreshKeyNativeModule | null = defaultModule,
): boolean {
  return native?.secureEnclaveAvailable === true;
}

/**
 * `SessionPort.signRefreshProof` for the phone. Null when this device has no
 * refresh key; rejects on a real failure (the core then refreshes without a
 * proof).
 */
export async function signRefreshProof(
  request: RefreshProofRequest,
  native: MomoRefreshKeyNativeModule | null = defaultModule,
): Promise<RefreshDeviceProof | null> {
  if (!native || native.secureEnclaveAvailable !== true) return null;
  const signedAtMs = Math.round(request.signedAtMs);
  try {
    return checked(
      await native.signRefreshProof(
        request.workspaceId,
        request.memberId,
        request.refreshToken,
        signedAtMs,
      ),
      signedAtMs,
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && NO_KEY_CODES.has(code)) return null;
    throw error;
  }
}

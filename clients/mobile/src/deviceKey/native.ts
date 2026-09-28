import { requireOptionalNativeModule } from 'expo-modules-core';

import { base64ToBytes, bytesToBase64 } from './base64';

// =============================================================================
// The phone's human device key (issue #3026 stage 1; ADR-0146 개정 2026-09-28
// D-1·D-2).
//
// `modules/momo-device-key-native` holds a Secure Enclave P-256 key guarded by
// `biometryCurrentSet` in the app-only keychain group
// `$(AppIdentifierPrefix)app.momo.ios.devicekey`. This file is the whole JS
// surface. What it can hand out is public by construction:
//
//   - the compressed SEC1 public key (33 bytes, base64)
//   - raw r‖s ECDSA-P256-SHA256 signatures (64 bytes) over an E1 payload the
//     CALLER builds (#3021). Native signs nothing else: exactly a 13-line
//     `momo.human.control.v1` payload, otherwise DEVICE_KEY_PAYLOAD_REJECTED
//     (MomoDeviceKeyStore `checkSigningPayload`). Endorsements and revocations
//     are the root Mac's to sign (ADR-0146 D-6/D-7). This stage registers the key nowhere (E2 #3022).
//
// There is no function, native or JS, that returns the private key or the
// enclave handle.
//
// Both returned shapes are re-checked here. The native side is trusted to do
// the right thing, but a 65-byte uncompressed key or a DER signature would
// otherwise travel to the server and fail there, far from the cause.
//
// No software fallback anywhere: a device without a Secure Enclave (every
// simulator) reports `unsupported` and every operation rejects with
// DEVICE_KEY_UNSUPPORTED. A software key would look identical to the server and
// silently void the "hardware-bound" guarantee ADR-0146 D-1 rests on.
// =============================================================================

/** The keychain access group, WITHOUT the team prefix. Must match the app's
 *  entitlements and `MomoDeviceKeyStore.accessGroupSuffix`
 *  (`__tests__/deviceKeyContract.test.ts`). */
export const DEVICE_KEY_ACCESS_GROUP = 'app.momo.ios.devicekey';

/** `alg` for the server-side key row (ADR-0146 D-1). */
export const DEVICE_KEY_ALG = 'p256' as const;

export const DEVICE_KEY_PUBLIC_KEY_BYTES = 33;
export const DEVICE_KEY_SIGNATURE_BYTES = 64;

/** The Face ID prompt's reason line when the caller gives none. 해요체. */
export const DEFAULT_SIGN_REASON = '에이전트에게 보낼 지시를 확인해요';

/**
 * - `biometryUnavailable`: Face ID cannot be used right now. With a key this
 *   means Face ID is off for the app or temporarily unavailable — the key is
 *   intact; do NOT delete it.
 * - `invalidated`: reported only on proof (the enclave rejects the handle, or
 *   the enrolled biometry is gone). Safe to delete and re-create. A Face ID
 *   re-enrollment is proven at the next sign, which rejects
 *   DEVICE_KEY_INVALIDATED; DEVICE_KEY_FAILED is never a reason to delete.
 */
export type DeviceKeyStatus =
  | 'unsupported'
  | 'biometryUnavailable'
  | 'absent'
  | 'ready'
  | 'invalidated';

const STATUSES: ReadonlySet<string> = new Set<DeviceKeyStatus>([
  'unsupported',
  'biometryUnavailable',
  'absent',
  'ready',
  'invalidated',
]);

/** Mirrors `MomoDeviceKeyFailure.code` in MomoDeviceKeyStore.swift, plus two
 *  JS-side codes: NOT_LINKED (native module absent) and MALFORMED (native
 *  returned a shape this file refuses). */
export const DEVICE_KEY_ERROR_CODES = [
  'DEVICE_KEY_UNSUPPORTED',
  'DEVICE_KEY_BIOMETRY_UNAVAILABLE',
  'DEVICE_KEY_MISCONFIGURED',
  'DEVICE_KEY_ALREADY_EXISTS',
  'DEVICE_KEY_ABSENT',
  'DEVICE_KEY_INVALIDATED',
  'DEVICE_KEY_CANCELLED',
  'DEVICE_KEY_LOCKED_OUT',
  'DEVICE_KEY_PAYLOAD_REJECTED',
  'DEVICE_KEY_FAILED',
  'DEVICE_KEY_NOT_LINKED',
  'DEVICE_KEY_MALFORMED',
] as const;

export type DeviceKeyErrorCode = (typeof DEVICE_KEY_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(DEVICE_KEY_ERROR_CODES);

export class DeviceKeyError extends Error {
  readonly code: DeviceKeyErrorCode;
  constructor(code: DeviceKeyErrorCode, message: string) {
    super(message);
    this.name = 'DeviceKeyError';
    this.code = code;
  }
}

export interface DeviceKeyPublic {
  readonly alg: typeof DEVICE_KEY_ALG;
  /** Compressed SEC1, standard base64 (44 chars). */
  readonly publicKey: string;
}

interface MomoDeviceKeyNativeModule {
  readonly secureEnclaveAvailable: boolean;
  status(): Promise<string>;
  create(): Promise<string>;
  publicKey(): Promise<string | null>;
  sign(messageBase64: string, reason: string): Promise<string>;
  remove(): Promise<void>;
}

const nativeModule = requireOptionalNativeModule<MomoDeviceKeyNativeModule>(
  'MomoDeviceKeyNative',
);

function linked(): MomoDeviceKeyNativeModule {
  if (!nativeModule) {
    throw new DeviceKeyError(
      'DEVICE_KEY_NOT_LINKED',
      'MomoDeviceKeyNative is not linked into this build',
    );
  }
  return nativeModule;
}

/** Native rejections carry `code`; anything else becomes DEVICE_KEY_FAILED. */
function translate(error: unknown): DeviceKeyError {
  if (error instanceof DeviceKeyError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === 'string' && KNOWN_CODES.has(code)
    ? new DeviceKeyError(code as DeviceKeyErrorCode, message)
    : new DeviceKeyError('DEVICE_KEY_FAILED', message);
}

async function call<T>(
  body: (m: MomoDeviceKeyNativeModule) => Promise<T>,
): Promise<T> {
  const m = linked();
  try {
    return await body(m);
  } catch (error) {
    throw translate(error);
  }
}

function checkedPublicKey(value: unknown): string {
  const bytes = typeof value === 'string' ? base64ToBytes(value) : null;
  if (
    !bytes ||
    bytes.length !== DEVICE_KEY_PUBLIC_KEY_BYTES ||
    (bytes[0] !== 0x02 && bytes[0] !== 0x03)
  ) {
    throw new DeviceKeyError(
      'DEVICE_KEY_MALFORMED',
      'native returned a public key that is not compressed SEC1 P-256 (33 bytes, 0x02/0x03)',
    );
  }
  return value as string;
}

/** True only when this binary links the module AND the hardware has an
 *  enclave. False on every simulator. */
export function deviceKeySupported(): boolean {
  return nativeModule?.secureEnclaveAvailable === true;
}

export async function deviceKeyStatus(): Promise<DeviceKeyStatus> {
  if (!nativeModule) return 'unsupported';
  const status = await call(m => m.status());
  if (!STATUSES.has(status)) {
    throw new DeviceKeyError(
      'DEVICE_KEY_MALFORMED',
      `unknown status "${status}"`,
    );
  }
  return status as DeviceKeyStatus;
}

/** Creates the key. Rejects DEVICE_KEY_ALREADY_EXISTS when one exists — call
 *  `deleteDeviceKey` first; replacing a key silently would orphan its
 *  endorsement (ADR-0146 D-6). */
export async function createDeviceKey(): Promise<DeviceKeyPublic> {
  const publicKey = checkedPublicKey(await call(m => m.create()));
  return { alg: DEVICE_KEY_ALG, publicKey };
}

export async function deviceKeyPublicKey(): Promise<DeviceKeyPublic | null> {
  const value = await call(m => m.publicKey());
  if (value === null || value === undefined) return null;
  return { alg: DEVICE_KEY_ALG, publicKey: checkedPublicKey(value) };
}

/**
 * Signs `message` with Face ID. Returns raw r‖s (64 bytes). `message` must be
 * an E1 signing payload (see the header); anything else rejects
 * DEVICE_KEY_PAYLOAD_REJECTED before Face ID is raised.
 */
export async function signWithDeviceKey(
  message: Uint8Array,
  reason: string = DEFAULT_SIGN_REASON,
): Promise<Uint8Array> {
  if (message.length === 0) {
    throw new DeviceKeyError(
      'DEVICE_KEY_FAILED',
      'refusing to sign an empty message',
    );
  }
  if (reason.trim().length === 0) {
    throw new DeviceKeyError(
      'DEVICE_KEY_FAILED',
      'Face ID needs a reason line',
    );
  }
  const signature = await call(m => m.sign(bytesToBase64(message), reason));
  const bytes = typeof signature === 'string' ? base64ToBytes(signature) : null;
  if (!bytes || bytes.length !== DEVICE_KEY_SIGNATURE_BYTES) {
    throw new DeviceKeyError(
      'DEVICE_KEY_MALFORMED',
      'native returned a signature that is not raw r‖s (64 bytes)',
    );
  }
  return bytes;
}

export async function deleteDeviceKey(): Promise<void> {
  await call(m => m.remove());
}

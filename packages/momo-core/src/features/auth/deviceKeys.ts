// =============================================================================
// Human device keys (ADR-0146 개정 2026-09-28 R2: D-1 · D-6 · D-7; #3025 E5).
//
// Server half is E2 (#3022, `bins/momo-server/src/routes/device_keys.rs`):
//
//   POST /v1/workspaces/{ws}/device-keys                    register (macos: password)
//   GET  /v1/workspaces/{ws}/device-keys                    the caller's own keys
//   POST /v1/workspaces/{ws}/device-keys/{key}/endorsement  device_endorse.v1
//   POST /v1/workspaces/{ws}/device-keys/{key}/revocation   device_revoke.v1
//
// Signing never happens here: the host Mac's desktop shell holds the Secure
// Enclave key and builds every signed statement itself (clients/desktop
// `device_key`). This module is the wire, the parsers and the refusal copy.
// (The fingerprint lives in clients/web: see `deviceKeysShared.ts`.)
// =============================================================================

import { settingsRequest } from "../settings/api";
import { arrayField, bool, num, record, str, WireShapeError } from "../../lib/wire";

export type DeviceKeyState = "root" | "endorsed" | "unendorsed" | "revoked";

/** `DeviceKeyDto`. `canInstruct` is the server's advisory `root|endorsed`. */
export interface DeviceKey {
  id: string;
  workspaceId: string;
  memberId: string;
  alg: string;
  publicKey: string;
  platform: string;
  label: string;
  state: DeviceKeyState;
  canInstruct: boolean;
  /** Registered under the caller's own sign-in. */
  current: boolean;
  endorsedByKeyId?: string;
  endorsedAtMs?: number;
  createdAtMs: number;
  revokedAtMs?: number;
  revokedReason?: string;
  revokedByKeyId?: string;
  revocationSignature?: string;
  revocationSignedAtMs?: number;
}

const STATES: readonly DeviceKeyState[] = ["root", "endorsed", "unendorsed", "revoked"];

export function parseDeviceKey(value: unknown): DeviceKey {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const workspaceId = str(source, "workspaceId");
  const memberId = str(source, "memberId");
  const alg = str(source, "alg");
  const publicKey = str(source, "publicKey");
  const platform = str(source, "platform");
  const label = str(source, "label") ?? "";
  const state = str(source, "state");
  const canInstruct = bool(source, "canInstruct");
  const current = bool(source, "current");
  const createdAtMs = num(source, "createdAtMs");
  if (
    !id ||
    !workspaceId ||
    !memberId ||
    !alg ||
    !publicKey ||
    !platform ||
    !state ||
    !(STATES as readonly string[]).includes(state) ||
    canInstruct === undefined ||
    current === undefined ||
    createdAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  const optional = <K extends keyof DeviceKey>(key: K, v: DeviceKey[K] | undefined) =>
    v === undefined ? {} : { [key]: v };
  return {
    id,
    workspaceId,
    memberId,
    alg,
    publicKey,
    platform,
    label,
    state: state as DeviceKeyState,
    canInstruct,
    current,
    createdAtMs,
    ...optional("endorsedByKeyId", str(source, "endorsedByKeyId")),
    ...optional("endorsedAtMs", num(source, "endorsedAtMs")),
    ...optional("revokedAtMs", num(source, "revokedAtMs")),
    ...optional("revokedReason", str(source, "revokedReason")),
    ...optional("revokedByKeyId", str(source, "revokedByKeyId")),
    ...optional("revocationSignature", str(source, "revocationSignature")),
    ...optional("revocationSignedAtMs", num(source, "revocationSignedAtMs")),
  };
}

function base(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/device-keys`;
}

function one(value: unknown): DeviceKey {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  return parseDeviceKey(source["deviceKey"]);
}

export async function listDeviceKeys(workspaceId: string): Promise<DeviceKey[]> {
  const res = await settingsRequest<unknown>(base(workspaceId), { cache: "no-store" });
  const rows = arrayField(res, "deviceKeys");
  if (rows === null) throw new WireShapeError();
  return rows.map(parseDeviceKey);
}

/** Register this Mac's enclave key as a root candidate. The password is required
 * for `macos` (E2 review H1) and is sent only in this body. */
export async function registerRootDeviceKey(
  workspaceId: string,
  input: { publicKey: string; label: string; currentPassword: string }
): Promise<DeviceKey> {
  return one(
    await settingsRequest<unknown>(base(workspaceId), {
      method: "POST",
      body: JSON.stringify({
        alg: "p256",
        publicKey: input.publicKey,
        platform: "macos",
        label: input.label,
        currentPassword: input.currentPassword,
      }),
    })
  );
}

export async function submitEndorsement(
  workspaceId: string,
  targetKeyId: string,
  letter: { rootKeyId: string; signature: string }
): Promise<DeviceKey> {
  return one(
    await settingsRequest<unknown>(
      `${base(workspaceId)}/${encodeURIComponent(targetKeyId)}/endorsement`,
      { method: "POST", body: JSON.stringify(letter) }
    )
  );
}

export async function submitRevocation(
  workspaceId: string,
  targetKeyId: string,
  letter: { rootKeyId: string; revokedAtMs: number; signature: string }
): Promise<DeviceKey> {
  return one(
    await settingsRequest<unknown>(
      `${base(workspaceId)}/${encodeURIComponent(targetKeyId)}/revocation`,
      { method: "POST", body: JSON.stringify(letter) }
    )
  );
}

// ---- refusals the panel answers by name (E2 `REFUSAL_*`) --------------------

export const DEVICE_KEY_REFUSAL = {
  rootPasswordRequired: "device_root_password_required",
  rootLinkedSession: "device_root_linked_session",
  alreadyRegistered: "device_key_already_registered",
  lineageEnded: "session_lineage_ended",
} as const;

// ---- views ------------------------------------------------------------------

/** A phone key the root can act on: live phone keys, newest first. */
export function phoneKeys(keys: readonly DeviceKey[]): DeviceKey[] {
  return keys
    .filter((key) => key.platform === "ios" && key.state !== "revoked")
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** This Mac's live row for `publicKey`, if the server has one. */
export function rootRowFor(
  keys: readonly DeviceKey[],
  publicKey: string
): DeviceKey | undefined {
  return keys.find(
    (key) => key.platform === "macos" && key.publicKey === publicKey && key.state === "root"
  );
}

/**
 * The live phone key a linked-device row stands for, only when exactly one
 * matches by label. `LinkedDevice` (device_link_token) and `DeviceKey` share no
 * id on the wire, so an ambiguous match signs nothing (the key list is the
 * primary surface for revocation).
 */
export function phoneKeyForLinkedDevice(
  keys: readonly DeviceKey[],
  device: { label: string; platform: string }
): DeviceKey | undefined {
  const platform = device.platform.trim().toLowerCase();
  if (platform !== "ios" && platform !== "iphone") return undefined;
  const matches = phoneKeys(keys).filter((key) => key.label === device.label);
  return matches.length === 1 ? matches[0] : undefined;
}

// ---- the desktop shell's refusals, in sentences --------------------------------

/**
 * `device_key_*` command rejections (clients/desktop `device_key`) and workd's
 * socket refusals, as one sentence each. Unknown codes get the generic line; the
 * code itself is never shown (it is not the person's vocabulary).
 */
export function deviceKeyErrorMessage(code: unknown): string {
  const raw = typeof code === "string" ? code : "";
  const key = raw.split(":")[0]!.trim();
  switch (key) {
    case "device_key_declined":
      return "서명을 취소했습니다.";
    case "device_key_cancelled":
      return "Touch ID나 암호 확인을 취소했습니다.";
    case "device_key_auth_failed":
      return "본인 확인에 실패했습니다. 다시 시도하세요.";
    case "device_key_unsigned_build":
      return "이 빌드는 서명되지 않아 Secure Enclave 키를 쓸 수 없습니다. 팀 배포 앱에서 하세요.";
    case "device_key_entitlement_missing":
      return "이 빌드에는 서명 키를 보관할 권한이 없습니다. 팀 배포 앱에서 하세요.";
    case "device_key_unsupported":
    case "unsupported_platform":
      return "이 기기에서는 지시 서명 키를 만들 수 없습니다.";
    case "device_key_absent":
    case "device_key_changed":
      return "이 맥의 서명 키가 바뀌었습니다. 이 맥을 다시 뿌리로 등록하세요.";
    case "device_key_not_root_here":
      return "이 맥이 이 워크스페이스의 뿌리로 등록돼 있지 않습니다.";
    case "device_key_payload_rejected":
      return "서명할 내용이 올바르지 않아 서명하지 않았습니다.";
    default:
      return "서명하지 못했습니다. 다시 시도하세요.";
  }
}

/** A server refusal on the device key routes, in a sentence. */
export function deviceKeyServerMessage(code: string | undefined, fallback: string): string {
  switch (code) {
    case DEVICE_KEY_REFUSAL.rootPasswordRequired:
      return "비밀번호가 맞지 않습니다. 이 계정의 현재 비밀번호를 적어 주세요.";
    case DEVICE_KEY_REFUSAL.rootLinkedSession:
      return "QR로 연결한 기기는 뿌리가 될 수 없습니다. 이 맥에서 비밀번호로 로그인한 뒤 등록하세요.";
    case DEVICE_KEY_REFUSAL.alreadyRegistered:
      return "이 키는 이미 등록돼 있습니다. 목록을 다시 불러오세요.";
    case DEVICE_KEY_REFUSAL.lineageEnded:
      return "이 로그인은 더 이상 키를 등록할 수 없습니다. 다시 로그인하세요.";
    default:
      return fallback;
  }
}

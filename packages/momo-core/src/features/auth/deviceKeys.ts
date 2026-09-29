// =============================================================================
// Human device keys (ADR-0146 개정 2026-09-28 R2: D-1 · D-6 · D-7; #3025 E5).
//
// Server half is E2 (#3022, `bins/momo-server/src/routes/device_keys.rs`):
//
//   POST /v1/workspaces/{ws}/device-keys                    register (macos: password)
//   GET  /v1/workspaces/{ws}/device-keys                    the caller's own keys
//   POST /v1/workspaces/{ws}/device-keys/{key}/endorsement  device_endorse.v1
//   POST /v1/workspaces/{ws}/device-keys/{key}/revocation   device_revoke.v1
//   POST /v1/workspaces/{ws}/device-keys  + `rebind`        device_rebind.v1 (#3097)
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
  /**
   * The key's sign-in can still rotate (#3097, ADR-0146 D-7 증보). A live key
   * with `false` signs nothing — the server refuses it as revoked — until the
   * device moves it onto its new sign-in with a `device_rebind.v1` letter
   * (`rebindDeviceKey`). Absent on a server from before #3097, which revoked
   * the key together with its sign-in, so a live row there is a live lineage.
   */
  lineageLive: boolean;
  /**
   * #3119 (ADR-0146 D-6 증보 「QR 연결로만」): the key's sign-in came from a
   * QR device link. A phone key with `false` is never approved; one approved
   * before the rule keeps working and reads 「QR 아님」. Absent on an older
   * server.
   */
  linkedSession?: boolean;
  /** #3119: that QR was issued from a Mac sign-in — the only phones a root approves. */
  linkedFromMac?: boolean;
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
  const lineageLive = bool(source, "lineageLive");
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
    ("lineageLive" in source && lineageLive === undefined) ||
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
    lineageLive: lineageLive ?? true,
    createdAtMs,
    ...optional("linkedSession", bool(source, "linkedSession")),
    ...optional("linkedFromMac", bool(source, "linkedFromMac")),
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

/**
 * Register the phone's enclave key (#3026 E6, ADR-0146 개정 D-6 ②). It starts
 * `unendorsed` — 「지시 불가」 — until the root Mac signs `device_endorse.v1`.
 * No password: an `ios` key cannot sign host registrations or endorse anyone.
 * `label` must be the name the QR redeem sent (`DeviceLinkDevice.name`): the
 * Mac pairs its linked-device row with this key by label
 * (`phoneKeyForLinkedDevice`).
 */
export async function registerPhoneDeviceKey(
  workspaceId: string,
  input: { publicKey: string; label: string }
): Promise<DeviceKey> {
  return one(
    await settingsRequest<unknown>(base(workspaceId), {
      method: "POST",
      body: JSON.stringify({
        alg: "p256",
        publicKey: input.publicKey,
        platform: "ios",
        label: input.label,
      }),
    })
  );
}

/**
 * The server answered a rebind, but the key is not on this sign-in (`current`
 * is not true, or its lineage still cannot rotate). ADR-0146 D-7 증보 클라이언트
 * 계약: that is a failure, said as one — never read as 「다시 연결했습니다」.
 */
export class DeviceKeyRebindError extends Error {
  constructor() {
    super("device_key_rebind_not_current");
    this.name = "DeviceKeyRebindError";
  }
}

/**
 * Move this device's live key onto the caller's sign-in (#3097, ADR-0146 D-7
 * 증보): the register body again, with `rebind` — a `momo.human.device_rebind.v1`
 * letter the key itself signed. The letter is built and signed natively (the
 * desktop shell's `device_key_sign_rebind`, the phone's `signDeviceRebind`);
 * this only posts it. `platform` and `label` are validated by the server and
 * the stored row's are kept. 200 → the moved row, which must be `current`.
 */
export async function rebindDeviceKey(
  workspaceId: string,
  input: {
    publicKey: string;
    platform: "macos" | "ios";
    label: string;
    rebind: { signedAtMs: number; signature: string };
  }
): Promise<DeviceKey> {
  const key = one(
    await settingsRequest<unknown>(base(workspaceId), {
      method: "POST",
      body: JSON.stringify({
        alg: "p256",
        publicKey: input.publicKey,
        platform: input.platform,
        label: input.label,
        rebind: { signedAtMs: input.rebind.signedAtMs, signature: input.rebind.signature },
      }),
    })
  );
  if (key.current !== true || key.lineageLive !== true) throw new DeviceKeyRebindError();
  return key;
}

/**
 * `GET …/device-keys/signing-context` (#3023): the `instance_id` line every
 * `momo.human.control.v1` statement carries, verbatim (a client never builds it
 * from a URL — D-5), and the server clock a signer corrects its own by (D-9).
 */
export interface SigningContext {
  instanceId: string;
  serverTimeMs: number;
  maxLifetimeMs: number;
  maxClockSkewMs: number;
  humanControlSignatureRequired: boolean;
  hostRegisterSignatureRequired: boolean;
  /**
   * The caller's sign-in lineage — the `session_id` line of a
   * `device_rebind.v1` letter (#3097). `null` from a server before #3097 or
   * for a sign-in from before lineages (088): such a sign-in cannot rebind.
   * The parser always sets it; optional only so callers that build a context
   * by hand (tests, the control signers) need not.
   */
  sessionId?: string | null;
}

export function parseSigningContext(value: unknown): SigningContext {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const instanceId = str(source, "instanceId");
  const serverTimeMs = num(source, "serverTimeMs");
  const maxLifetimeMs = num(source, "maxLifetimeMs");
  const maxClockSkewMs = num(source, "maxClockSkewMs");
  const humanControlSignatureRequired = bool(source, "humanControlSignatureRequired");
  const hostRegisterSignatureRequired = bool(source, "hostRegisterSignatureRequired");
  const rawSession = source["sessionId"];
  if (rawSession !== undefined && rawSession !== null && typeof rawSession !== "string") {
    throw new WireShapeError();
  }
  if (
    !instanceId ||
    serverTimeMs === undefined ||
    maxLifetimeMs === undefined ||
    maxLifetimeMs <= 0 ||
    maxClockSkewMs === undefined ||
    humanControlSignatureRequired === undefined ||
    hostRegisterSignatureRequired === undefined
  ) {
    throw new WireShapeError();
  }
  return {
    instanceId,
    serverTimeMs,
    maxLifetimeMs,
    maxClockSkewMs,
    humanControlSignatureRequired,
    hostRegisterSignatureRequired,
    sessionId: typeof rawSession === "string" && rawSession !== "" ? rawSession : null,
  };
}

export async function fetchSigningContext(workspaceId: string): Promise<SigningContext> {
  return parseSigningContext(
    await settingsRequest<unknown>(`${base(workspaceId)}/signing-context`, { cache: "no-store" })
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
  /** #3097: the same key is live under this member on an ended sign-in. */
  rebindRequired: "device_key_rebind_required",
  /** #3097: a rebind of a key with no live row (it was revoked). */
  notFound: "device_key_not_found",
  signatureInvalid: "device_signature_invalid",
  /** #3119: a phone key is registered (or moved) only on a QR-linked sign-in. */
  requiresLinkedSession: "device_key_requires_linked_session",
  /** #3119: the phone's QR was not issued from a Mac sign-in. */
  linkNotFromMac: "device_key_link_not_from_mac",
  /** #3127: this sign-in already holds a live phone key; the Mac revokes it or the phone links again. */
  lineageHasPhoneKey: "device_key_lineage_has_phone_key",
} as const;

// ---- views ------------------------------------------------------------------

/**
 * A phone key the root can act on: live phone keys, newest first. An
 * unapproved key the server will not let a root approve (#3119 — not from a
 * QR link, or from a QR no Mac issued) is not a candidate. An approved one
 * stays: it keeps working, and `linkedSession === false` marks it 「QR 아님」.
 */
export function phoneKeys(keys: readonly DeviceKey[]): DeviceKey[] {
  return keys
    .filter((key) => key.platform === "ios" && key.state !== "revoked")
    .filter(
      (key) =>
        key.state !== "unendorsed" ||
        (key.linkedSession !== false && key.linkedFromMac !== false)
    )
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/**
 * Waiting phone keys no root may approve (#3129; the server's #3119 rule):
 * registered on a sign-in that was not a QR link, or from a QR no Mac issued.
 * `phoneKeys` leaves them out; the Mac says how many there are and why, so a
 * phone that shows 「QR 연결 필요」 is not simply missing here.
 */
export function unapprovablePhoneKeys(keys: readonly DeviceKey[]): DeviceKey[] {
  return keys.filter(
    (key) =>
      key.platform === "ios" &&
      key.state === "unendorsed" &&
      (key.linkedSession === false || key.linkedFromMac === false)
  );
}

/**
 * This Mac's live row for `publicKey`, if the server has one — with whether it
 * can sign (#3097). A row whose sign-in ended without revoking it (a refresh
 * reuse, an expiry) is still this Mac's root, and still found here: the way
 * back is `rebind` with the key's own letter, not a new registration with the
 * password. Until then it signs nothing, so it is never `bound`.
 */
export function rootRowFor(
  keys: readonly DeviceKey[],
  publicKey: string
): { row: DeviceKey; lineageLive: boolean } | undefined {
  const row = keys.find(
    (key) => key.platform === "macos" && key.publicKey === publicKey && key.state === "root"
  );
  return row ? { row, lineageLive: row.lineageLive } : undefined;
}

/** A live key left on an ended sign-in: it must be moved before it signs. */
export function keyNeedsRebind(key: DeviceKey): boolean {
  return key.state !== "revoked" && !key.lineageLive;
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
  const raw =
    typeof code === "string" ? code : code instanceof DeviceKeyRebindError ? code.message : "";
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
      return "서명할 내용에 보이지 않는 문자나 올바르지 않은 값이 있어 서명하지 않았습니다.";
    case "device_key_host_pinned_other":
      return "이 맥의 작업 호스트가 이미 다른 키를 뿌리로 고정했습니다. 작업 호스트를 다시 등록해야 합니다.";
    case "device_key_pin_refused":
      return "이 맥의 작업 호스트가 이 키를 뿌리로 받지 않았습니다. 작업 호스트 상태를 확인하세요.";
    case "device_key_kind_not_enabled":
      return "이 종류의 서명은 아직 이 앱에서 할 수 없습니다.";
    case "device_key_no_letter":
      return "이 맥에서 서명한 해제 기록이 없어 다시 보낼 수 없습니다.";
    case "device_key_not_endorsed_here":
      return "이 맥에 이 키를 승인한 기록이 없어 해제에 서명할 수 없습니다. 그 기기의 연결을 끊으면 서버에서는 키가 해제되지만, 이 맥의 작업 호스트에는 알려지지 않습니다.";
    case "device_key_rebind_not_current":
      return "서버가 이 키를 이 로그인으로 옮기지 않았습니다. 목록을 다시 불러와 다시 시도하세요.";
    case "device_key_no_session":
      return "이 로그인은 키를 옮길 수 없습니다. 로그아웃한 뒤 다시 로그인하세요.";
    case "work_host_not_running":
      return "이 맥의 작업 호스트가 켜져 있지 않습니다. 작업 호스트를 켠 뒤 다시 시도하세요.";
    case "work_host_other_workspace":
      return "이 맥의 작업 호스트는 다른 워크스페이스 것이라 여기서 바꿀 수 없습니다.";
    case "workd_refused":
      return "이 맥의 작업 호스트가 요청을 받지 않았습니다. 다시 시도하세요.";
    case "device_key_endorse_conflict":
      return "이 맥이 이미 다른 키를 이 이름으로 승인했거나 같은 키를 다른 이름으로 승인했습니다. 목록을 다시 불러와 확인하세요.";
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
    case DEVICE_KEY_REFUSAL.rebindRequired:
      return "이 키는 끝난 로그인에 묶여 있습니다. 다시 연결하세요.";
    case DEVICE_KEY_REFUSAL.notFound:
      return "서버에 이 키가 더 이상 없습니다. 목록을 다시 불러와 새로 등록하세요.";
    case DEVICE_KEY_REFUSAL.signatureInvalid:
      return "서버가 이 기기의 서명을 받지 않았습니다. 기기 시계가 맞는지 확인하고 다시 시도하세요.";
    case DEVICE_KEY_REFUSAL.requiresLinkedSession:
      return "이 폰은 QR로 연결되지 않아 지시 기기가 될 수 없습니다. 맥에서 QR로 한 번 연결하세요.";
    case DEVICE_KEY_REFUSAL.linkNotFromMac:
      return "이 폰은 맥이 아닌 곳에서 띄운 QR로 연결됐습니다. 맥에서 QR로 다시 연결하세요.";
    default:
      return fallback;
  }
}

// ---- signing context and who may instruct from where (#3029 E9) --------------

// `SigningContext` / `parseSigningContext` live above, next to `fetchSigningContext`
// (#3026 E6: the phone signs with the full context; this flag reader shares it).

/**
 * Whether this server requires a device signature on an allow or an
 * instruction. `null` = unknown: a server from before E3 (404), no
 * `MOMO_INSTANCE_ID` (503 `instance_id_unconfigured`), a network error or an
 * odd body. Unknown is never read as "on" (ADR-0146 개정 D-11: the flag stays
 * closed until R1·R2 PASS, so nothing changes without the server saying so).
 */
export async function fetchHumanControlSignatureRequired(
  workspaceId: string
): Promise<boolean | null> {
  try {
    const res = await settingsRequest<unknown>(`${base(workspaceId)}/signing-context`, {
      cache: "no-store",
    });
    return parseSigningContext(res).humanControlSignatureRequired;
  } catch {
    return null;
  }
}

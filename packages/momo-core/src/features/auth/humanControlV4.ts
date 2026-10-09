// =============================================================================
// `momo.human.control.v4` — the owner's signed NEW-work spawn (#3570 T5,
// #3592 P1; ADR-0198 증보 1 D7 · 「T5 확정」 1).
//
// One recipe, written once for the clients that sign it. The phone
// (`clients/mobile/src/deviceKey/humanControl.ts`) builds these bytes here; the
// desktop shell rebuilds the same bytes in Rust (`device_key/payload.rs`). Both
// are pinned to `docs/api/human-control-signing-v4.vectors.json`, which
// `momo-wire` (`tests/human_control_v4_vectors.rs`) rebuilds from the same
// inputs — so a client that matches the file matches the server's verifier.
//
// The 13-line frame is the v1–v3 one with only the first line changed:
//
//   momo.human.control.v4 · instance · workspace · member · device key · host ·
//   session (`-`) · `spawn` · mode (`-`) · nonce · issuedAtMs · expiresAtMs ·
//   content_sha256
//
// and `content_sha256` is the SHA-256 of the eight-line body
//
//   {agent member id | -}  {folder id}  {tool}  {channel id}
//   {thread root id | -}   {origin message id | -}
//   {NFC(label)}           {NFC(prompt)}
//
// Pure and platform-free (ADR-0137 D3): SHA-256 is the core's own
// (`lib/sha256.ts`, the one the v3 preview hash uses — `crypto.subtle` does not
// exist under Hermes). The statement is returned as text for the caller to
// UTF-8 encode and sign.
// =============================================================================

import { sha256Utf8 } from "../../lib/sha256";

export const HUMAN_CONTROL_V4_SCHEMA = "momo.human.control.v4";

/** The longest title the server keeps (`validated_label`). */
export const SPAWN_LABEL_MAX_CHARS = 120;
/** The whole first prompt's bound (the `input` limit). */
export const SPAWN_PROMPT_MAX_CHARS = 32_768;

const ABSENT = "-";

/** What the owner asks for: the eight body lines, typed. */
export interface SpawnTaskContent {
  /** The personal agent's member id; `null` for a harness spawn (「내 도구」). */
  agentMemberId: string | null;
  /** An allowed folder id the host issued. */
  folderId: string;
  /** The harness key the host launches. */
  tool: string;
  channelId: string;
  /** The thread the call was made in; `null` on the room's main line. */
  threadRootId: string | null;
  /** The owner's own message the call came from; `null` for none. */
  originMessageId: string | null;
  label: string;
  prompt: string;
}

/** The frame fields around the body; the same ones every control carries. */
export interface SpawnTaskFields {
  /** `signing-context` `instanceId`, verbatim. */
  instanceId: string;
  workspaceId: string;
  memberId: string;
  deviceKeyId: string;
  hostId: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

/** A statement this file refuses to build (before anything is hashed or signed). */
export class SpawnTaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnTaskInputError";
  }
}

// eslint-disable-next-line no-control-regex -- the point is to find them.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** One id-like line: non-empty and free of line breaks and control characters
 * (one extra `\n` would move every later field up a line). */
function token(name: string, value: string): string {
  if (value === "" || CONTROL.test(value)) {
    throw new SpawnTaskInputError(`${name} is empty or has a control character`);
  }
  return value;
}

function optionalToken(name: string, value: string | null): string {
  return value === null ? ABSENT : token(name, value);
}

function ms(name: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SpawnTaskInputError(`${name} is not a whole number of milliseconds`);
  }
  return String(value);
}

/**
 * The title the server stores and the statement signs: one trimmed NFC line of
 * 1…120 characters with no control character. Throws rather than repair, so
 * what is shown is what is signed.
 */
export function spawnLabelText(label: string): string {
  const nfc = label.normalize("NFC");
  if (nfc !== nfc.trim() || CONTROL.test(nfc)) {
    throw new SpawnTaskInputError("label must be one trimmed line with no control character");
  }
  const length = Array.from(nfc).length;
  if (length < 1 || length > SPAWN_LABEL_MAX_CHARS) {
    throw new SpawnTaskInputError(`label must contain 1...${SPAWN_LABEL_MAX_CHARS} characters`);
  }
  return nfc;
}

/**
 * The prompt the server stores and the statement signs: NFC text of
 * 1…32768 characters, line breaks and tabs allowed, no other control
 * character, and not an adapter command (`/…`, which the host refuses).
 */
export function spawnPromptText(prompt: string): string {
  const nfc = prompt.normalize("NFC");
  const length = Array.from(nfc).length;
  if (length < 1 || length > SPAWN_PROMPT_MAX_CHARS || nfc.trim() === "") {
    throw new SpawnTaskInputError(`prompt must contain 1...${SPAWN_PROMPT_MAX_CHARS} characters`);
  }
  // eslint-disable-next-line no-control-regex -- line breaks and tabs are text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(nfc)) {
    throw new SpawnTaskInputError("prompt has a control character other than a line break or tab");
  }
  if (nfc.trimStart().startsWith("/")) {
    throw new SpawnTaskInputError("a prompt cannot start with /");
  }
  return nfc;
}

/** The eight body lines `content_sha256` is taken over. */
export function spawnTaskContentText(content: SpawnTaskContent): string {
  return [
    optionalToken("agentMemberId", content.agentMemberId),
    token("folderId", content.folderId),
    token("tool", content.tool),
    token("channelId", content.channelId),
    optionalToken("threadRootId", content.threadRootId),
    optionalToken("originMessageId", content.originMessageId),
    spawnLabelText(content.label),
    spawnPromptText(content.prompt),
  ].join("\n");
}

/** Lower-case hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256HexOfUtf8(text: string): string {
  return Array.from(sha256Utf8(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The signed statement: the schema line and twelve fields joined by `\n`. */
export function spawnTaskPayloadText(fields: SpawnTaskFields, content: SpawnTaskContent): string {
  if (fields.expiresAtMs <= fields.issuedAtMs) {
    throw new SpawnTaskInputError("expiresAtMs must be after issuedAtMs");
  }
  return [
    HUMAN_CONTROL_V4_SCHEMA,
    token("instanceId", fields.instanceId),
    token("workspaceId", fields.workspaceId),
    token("memberId", fields.memberId),
    token("deviceKeyId", fields.deviceKeyId),
    token("hostId", fields.hostId),
    ABSENT,
    "spawn",
    ABSENT,
    token("nonce", fields.nonce),
    ms("issuedAtMs", fields.issuedAtMs),
    ms("expiresAtMs", fields.expiresAtMs),
    sha256HexOfUtf8(spawnTaskContentText(content)),
  ].join("\n");
}

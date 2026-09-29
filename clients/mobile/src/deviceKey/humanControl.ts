import type {SigningContext} from '@momo/core/features/auth/deviceKeys';

import {bytesToBase64} from './base64';
import {signWithDeviceKey} from './native';
import {hex, sha256, utf8} from './sha256';

// =============================================================================
// The phone's signing call path (#3026 stage 2; ADR-0146 개정 2026-09-28 D-5·D-9).
//
// Builds the exact bytes of a human control statement, then asks the enclave
// (Face ID) to sign them. The byte recipe is the one the shared vectors fix
// (`__tests__/fixtures/human-control-signing.vectors.json`, #3021; Rust
// `momo_wire::human_control`, the generator `generate.mjs`), and
// `__tests__/humanControl.test.ts` rebuilds every v2 and v3 case from its inputs.
//
// The schema is an ARGUMENT, not a constant. A schema this file has no recipe
// for is refused before anything is hashed. #3028 (E8) added `v2` here and to
// the native allow-list together (ADR-0146 증보 R2-E7): the same 13-line frame;
// a v2 spawn binds the tool and the channel and may name a resume's successor
// session. The phone SIGNS v2 (`PHONE_SIGNING_SCHEMA`). #3096 dropped the v1
// recipe here and v1 from the native allow-list: nothing the phone signs is v1
// any more, and a v1 spawn could only fail after Face ID.
//
// #3128 (ADR-0146 증보 2026-09-29, R2 H1 · #3118) added `v3`: the same frame,
// and a `permission` body gains a fifth line — the SHA-256 of the host's
// preview the card checked (`checkPermissionPreview`) and showed. An allow is
// signed as v3 (`phoneSigningSchema`); input and spawn stay v2, which the
// server and workd still accept for them, so a phone update does not break
// instructions on a host that has not updated yet. `docs/api/
// human-control-signing-v3.vectors.json` pins the bytes.
//
// Only what a phone signs is here: `input`, `spawn`, `permission`.
// `host_register` and `bundle_manifest` are the root Mac's (D-6 ①, ADR-0192 D3).
// Nothing on this path sends anything; E8 carries the result to the route.
// =============================================================================

export const HUMAN_CONTROL_SCHEMAS = [
  'momo.human.control.v2',
  'momo.human.control.v3',
] as const;
export type HumanControlSchema = (typeof HUMAN_CONTROL_SCHEMAS)[number];

/** What the phone signs input and spawn as (#3028). */
export const PHONE_SIGNING_SCHEMA: HumanControlSchema = 'momo.human.control.v2';

/** What the phone signs each kind as: an allow binds its preview (v3, #3128). */
export function phoneSigningSchema(
  kind: HumanControlContent['kind'],
): HumanControlSchema {
  return kind === 'permission' ? 'momo.human.control.v3' : PHONE_SIGNING_SCHEMA;
}

const ABSENT = '-';

export type HumanControlContent =
  | {kind: 'input'; mode: 'queue' | 'interrupt'; text: string}
  | {
      kind: 'spawn';
      agentMemberId: string;
      folderId: string;
      /** v2: the harness (`claude`, `codex`, …). */
      tool?: string;
      /** v2: the session thread's channel. */
      channelId?: string;
      firstPrompt: string;
    }
  | {
      kind: 'permission';
      requestEventId: string;
      optionId: string;
      optionKind: string;
      /** 「이번 한 번」 `once` · 「이 세션 동안」 `session` (D-8). */
      scope: 'once' | 'session';
      /** v3 only (#3128): the hash of the preview the card checked and showed. */
      previewSha256?: string;
    };

export interface HumanControlFields {
  /** `signing-context` `instanceId`, verbatim — never built from a URL (D-5). */
  instanceId: string;
  workspaceId: string;
  memberId: string;
  deviceKeyId: string;
  hostId: string;
  /** null for `spawn` → `-`. */
  sessionId: string | null;
  /** 128-bit random; for `input` the message's `client_msg_id`. */
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export class HumanControlInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HumanControlInputError';
  }
}

function isSchema(value: string): value is HumanControlSchema {
  return (HUMAN_CONTROL_SCHEMAS as readonly string[]).includes(value);
}

/** A line of the statement: non-empty, no line break or other control
 *  character — one extra `\n` would move every later field up a line. */
function line(name: string, value: string): string {
  // eslint-disable-next-line no-control-regex -- the point is to find them.
  if (value === '' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new HumanControlInputError(`${name} is empty or has a control character`);
  }
  return value;
}

function ms(name: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HumanControlInputError(`${name} is not a whole number of milliseconds`);
  }
  return String(value);
}

/** The canonical content bytes `content_sha256` is taken over. Free text is
 *  NFC-normalised; ids are passed through as they are. */
export function humanControlContentBytes(
  schema: string,
  content: HumanControlContent,
): Uint8Array {
  if (!isSchema(schema)) {
    throw new HumanControlInputError(`no recipe for schema ${schema}`);
  }
  switch (content.kind) {
    case 'input':
      return utf8(content.text.normalize('NFC'));
    case 'spawn':
      return utf8(
        [
          line('agentMemberId', content.agentMemberId),
          line('folderId', content.folderId),
          line('tool', content.tool ?? ''),
          line('channelId', content.channelId ?? ''),
          content.firstPrompt.normalize('NFC'),
        ].join('\n'),
      );
    case 'permission': {
      const head = [
        line('requestEventId', content.requestEventId),
        line('optionId', content.optionId),
        line('optionKind', content.optionKind),
        line('scope', content.scope),
      ];
      // v3 has the preview line and only v3 has it (#3118): a v1/v2 allow
      // cannot say which preview the person saw, and the host refuses it.
      if (schema === 'momo.human.control.v3') {
        const hash = content.previewSha256 ?? '';
        if (!/^[0-9a-f]{64}$/.test(hash)) {
          throw new HumanControlInputError(
            'a v3 allow needs the checked preview hash',
          );
        }
        return utf8([...head, hash].join('\n'));
      }
      if (content.previewSha256 !== undefined) {
        throw new HumanControlInputError('a preview hash is signed only as v3');
      }
      return utf8(head.join('\n'));
    }
  }
}

/** The signed bytes: the schema line and twelve fields, joined by `\n`. */
export function humanControlPayload(
  schema: string,
  fields: HumanControlFields,
  content: HumanControlContent,
): Uint8Array {
  const contentSha256 = hex(sha256(humanControlContentBytes(schema, content)));
  if (fields.expiresAtMs <= fields.issuedAtMs) {
    throw new HumanControlInputError('expiresAtMs must be after issuedAtMs');
  }
  return utf8(
    [
      schema,
      line('instanceId', fields.instanceId),
      line('workspaceId', fields.workspaceId),
      line('memberId', fields.memberId),
      line('deviceKeyId', fields.deviceKeyId),
      line('hostId', fields.hostId),
      fields.sessionId === null ? ABSENT : line('sessionId', fields.sessionId),
      content.kind,
      content.kind === 'input' ? line('mode', content.mode) : ABSENT,
      line('nonce', fields.nonce),
      ms('issuedAtMs', fields.issuedAtMs),
      ms('expiresAtMs', fields.expiresAtMs),
      contentSha256,
    ].join('\n'),
  );
}

/** Face ID's reason line, per kind. 해요체 (the system sheet speaks to the
 *  person; ADR-0193 D11). */
export const SIGN_REASONS: Readonly<Record<HumanControlContent['kind'], string>> = {
  input: '에이전트에게 보낼 지시를 확인해요',
  spawn: '에이전트에게 새 작업을 맡기는 것을 확인해요',
  permission: '에이전트의 권한 요청을 허용하는 것을 확인해요',
};

/** How long a signed statement lives by default. The server caps it at
 *  `maxLifetimeMs` (10 min); a Face ID prompt and one request need far less. */
export const DEFAULT_STATEMENT_LIFETIME_MS = 2 * 60_000;

/**
 * The server's clock as this device should use it: the signing context was
 * read at local time `readAtMs`, so every later local reading is shifted by the
 * same offset (D-9 시계 보정 — a phone whose clock is off by more than ±5 min
 * would otherwise sign statements the server refuses as stale).
 */
export function serverNow(
  context: Pick<SigningContext, 'serverTimeMs'>,
  readAtMs: number,
  localNowMs: number,
): number {
  return localNowMs + (context.serverTimeMs - readAtMs);
}

/** What travels beside the instruction — the server's `HumanSignatureRequest`. */
export interface HumanSignature {
  schema: HumanControlSchema;
  deviceKeyId: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  /** base64 raw r‖s. */
  signature: string;
  mode?: 'queue' | 'interrupt';
  scope?: 'once' | 'session';
  agentMemberId?: string;
  folderId?: string;
}

export interface SignHumanControlInput {
  schema: string;
  context: SigningContext;
  /** Local `Date.now()` when `context` was read. */
  contextReadAtMs: number;
  workspaceId: string;
  memberId: string;
  deviceKeyId: string;
  hostId: string;
  sessionId: string | null;
  nonce: string;
  content: HumanControlContent;
  lifetimeMs?: number;
  /** Test seam; `Date.now` otherwise. */
  now?: () => number;
}

/**
 * Build, then sign with Face ID. Rejects a schema with no recipe
 * (HumanControlInputError) before Face ID is raised; enclave failures arrive
 * as the bridge's typed `DeviceKeyError` (DEVICE_KEY_CANCELLED, …_INVALIDATED).
 */
export async function signHumanControl(
  input: SignHumanControlInput,
): Promise<HumanSignature> {
  if (!isSchema(input.schema)) {
    throw new HumanControlInputError(`no recipe for schema ${input.schema}`);
  }
  const lifetime = Math.min(
    input.lifetimeMs ?? DEFAULT_STATEMENT_LIFETIME_MS,
    input.context.maxLifetimeMs,
  );
  if (!(lifetime > 0)) {
    throw new HumanControlInputError('statement lifetime must be positive');
  }
  const issuedAtMs = Math.round(
    serverNow(input.context, input.contextReadAtMs, (input.now ?? Date.now)()),
  );
  const fields: HumanControlFields = {
    instanceId: input.context.instanceId,
    workspaceId: input.workspaceId,
    memberId: input.memberId,
    deviceKeyId: input.deviceKeyId,
    hostId: input.hostId,
    sessionId: input.sessionId,
    nonce: input.nonce,
    issuedAtMs,
    expiresAtMs: issuedAtMs + lifetime,
  };
  const payload = humanControlPayload(input.schema, fields, input.content);
  const signature = await signWithDeviceKey(
    payload,
    SIGN_REASONS[input.content.kind],
  );
  const content = input.content;
  return {
    schema: input.schema,
    deviceKeyId: input.deviceKeyId,
    nonce: input.nonce,
    issuedAtMs: fields.issuedAtMs,
    expiresAtMs: fields.expiresAtMs,
    signature: bytesToBase64(signature),
    ...(content.kind === 'input' ? {mode: content.mode} : {}),
    ...(content.kind === 'permission' ? {scope: content.scope} : {}),
    ...(content.kind === 'spawn'
      ? {agentMemberId: content.agentMemberId, folderId: content.folderId}
      : {}),
  };
}

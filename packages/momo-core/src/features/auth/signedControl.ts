// =============================================================================
// Signed allow · instruction · 「거부 + 지시」 · resume — one flow for the phone
// and the desktop app (ADR-0146 개정 2026-09-28 D-5b · D-8 · D-11, #3028 R2-E8).
//
// The surfaces differ only in WHO signs: the phone's Face ID enclave key
// (`clients/mobile/src/deviceKey/humanControl.ts`) or the desktop shell's
// Touch ID key (`device_key_sign_control`). Each hands this file a
// `HumanControlSigner`; everything else — the nonce, what is signed, which
// route carries it, and what the person is told when it does not arrive — is
// here, once.
//
// The rule this file keeps (D-5b, E8): a signed action that fails is shown as
// 「전달 안 됨」 with the reason. It is never quietly left as a chat message and
// never retried unsigned.
//
// When the server does not require signatures (the flag is closed, D-11) the
// surfaces keep today's behaviour and do not call these flows at all.
// =============================================================================

import {
  decideWorkPermission,
  resumeWorkSession,
  sendWorkInstruction,
  type HumanSignatureRequest,
  type WorkInstructionMode,
  type WorkSession,
} from "../../lib/api";
import { humanSignatureRefusal } from "./humanSignature";

export type PermissionScope = "once" | "session";

/** What a statement says, per kind. Byte recipes live with each signer. */
export type ControlContentToSign =
  | { kind: "input"; mode: WorkInstructionMode; text: string }
  | {
      kind: "permission";
      requestEventId: string;
      optionId: string;
      /** The stored option kind (`allow_once`). */
      optionKind: string;
      scope: PermissionScope;
    }
  | {
      kind: "spawn";
      agentMemberId: string;
      folderId: string;
      tool: string;
      channelId: string;
      firstPrompt: string;
    };

export interface ControlToSign {
  /** The session's host (the server rebuilds it from the session). */
  hostId: string;
  /** input · permission: the session. spawn: a resume's successor, else null. */
  sessionId: string | null;
  nonce: string;
  content: ControlContentToSign;
}

/**
 * Signs one statement (Face ID / Touch ID) and returns the wire envelope.
 * A failure that is the person's or the device's (cancelled, no key, not
 * approved) rejects with `SignerRefusal` carrying a 해요체 sentence.
 */
export interface HumanControlSigner {
  sign(control: ControlToSign): Promise<HumanSignatureRequest>;
}

export class SignerRefusal extends Error {
  /** The person said no (Face ID / Touch ID cancelled, dialog declined). */
  readonly cancelled: boolean;
  constructor(text: string, cancelled = false) {
    super(text);
    this.name = "SignerRefusal";
    this.cancelled = cancelled;
  }
}

/** The label a failed signed action carries (D-5b 「전달 안 됨」). */
export const NOT_DELIVERED = "전달 안 됨";

export type Delivery =
  | { state: "sent" }
  | {
      state: "not_delivered";
      /** Where it stopped: nothing was sent (`sign`) or the server refused (`server`). */
      stage: "sign" | "server";
      text: string;
      error: unknown;
    };

/** The folder a phone or desktop names today: a host runs one allowed folder
 * (ADR-0188 D6; the host does not read the id yet, ADR-0146 증보 E7). */
export const DEFAULT_FOLDER_ID = "default";

export function newNonce(): string {
  return crypto.randomUUID();
}

// ---- sentences ---------------------------------------------------------------

/** 400 `permission_scope_unsupported`: the server does not take 「이 세션 동안」 yet. */
export const SCOPE_UNSUPPORTED_LINE =
  "이 서버는 아직 「이 세션 동안」 허락을 받지 않아요. 「이번 한 번 허락」으로 보내 주세요.";

/**
 * Why a signed instruction did not arrive, as one sentence. Signature refusals
 * first (by code), then the instruction route's own codes (golden
 * `work-instruction`), then transport.
 */
export function instructionFailureLine(error: unknown): string {
  if (error instanceof SignerRefusal) return error.message;
  const signature = humanSignatureRefusal(error);
  if (signature) return signature.text;
  const code =
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  switch (code) {
    case "signed_instructions_disabled":
      return "이 서버는 아직 서명한 지시를 받지 않아요. 서버가 열리면 여기서 보낼 수 있어요.";
    case "work_host_offline":
      return "호스트가 90초 넘게 응답하지 않아 보내지 않았어요. 호스트가 켜져 있는지 확인한 뒤 다시 보내 주세요.";
    case "work_host_revoked":
      return "이 호스트는 해제되어 지시를 받을 수 없어요.";
    case "work_session_not_accepting":
      return "세션이 끝나 지시를 받지 않아요.";
    case "instruction_owner_only":
    case "instruction_member_host_only":
      return "이 세션의 소유자만 자기 호스트에 지시할 수 있어요.";
    case "instruction_channel_member_only":
      return "이 세션의 채널에서 나가 있어 지시할 수 없어요. 채널에 다시 들어간 뒤 보내 주세요.";
    case "instruction_slash_command":
      return "「/」로 시작하는 명령은 지시로 보낼 수 없어요.";
    case "instruction_text_invalid":
      return "지시가 비었거나 너무 길어요. 32,768자 안으로 적어 주세요.";
    case "instruction_nonce_reused":
    case "instruction_signature_mismatch":
      return "보낸 지시와 서명이 맞지 않아 서버가 받지 않았어요. 다시 보내면 새로 서명해요.";
    default:
      return "지시를 보내지 못했어요. 연결을 확인한 뒤 다시 보내 주세요.";
  }
}

function notDelivered(stage: "sign" | "server", error: unknown): Delivery {
  return { state: "not_delivered", stage, text: instructionFailureLine(error), error };
}

// ---- flows ---------------------------------------------------------------------

type SessionRef = Pick<WorkSession, "id" | "hostId">;

/**
 * A signed allow (「이번 한 번」 or 「이 세션 동안」). Throws what the decision
 * route or the signer threw; the card reads it with `permissionFailure`.
 */
export async function signedAllow(input: {
  workspaceId: string;
  session: SessionRef;
  requestEventId: string;
  optionId: string;
  scope: PermissionScope;
  signer: HumanControlSigner;
}): Promise<void> {
  const humanSignature = await input.signer.sign({
    hostId: input.session.hostId,
    sessionId: input.session.id,
    nonce: newNonce(),
    content: {
      kind: "permission",
      requestEventId: input.requestEventId,
      optionId: input.optionId,
      optionKind: "allow_once",
      scope: input.scope,
    },
  });
  await decideWorkPermission(input.workspaceId, input.session.id, {
    requestEventId: input.requestEventId,
    optionId: input.optionId,
    kind: "allow_once",
    humanSignature,
  });
}

/** A signed instruction on the instruction route. Never throws. */
export async function signedInstruction(input: {
  workspaceId: string;
  session: SessionRef;
  text: string;
  mode: WorkInstructionMode;
  signer: HumanControlSigner;
}): Promise<Delivery> {
  // The server signs over NFC and refuses anything else (golden text_not_nfc).
  const text = input.text.normalize("NFC");
  const nonce = newNonce();
  let humanSignature: HumanSignatureRequest;
  try {
    humanSignature = await input.signer.sign({
      hostId: input.session.hostId,
      sessionId: input.session.id,
      nonce,
      content: { kind: "input", mode: input.mode, text },
    });
  } catch (error) {
    return notDelivered("sign", error);
  }
  try {
    await sendWorkInstruction(input.workspaceId, input.session.id, {
      text,
      mode: input.mode,
      clientMsgId: nonce,
      humanSignature,
    });
    return { state: "sent" };
  } catch (error) {
    return notDelivered("server", error);
  }
}

export type RejectWithInstructionOutcome =
  /** Nothing was sent: the instruction could not be signed. */
  | { state: "not_sent"; text: string; error: unknown }
  /** The reject itself was refused (the card's `permissionFailure` reads it). */
  | { state: "reject_failed"; error: unknown }
  /** Rejected; the instruction arrived or is 「전달 안 됨」. */
  | { state: "rejected"; instruction: Delivery };

/**
 * 「거부 + 지시」 (ADR-0146 개정 D-8): the reject goes unsigned, the text as a
 * signed `input` (queue — it is the next turn). Signed FIRST, so a cancelled
 * Face ID / Touch ID sends nothing at all; then the reject; then the
 * instruction. If only the instruction fails, the reject stands and the
 * instruction is 「전달 안 됨」 — said, never swallowed.
 */
export async function rejectWithInstruction(input: {
  workspaceId: string;
  session: SessionRef;
  requestEventId: string;
  optionId: string;
  text: string;
  signer: HumanControlSigner;
}): Promise<RejectWithInstructionOutcome> {
  const text = input.text.normalize("NFC");
  const nonce = newNonce();
  let humanSignature: HumanSignatureRequest;
  try {
    humanSignature = await input.signer.sign({
      hostId: input.session.hostId,
      sessionId: input.session.id,
      nonce,
      content: { kind: "input", mode: "queue", text },
    });
  } catch (error) {
    return { state: "not_sent", text: instructionFailureLine(error), error };
  }
  try {
    await decideWorkPermission(input.workspaceId, input.session.id, {
      requestEventId: input.requestEventId,
      optionId: input.optionId,
      kind: "reject_once",
    });
  } catch (error) {
    return { state: "reject_failed", error };
  }
  try {
    await sendWorkInstruction(input.workspaceId, input.session.id, {
      text,
      mode: "queue",
      clientMsgId: nonce,
      humanSignature,
    });
    return { state: "rejected", instruction: { state: "sent" } };
  } catch (error) {
    return { state: "rejected", instruction: notDelivered("server", error) };
  }
}

/**
 * A signed resume (ADR-0146 증보 E7 「서명 재개」): the owner names the successor
 * session and signs a v2 spawn over it. The server rebuilds the statement from
 * the source session's label (as the first prompt), tool and channel.
 */
export async function signedResume(input: {
  workspaceId: string;
  session: Pick<WorkSession, "id" | "label" | "tool" | "channelId">;
  targetHostId: string;
  agentMemberId: string;
  signer: HumanControlSigner;
}): Promise<WorkSession> {
  const successor = newNonce();
  const humanSignature = await input.signer.sign({
    hostId: input.targetHostId,
    sessionId: successor,
    nonce: newNonce(),
    content: {
      kind: "spawn",
      agentMemberId: input.agentMemberId,
      folderId: DEFAULT_FOLDER_ID,
      tool: input.session.tool,
      channelId: input.session.channelId,
      firstPrompt: input.session.label.normalize("NFC"),
    },
  });
  return resumeWorkSession(input.workspaceId, input.session.id, input.targetHostId, {
    sessionId: successor,
    humanSignature,
  });
}

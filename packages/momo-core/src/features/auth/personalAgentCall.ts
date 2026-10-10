// =============================================================================
// Calling a personal agent (ADR-0198 증보 1 D7, #3592 P1): one client flow for
// an `@별칭` mention or a DM with the alias — the same on the phone and the
// desktop app.
//
// The server never turns a mention into work. The owner's client does two
// things, in this order:
//
//   1. sends the message through the ordinary send path (`channel_seq` +
//      message + outbox, untouched), and
//   2. signs a `momo.human.control.v4` new-work spawn that NAMES that message
//      (`originMessageId`) and posts it to `POST …/work-spawns`.
//
// The order is forced: the statement signs the message id, and the server
// accepts only "the owner's own plain message in this room" as an origin.
//
// What the person is told when it does not go through (never silently
// dropped, never retried unsigned, never queued for a Mac that is off):
//
//   - a browser with no signing key: the message stays and 「데스크탑·폰에서
//     불러 주세요」;
//   - the Mac is off: 「내 맥이 꺼져 있어요」 — there is no waiting request
//     (D4 결재 6), the person calls again;
//   - the signature or the server refused: the reason, as `signedControl.ts`
//     does for an instruction.
//
// A teammate's `@별칭` never reaches this file: the server answers it with the
// existing 「<소유자 이름>만 부를 수 있어요」 line and starts nothing.
// =============================================================================

import {
  ApiError,
  postWorkSpawn,
  sendMessage,
  sendThreadReply,
  type HumanSignatureRequest,
  type Message,
  type WorkSpawnBody,
  type WorkSpawnResult,
} from "../../lib/api";
import { humanSignatureRefusal } from "./humanSignature";
import {
  SpawnTaskInputError,
  SPAWN_LABEL_MAX_CHARS,
  spawnLabelText,
  spawnPromptText,
} from "./humanControlV4";
import { newNonce, SignerRefusal, type HumanControlSigner } from "./signedControl";

// ---- sentences ---------------------------------------------------------------

/** A browser without a signing key sends the message and says this (결재 1). */
export const CALL_NEEDS_APP_LINE = "데스크탑·폰에서 불러 주세요";

/** Mac off: nothing is queued (D4 결재 6). */
export const CALL_MAC_OFF_LINE = "내 맥이 꺼져 있어요. 맥을 켠 뒤 다시 불러 주세요.";

export const CALL_NOTHING_TO_ASK_LINE =
  "무엇을 시킬지 적어 주세요. 별칭만 보내면 에이전트가 할 일이 없어요.";

/** The label a failed call carries (same word as a failed instruction). */
export const CALL_NOT_DELIVERED = "전달 안 됨";

/** Why the call did not start, as one sentence. Signer, signature, then the
 * spawn route's own codes (`work_spawns.rs`), then transport. */
export function callFailureLine(error: unknown): string {
  if (error instanceof SignerRefusal) return error.message;
  if (error instanceof SpawnTaskInputError) {
    return "보낼 내용이 올바르지 않아 서명하지 않았어요. 내용을 고친 뒤 다시 보내 주세요.";
  }
  const signature = humanSignatureRefusal(error);
  if (signature) return signature.text;
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case "work_host_offline":
      return CALL_MAC_OFF_LINE;
    case "signed_spawn_disabled":
      return "이 서버는 아직 내 맥으로 보내는 호출을 받지 않아요.";
    case "spawn_host_not_found":
      return "연결된 내 맥을 찾지 못했어요. 데스크탑 앱에서 내 맥을 연결해 주세요.";
    case "spawn_folder_not_found":
      return "내 맥이 이 작업 폴더를 허용하고 있지 않아요. 맥 앱에서 폴더를 확인해 주세요.";
    case "spawn_host_ambiguous":
      return "연결된 맥이 여러 대라 어느 맥인지 정하지 못했어요. 맥을 골라 다시 불러 주세요.";
    case "spawn_agent_not_allowed":
      return "이 개인 에이전트는 지금 부를 수 없어요. 켜져 있는지 확인해 주세요.";
    case "spawn_channel_member_only":
      return "이 채널의 멤버만 부를 수 있어요.";
    case "spawn_origin_invalid":
      return "부른 메시지를 찾지 못했어요. 메시지를 다시 보낸 뒤 불러 주세요.";
    case "spawn_prompt_invalid":
    case "spawn_slash_command":
    case "spawn_label_invalid":
    case "spawn_tool_invalid":
    case "spawn_folder_required":
      return "보낼 내용이 올바르지 않아 보내지 않았어요. 내용을 고친 뒤 다시 보내 주세요.";
    case "spawn_nonce_reused":
      return "보낸 호출과 서명이 맞지 않아 서버가 받지 않았어요. 다시 부르면 새로 서명해요.";
    case "pool_exhausted":
    case "member_limit":
      return "지금 돌릴 수 있는 작업이 가득 찼어요. 끝난 작업이 있으면 다시 불러 주세요.";
    default:
      return "내 맥을 부르지 못했어요. 연결을 확인한 뒤 다시 불러 주세요.";
  }
}

// ---- what is sent ----------------------------------------------------------------

/** The alias, as the person types it after `@`. Handles are lower-case. */
export interface PersonalAgentTarget {
  memberId: string;
  handle: string;
}

/** Where the task runs: the owner's own Mac and a folder id it issued
 * (`GET …/work-hosts` for the owner; N5). The server derives the host from the
 * signed folder id — `hostId` is the statement's host line and a narrowing hint. */
export interface CallDestination {
  hostId: string;
  folderId: string;
  /** The harness key the host launches (`claude`, `codex`). */
  tool: string;
}

/**
 * The prompt the harness gets: the message with a leading `@alias` removed (the
 * mention was for oort, not for the model). Anything after it is kept as typed;
 * a DM with the alias has no mention and passes through whole.
 */
export function promptFromMessage(text: string, handle: string): string {
  // One line-break spelling: a pasted CRLF would be refused by the desktop
  // signer (which signs `\n` and tab only), and the host reads the same text.
  const normalized = text.normalize("NFC").replace(/\r\n?/g, "\n");
  const head = new RegExp(`^\\s*(?:<@${escapeRegExp(handle)}>|@${escapeRegExp(handle)})(?![\\p{L}\\p{N}_-])[\\s,:]*`, "iu");
  return normalized.replace(head, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The card title: the prompt's first line, cut to fit (one trimmed NFC line). */
export function labelFromPrompt(prompt: string): string {
  const first = (prompt.split(/\r?\n/).find((line) => line.trim() !== "") ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(first);
  const cut =
    chars.length > SPAWN_LABEL_MAX_CHARS
      ? `${chars.slice(0, SPAWN_LABEL_MAX_CHARS - 1).join("").trimEnd()}…`
      : first;
  return spawnLabelText(cut);
}

export type PersonalAgentCall =
  /** The Mac accepted the task (`replayed`: this answered a resend). */
  | { state: "called"; replayed: boolean; controlId: string }
  /** Only the message exists; nothing was signed or sent to the Mac. */
  | { state: "message_only"; reason: "no_signer" | "nothing_to_ask"; text: string }
  /**
   * The message exists, the call did not. `signed` is set when the statement
   * was signed and may be resent as it is while it lives (the Mac was off, the
   * network dropped): the server answers the same nonce with the same control.
   */
  | {
      state: "not_delivered";
      stage: "sign" | "server";
      text: string;
      error: unknown;
      signed: WorkSpawnBody | null;
    };

export interface PersonalAgentCallResult {
  /** The message the person sent — always, once the send succeeded. */
  message: Message;
  call: PersonalAgentCall;
}

export interface CallPersonalAgentInput {
  workspaceId: string;
  channelId: string;
  /** Set when the message is a reply in a thread (its root). */
  threadRootId?: string;
  clientMsgId: string;
  /** The message body as typed (`@alias …`, or the text of a DM with the alias). */
  text: string;
  agent: PersonalAgentTarget;
  destination: CallDestination;
  /** `null` where the client holds no signing key (an ordinary browser). */
  signer: HumanControlSigner | null;
  /**
   * How the message is sent, when the client has its own send path (the web
   * timeline's optimistic echo, attachments, quote). It must return the
   * committed message and throw when it could not be sent. Absent: the plain
   * REST send below.
   */
  deliver?: () => Promise<Message>;
}

/**
 * Send the message, then sign and post the spawn. Throws only when the MESSAGE
 * could not be sent (nothing was called); every later outcome is in `call`.
 */
export async function callPersonalAgent(
  input: CallPersonalAgentInput
): Promise<PersonalAgentCallResult> {
  const message = await (input.deliver !== undefined
    ? input.deliver()
    : input.threadRootId !== undefined
    ? sendThreadReply(input.workspaceId, input.channelId, input.threadRootId, input.clientMsgId, input.text)
    : sendMessage(input.workspaceId, input.channelId, input.clientMsgId, input.text));

  if (input.signer === null) {
    return {
      message,
      call: { state: "message_only", reason: "no_signer", text: CALL_NEEDS_APP_LINE },
    };
  }

  let prompt: string;
  let label: string;
  try {
    prompt = promptFromMessage(input.text, input.agent.handle);
    if (prompt.trim() === "") {
      return {
        message,
        call: { state: "message_only", reason: "nothing_to_ask", text: CALL_NOTHING_TO_ASK_LINE },
      };
    }
    prompt = spawnPromptText(prompt);
    label = labelFromPrompt(prompt);
  } catch (error) {
    return { message, call: notDelivered("sign", error, null) };
  }

  let humanSignature: HumanSignatureRequest;
  try {
    humanSignature = await input.signer.sign({
      hostId: input.destination.hostId,
      sessionId: null,
      nonce: newNonce(),
      content: {
        kind: "spawn_task",
        agentMemberId: input.agent.memberId,
        folderId: input.destination.folderId,
        tool: input.destination.tool,
        channelId: input.channelId,
        threadRootId: message.rootId ?? null,
        originMessageId: message.id,
        label,
        prompt,
      },
    });
  } catch (error) {
    return { message, call: notDelivered("sign", error, null) };
  }

  const body: WorkSpawnBody = {
    tool: input.destination.tool,
    label,
    prompt,
    channelId: input.channelId,
    ...(message.rootId !== undefined ? { threadRootId: message.rootId } : {}),
    originMessageId: message.id,
    targetHostId: input.destination.hostId,
    humanSignature,
  };
  return { message, call: await postSigned(input.workspaceId, body) };
}

/** Post a statement that was already signed — a resend after the Mac was off
 * or the network dropped. The same nonce answers with the same control. */
export async function resendPersonalAgentCall(
  workspaceId: string,
  signed: WorkSpawnBody
): Promise<PersonalAgentCall> {
  return postSigned(workspaceId, signed);
}

async function postSigned(workspaceId: string, body: WorkSpawnBody): Promise<PersonalAgentCall> {
  let result: WorkSpawnResult;
  try {
    result = await postWorkSpawn(workspaceId, body);
  } catch (error) {
    return notDelivered("server", error, mayResend(error) ? body : null);
  }
  return { state: "called", replayed: result.replayed, controlId: result.workControl.id };
}

/** Only a refusal that proves the server did nothing and could be undone by
 * time (Mac off, pool full) or by the network keeps the signature. */
function mayResend(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return (
    error.status >= 500 ||
    error.status === 408 ||
    error.code === "work_host_offline" ||
    error.code === "pool_exhausted" ||
    error.code === "member_limit"
  );
}

function notDelivered(
  stage: "sign" | "server",
  error: unknown,
  signed: WorkSpawnBody | null
): PersonalAgentCall {
  return { state: "not_delivered", stage, text: callFailureLine(error), error, signed };
}

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
import type { PlainMessageKey } from "../../i18n/keys";
import type { FailureMessage } from "./failureMessage";
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
export const CALL_NEEDS_APP_KEY = "auth.personalCall.needsApp" satisfies PlainMessageKey;

/** Mac off: nothing is queued (D4 결재 6). */
export const CALL_MAC_OFF_KEY = "auth.personalCall.macOff" satisfies PlainMessageKey;

export const CALL_NOTHING_TO_ASK_KEY = "auth.personalCall.nothingToAsk" satisfies PlainMessageKey;

/** The label a failed call carries (same word as a failed instruction). */
export const CALL_NOT_DELIVERED_KEY = "auth.signedControl.notDelivered" satisfies PlainMessageKey;

/** Why the call did not start, as one sentence. Signer, signature, then the
 * spawn route's own codes (`work_spawns.rs`), then transport. */
export function callFailureMessage(error: unknown): FailureMessage {
  if (error instanceof SignerRefusal) return error.refusal;
  if (error instanceof SpawnTaskInputError) return { key: "auth.personalCall.inputInvalid" };
  const signature = humanSignatureRefusal(error);
  if (signature) return { key: signature.key };
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case "work_host_offline":
      return { key: CALL_MAC_OFF_KEY };
    case "signed_spawn_disabled":
      return { key: "auth.personalCall.spawnDisabled" };
    case "spawn_host_not_found":
      return { key: "auth.personalCall.hostNotFound" };
    case "spawn_folder_not_found":
      return { key: "auth.personalCall.folderNotFound" };
    case "spawn_host_ambiguous":
      return { key: "auth.personalCall.hostAmbiguous" };
    case "spawn_agent_not_allowed":
      return { key: "auth.personalCall.agentNotAllowed" };
    case "spawn_channel_member_only":
      return { key: "auth.personalCall.channelMemberOnly" };
    case "spawn_origin_invalid":
      return { key: "auth.personalCall.originInvalid" };
    case "spawn_prompt_invalid":
    case "spawn_slash_command":
    case "spawn_label_invalid":
    case "spawn_tool_invalid":
    case "spawn_folder_required":
      return { key: "auth.personalCall.promptInvalid" };
    case "spawn_nonce_reused":
      return { key: "auth.personalCall.nonceReused" };
    case "pool_exhausted":
    case "member_limit":
      return { key: "auth.personalCall.poolFull" };
    default:
      return { key: "auth.personalCall.callDefault" };
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
  /** The harness the agent runs (roster `personalAgent.harness`: `claude_code`,
   * `codex`) or already a tool key (`claude`). `callPersonalAgent` signs
   * {@link toolKeyForHarness} of it. */
  tool: string;
}

/**
 * The work tool key the server allowlists for a roster harness name (#3660).
 * The roster says `claude_code` (`agent.subscription_harness`); the
 * `work_tool_profile` key is `claude`. Signing the harness name was refused as
 * `spawn_tool_invalid` on every call. The server accepts only the lower-case
 * key, so anything unknown passes through unchanged.
 */
export function toolKeyForHarness(harness: string): string {
  const key = harness.trim().toLowerCase();
  return key === "claude_code" ? "claude" : key;
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
  | { state: "message_only"; reason: "no_signer" | "nothing_to_ask"; message: FailureMessage }
  /**
   * The message exists, the call did not. `signed` is set when the statement
   * was signed and may be resent as it is while it lives (the Mac was off, the
   * network dropped): the server answers the same nonce with the same control.
   */
  | {
      state: "not_delivered";
      stage: "sign" | "server";
      message: FailureMessage;
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
  /**
   * 「이번 메시지는 미리보기 없이 보내기」 (#5037, ADR-0170 증보 2026-11-01 D21): the composer's
   * ✕ turned the link preview off for this message, so the message gets no link cards.
   *
   * It rides **the plain REST send only** — `SendMessageOptions.suppressUnfurl` /
   * `ThreadReplyOptions.suppressUnfurl`, and only when `true` (that request is closed-world:
   * an unflagged call stays byte-identical to what it was before this field). When `deliver`
   * is given the caller owns the request and this field is not read: the web's `deliver`
   * already carries the pending row's flag, so a second source would only be able to disagree.
   * The call itself (the signed spawn) never touches unfurls — it names the message by id.
   */
  suppressUnfurl?: boolean;
}

/**
 * Send the message, then sign and post the spawn. Throws only when the MESSAGE
 * could not be sent (nothing was called); every later outcome is in `call`.
 */
export async function callPersonalAgent(
  input: CallPersonalAgentInput
): Promise<PersonalAgentCallResult> {
  // The key is absent (not `false`) unless the person turned the preview off: see the field.
  const unfurl = input.suppressUnfurl === true ? { suppressUnfurl: true } : undefined;
  const message = await (input.deliver !== undefined
    ? input.deliver()
    : input.threadRootId !== undefined
    ? sendThreadReply(input.workspaceId, input.channelId, input.threadRootId, input.clientMsgId, input.text, unfurl)
    : sendMessage(input.workspaceId, input.channelId, input.clientMsgId, input.text, unfurl));

  if (input.signer === null) {
    return {
      message,
      call: { state: "message_only", reason: "no_signer", message: { key: CALL_NEEDS_APP_KEY } },
    };
  }

  const tool = toolKeyForHarness(input.destination.tool);
  let prompt: string;
  let label: string;
  try {
    prompt = promptFromMessage(input.text, input.agent.handle);
    if (prompt.trim() === "") {
      return {
        message,
        call: {
          state: "message_only",
          reason: "nothing_to_ask",
          message: { key: CALL_NOTHING_TO_ASK_KEY },
        },
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
        tool,
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
    tool,
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
  return { state: "not_delivered", stage, message: callFailureMessage(error), error, signed };
}

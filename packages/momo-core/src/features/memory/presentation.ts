import { ApiError } from "../../lib/api";
import { isWorkspaceOperator } from "../settings/model";
import { serverSaysAbsent } from "../capabilities/serverSurfaces";
import type { MembershipRole } from "../../lib/api";
import {
  memoryIsCaughtUp,
  type MemoryDigest,
  type MemoryDigestPage,
  type MemoryReceipt,
  type MemorySettings,
} from "./model";

// =============================================================================
// Team memory v2 presentation model (ADR-0196 D7 / D9 / D12, #3165).
//
// What a screen may SAY about digests and receipts is decided here, in one
// place, so the web card, the phone card (#3166) and the tests read the same
// rules. Two invariants carry the file:
//
//   1. Nothing is invented on the client. Every state below is a function of
//      what the server returned. A digest the caller may not read is simply
//      absent (row-level security), so this file never claims a digest is
//      "being regenerated": the API cannot tell.
//   2. "Nothing to summarize" and "not summarized yet" are different sentences.
//      The only honest way to tell them apart is `summarizedThroughSeq` against
//      the channel head.
// =============================================================================

/**
 * The card stays out of a short catch-up. Five matches the smallest batch the
 * summary worker acts on (ADR-0196 D10: 「≥5건 쌓이고 30분 정지」), so fewer
 * unread messages than this can never have a digest of their own.
 */
export const MISSED_CARD_MIN_UNREAD = 5;

/** Whether this visit warrants the card at all. Kept pure for the shell and tests. */
export function wantsMissedSummary(input: {
  provided: boolean;
  channelId: string | null;
  unreadCount: number;
}): boolean {
  return (
    input.provided &&
    input.channelId !== null &&
    input.unreadCount >= MISSED_CARD_MIN_UNREAD
  );
}

/** Digests shown before the rest fold behind a disclosure. */
export const MISSED_CARD_VISIBLE_DIGESTS = 3;

/** Evidence links shown per digest before the rest fold. */
export const EVIDENCE_VISIBLE_LINKS = 4;

/** A query result as a screen holds it, without a React Query dependency. */
export type MemoryQueryView<T> =
  | { status: "pending" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: T };

export type MemoryOffReason =
  | "workspaceOff"
  | "workspacePaused"
  | "channelExcluded"
  | "channelPaused"
  | "mePaused";

export type MissedCardState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "off"; reason: MemoryOffReason; message: string }
  | { kind: "error"; message: string }
  | { kind: "notYet"; message: string }
  | { kind: "empty"; message: string }
  | {
      kind: "ready";
      /** Oldest first, the order a person reads a catch-up in. */
      digests: MemoryDigest[];
      /** True when the worker has not reached the head the reader came back to. */
      behindHead: boolean;
      /** Set only when the server told us how far it got. */
      unsummarizedCount: number | null;
    };

export const MEMORY_OFF_COPY: Record<MemoryOffReason, string> = {
  workspaceOff:
    "이 워크스페이스는 팀 기억을 꺼 두었어요. 관리자가 설정 › 기억에서 켤 수 있어요.",
  workspacePaused:
    "팀 기억이 잠시 멈춰 있어요. 관리자가 다시 시작하면 요약이 이어서 만들어져요.",
  channelExcluded:
    "이 채널은 요약에서 빠져 있어요. 채널 메뉴의 기억 설정에서 바꿀 수 있어요.",
  channelPaused:
    "이 채널의 기억이 잠시 멈춰 있어요. 채널 메뉴의 기억 설정에서 다시 시작할 수 있어요.",
  mePaused:
    "내 기억을 멈춰 두었어요. 설정 › 기억에서 다시 시작할 수 있어요.",
};

export const MISSED_NOT_YET_COPY =
  "아직 요약하지 못했어요. 안 읽은 메시지의 요약이 만들어지면 여기에 나타나요.";
export const MISSED_EMPTY_COPY =
  "요약할 만한 내용이 없어요. 안 읽은 메시지를 바로 읽어 보세요.";
export const MISSED_ERROR_COPY = "요약을 불러오지 못했어요. 잠시 뒤에 다시 시도해 주세요.";

/**
 * Why memory is not running for this channel and this reader, or null when it
 * is. Order is broadest switch first: a workspace that is off explains the
 * card whatever the channel says. A channel with no explicit row is at its
 * defaults, which is "on", not "excluded".
 */
export function memoryOffReason(
  settings: MemorySettings,
  channelId: string
): MemoryOffReason | null {
  if (!settings.workspace.enabled) return "workspaceOff";
  if (settings.workspace.paused) return "workspacePaused";
  const channel = settings.channels.find(
    (row) => row.channelId.toLowerCase() === channelId.toLowerCase()
  );
  if (channel?.excluded === true) return "channelExcluded";
  if (channel?.paused === true) return "channelPaused";
  if (settings.me.paused) return "mePaused";
  return null;
}

/**
 * Derive the missed-conversation card from the two queries behind it.
 *
 * `headSeq` is the newest channel sequence the reader had when the channel was
 * opened (the visit-frozen value, not a live one), which is what "behind"
 * means for a catch-up.
 */
export function deriveMissedCard(input: {
  settings: MemoryQueryView<MemorySettings>;
  digests: MemoryQueryView<MemoryDigestPage> | null;
  channelId: string;
  headSeq: number;
}): MissedCardState {
  const { settings, digests, channelId, headSeq } = input;
  if (settings.status === "error") {
    return serverSaysAbsent(settings.error)
      ? { kind: "hidden" }
      : { kind: "error", message: MISSED_ERROR_COPY };
  }
  if (settings.status === "pending") return { kind: "loading" };
  const off = memoryOffReason(settings.data, channelId);
  if (off !== null) {
    return { kind: "off", reason: off, message: MEMORY_OFF_COPY[off] };
  }
  if (digests === null || digests.status === "pending") return { kind: "loading" };
  if (digests.status === "error") {
    return serverSaysAbsent(digests.error)
      ? { kind: "hidden" }
      : { kind: "error", message: MISSED_ERROR_COPY };
  }

  const page = digests.data;
  const caughtUp = memoryIsCaughtUp(page, headSeq);
  if (page.digests.length === 0) {
    return caughtUp
      ? { kind: "empty", message: MISSED_EMPTY_COPY }
      : { kind: "notYet", message: MISSED_NOT_YET_COPY };
  }
  const ordered = [...page.digests].sort((a, b) => a.fromSeq - b.fromSeq);
  const reached = page.summarizedThroughSeq;
  return {
    kind: "ready",
    digests: ordered,
    behindHead: !caughtUp,
    unsummarizedCount:
      reached !== undefined && reached < headSeq ? headSeq - reached : null,
  };
}

/** The one line under a digest that tells how much it rests on. */
export function digestSourceLabel(digest: Pick<MemoryDigest, "sourceCount">): string {
  return `메시지 ${digest.sourceCount}개를 바탕으로 만들었어요`;
}

/** Sentence for the tail of a card whose summary stops short of the head. */
export function behindHeadLabel(unsummarizedCount: number | null): string {
  return unsummarizedCount === null
    ? "가장 최근 대화는 아직 요약하지 못했어요."
    : `가장 최근 메시지 ${unsummarizedCount}개는 아직 요약하지 못했어요.`;
}

/** 「근거 1」, the link text for the nth source message (no sequence numbers on screen). */
export function evidenceLabel(index: number): string {
  return `근거 ${index + 1}`;
}

export function evidenceAccessibleLabel(index: number): string {
  return `근거 메시지 ${index + 1}로 이동`;
}

// ---- receipt chip -----------------------------------------------------------

export interface ReceiptChipModel {
  /** 「기억 n개 참고」 */
  label: string;
  servedCount: number;
  digests: MemoryDigest[];
  /**
   * Digests counted in `servedCount` that this reader cannot open (or that are
   * not digests). Shown as a plain fact so the number on the chip and the list
   * under it never silently disagree.
   */
  unlistedCount: number;
  /** Present only when the server returned it and it is above zero. */
  withheldCount: number | null;
}

export function receiptChipLabel(servedCount: number): string {
  return `기억 ${servedCount}개 참고`;
}

export function withheldLabel(count: number): string {
  return `이 채널 답에는 싣지 않은 기억 ${count}개`;
}

export const WITHHELD_EXPLAIN_COPY =
  "요청한 분은 볼 수 있지만, 이 채널 멤버 모두에게 보이는 답에는 넣지 않은 기억이에요. 내용은 보이지 않고 개수만 알려요.";

export function unlistedLabel(count: number): string {
  return `나머지 ${count}개는 이 목록에서 열 수 없는 기억이에요.`;
}

/**
 * Chip model for a receipt, or null when there is nothing to show (no chip).
 * `withheldCount` is echoed only when the API returned it: an absent field
 * means the caller is not the requester, and a zero says nothing worth a line.
 */
export function deriveReceiptChip(
  receipt: MemoryReceipt | null | undefined
): ReceiptChipModel | null {
  if (!receipt || receipt.servedCount <= 0) return null;
  const withheld = receipt.withheldCount;
  return {
    label: receiptChipLabel(receipt.servedCount),
    servedCount: receipt.servedCount,
    digests: receipt.digests,
    unlistedCount: Math.max(0, receipt.servedCount - receipt.digests.length),
    withheldCount: withheld !== undefined && withheld > 0 ? withheld : null,
  };
}

export const CHANNEL_MEMORY_SETTINGS_LABEL = "기억 설정";

// ---- settings ---------------------------------------------------------------

export const WORKSPACE_SWITCH_ADMIN_ONLY_REASON =
  "워크스페이스 관리자만 바꿀 수 있어요.";
export const CHANNEL_SWITCH_ADMIN_ONLY_REASON =
  "워크스페이스 관리자나 채널 관리자만 바꿀 수 있어요.";

/** Notice next to the workspace switch (ADR-0196 D9 team notice). */
export const TEAM_MEMORY_NOTICE =
  "팀 기억을 켜면 채널 대화가 요약을 만드는 AI에게 전달돼요. 요약에는 원본 메시지 링크가 함께 남아요. 사람끼리의 DM은 기본으로 빠져요.";

export function canChangeWorkspaceMemory(role: MembershipRole | undefined): boolean {
  return isWorkspaceOperator(role);
}

export type MemoryWriteScope = "workspace" | "channel" | "me";

/** A rejected settings write as a sentence the reader can act on. */
export function memoryWriteErrorMessage(
  error: unknown,
  scope: MemoryWriteScope
): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      if (scope === "workspace") return WORKSPACE_SWITCH_ADMIN_ONLY_REASON;
      if (scope === "channel") return CHANNEL_SWITCH_ADMIN_ONLY_REASON;
      return "이 계정으로는 내 기억 설정을 바꿀 수 없어요.";
    }
    // The server's validation failures on these routes are 400; 422 is
    // treated the same way so a server that answers either is not "unknown".
    if (error.status === 400 || error.status === 422) {
      return "서버가 이 값을 받아들이지 못했어요. 화면을 새로 열고 다시 시도해 주세요.";
    }
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return "이 서버는 아직 기억 설정을 지원하지 않아요.";
    }
    if (error.status === 401) {
      return "로그인이 만료됐어요. 다시 로그인한 뒤 시도해 주세요.";
    }
  }
  return "저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.";
}

export const MEMORY_SETTINGS_LOAD_ERROR =
  "기억 설정을 불러오지 못했어요. 잠시 뒤에 다시 시도해 주세요.";

import type { TimelineMessage } from "../timeline/model";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface ApprovalCardModel {
  approvalId: string | null;
  title: string;
  summary?: string;
  status: ApprovalStatus;
  isResumeOffer: boolean;
}

const APPROVAL_STATUSES = new Set<ApprovalStatus>([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

export function parseApprovalStatus(value: unknown): ApprovalStatus | null {
  return typeof value === "string" &&
    APPROVAL_STATUSES.has(value as ApprovalStatus)
    ? (value as ApprovalStatus)
    : null;
}

/**
 * Parse only the public basic-mode fields from an approval_request message.
 * Tool arguments, paths, credentials, and cost details remain opaque.
 */
export function approvalCardModel(
  message: TimelineMessage
): ApprovalCardModel | null {
  if (message.type !== "approval_request" || !message.props) return null;
  const props = message.props;
  const isResumeOffer = props["kind"] === "resume_offer";
  const rawApprovalId = props["approval_id"];
  const approvalId =
    typeof rawApprovalId === "string" && rawApprovalId !== ""
      ? rawApprovalId
      : null;
  if (!isResumeOffer && approvalId === null) return null;

  const rawTitle = props["title"];
  const rawSummary = props["summary"];
  const status =
    parseApprovalStatus(props["approval_status"]) ??
    parseApprovalStatus(props["status"]) ??
    "pending";
  const model: ApprovalCardModel = {
    approvalId,
    title:
      typeof rawTitle === "string" && rawTitle !== ""
        ? rawTitle
        : (message.body ?? "승인 요청"),
    status,
    isResumeOffer,
  };
  if (typeof rawSummary === "string" && rawSummary !== "") {
    model.summary = rawSummary;
  }
  return model;
}

/** A settled snapshot always wins over a stale pending projection. */
export function resolveApprovalStatus(
  storeStatus: string | null,
  messageStatus: ApprovalStatus
): ApprovalStatus {
  const parsedStore = parseApprovalStatus(storeStatus);
  if (parsedStore !== null && parsedStore !== "pending") return parsedStore;
  if (messageStatus !== "pending") return messageStatus;
  return parsedStore ?? messageStatus;
}


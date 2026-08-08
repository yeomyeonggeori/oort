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

// -----------------------------------------------------------------------------
// Approval projection notation (#1176).
//
// `GET /v1/workspaces/{id}/approvals` answers in TWO notations while two
// servers are in the tree:
//
//   * the deployed api is Rust/Axum (ADR-0145; docs/DEPLOY.md §DESK-1 measured
//     it live), and its `ApprovalDto` carries `#[serde(rename_all =
//     "camelCase")]` — `actionType`, `requestedBy`;
//   * the Swift `MomoServer` that `infra/docker-compose.e2e.yml` still boots for
//     the web e2e/login smoke maps the same fields to snake_case through
//     explicit `CodingKeys` (`server/Sources/MomoServer/DTOs.swift`) —
//     `action_type`, `requested_by`.
//
// `docs/api/openapi.yaml` follows the deployed wire (camelCase) and says so in
// the `ApprovalProjection` description, so `src/api/schema.d.ts` declares
// camelCase only. Reading one notation off the raw row therefore breaks against
// the other server, which is exactly what happened here: this file's caller read
// `requested_by`, the deployed server sends `requestedBy`, and
// `displayNameFor(undefined)` threw on `undefined.toLowerCase()` — the whole
// approvals panel, not one label.
//
// So read both, in the canonical client's shape (`wireStr`,
// `packages/momo-core/src/lib/api.ts`). Deployed notation wins; the snake_case
// arm and this comment go away with the Swift server (ADR-0145).
// -----------------------------------------------------------------------------

function wireString(
  row: unknown,
  camelKey: string,
  snakeKey: string
): string | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const fields = row as Record<string, unknown>;
  for (const key of [camelKey, snakeKey]) {
    const value = fields[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** `tool_call`, `deploy`, `work.spawn`, … — absent if the row carries neither notation. */
export function approvalActionType(approval: unknown): string | undefined {
  return wireString(approval, "actionType", "action_type");
}

/** The requesting agent member id — absent if the row carries neither notation. */
export function approvalRequestedBy(approval: unknown): string | undefined {
  return wireString(approval, "requestedBy", "requested_by");
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

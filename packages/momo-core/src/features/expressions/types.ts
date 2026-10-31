/** ADR-0218 appendix A–D. Wire names are camelCase; no client media URLs. */
export const EXPRESSION_LIMITS = {
  workspace: 1000,
  candidates: 4,
  tags: 8,
  tagChars: 16,
  nameChars: 30,
  inputBytes: 5 * 1024 * 1024,
  generatedBytes: 1024 * 1024,
  generatedBase64Chars: 1398104,
  agentRequestBytes: 6 * 1024 * 1024,
  smallPixels: 128,
  smallBytes: 256 * 1024,
  largePixels: 512,
  largeBytes: 1024 * 1024,
  frames: 100,
  durationMs: 10000,
} as const;

export type ExpressionVersion = string;
export type ExpressionStatus = "active" | "hidden" | "deleted";
export type ExpressionAddPolicy = "members" | "admins";
export type ExpressionVariant = "small" | "large" | "thumb";
export interface ExpressionOrigin {
  kind: "upload" | "attachment" | "generated" | "url";
  /** Public HTTPS host/path only: no credentials, query, or fragment. */
  sourceUrl: string | null;
  /** Agent-authored plain text, displayed as such; never audit/log content. */
  prompt: string | null;
  /**
   * ADR-0218 §7 G1/G7: only `generated` can carry it. A record pointer to the attachment
   * in the same conversation this picture was made from, never a key to open it. `null` =
   * made from a prompt alone; absent = the server (C2) does not say yet. Optional on
   * purpose: a payload without it must still read and show exactly as before.
   */
  sourceAttachmentId?: string | null;
}

export interface ExpressionImage {
  mime: "image/png" | "image/gif";
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
}

export interface ExpressionMedia {
  small: ExpressionImage;
  large: ExpressionImage;
  thumb: ExpressionImage;
}

export interface ExpressionMetadata {
  name: string;
  displayName: string;
  tags: string[];
  subjectMemberId: string | null;
}

export interface Expression extends ExpressionMetadata {
  id: string;
  workspaceId: string;
  /** Never reassigned or renamed, including after deletion. */
  version: ExpressionVersion;
  status: ExpressionStatus;
  media: ExpressionMedia | null;
  origin: ExpressionOrigin;
  createdBy: string;
  createdAtMs: number;
}

export interface ExpressionList {
  workspaceId: string;
  version: ExpressionVersion;
  /** null = full snapshot; otherwise exactly the requested `since`. */
  baseVersion: ExpressionVersion | null;
  reset: boolean;
  addPolicy: ExpressionAddPolicy;
  items: Expression[];
}

export const MANUAL_UPLOAD_CODES = [
  "source_blocked", "source_unavailable", "source_too_large",
  "source_unsupported", "source_timeout", "source_invalid_media",
  "video_processing_unavailable", "video_conversion_failed",
] as const;
export type ManualUploadCode = typeof MANUAL_UPLOAD_CODES[number];

/**
 * ADR-0218 §7 G3.8: why a generated or assembled picture is missing. The `Draft.code` enum of
 * `contracts.schema.json` is `MANUAL_UPLOAD_CODES` followed by these six (merged on #4820 C2b,
 * G7); the lists stay apart because the link-import codes and the generation codes have
 * different owners and show different cards. `assembly_params_invalid` is a call error with no
 * card, so it is not here.
 */
export const EXPRESSION_FAILURE_CODES = [
  "generation_failed", "assembly_source_invalid", "assembly_source_too_large",
  "assembly_output_too_large", "assembly_timeout", "assembly_busy",
] as const;
export type ExpressionFailureCode = typeof EXPRESSION_FAILURE_CODES[number];

interface ExpressionDraftBase extends ExpressionMetadata {
  draftId: string;
  workspaceId: string;
  revision: ExpressionVersion;
  origin: ExpressionOrigin;
  expiresAtMs: number;
}

export type ExpressionDraft = ExpressionDraftBase & (
  | { state: "ready"; code: null; media: ExpressionMedia }
  | { state: "manual_upload_required"; code: ManualUploadCode | ExpressionFailureCode; media: null }
);

export interface ExpressionImportRequest extends ExpressionMetadata {
  url: string;
}
export interface ExpressionAttachmentRequest extends ExpressionMetadata {
  attachmentId: string;
  channelId: string;
}
export interface ExpressionChoice {
  draftId: string;
  revision: ExpressionVersion;
  /** Hash of the large rendition actually shown before approval. */
  sha256: string;
}
export type ExpressionCreateRequest = ExpressionChoice;
export interface ExpressionMutation {
  workspaceId: string;
  version: ExpressionVersion;
  expression: Expression;
}
export interface ExpressionPatch {
  displayName?: string;
  tags?: string[];
}
export interface ExpressionReportRequest {
  reason: "copyright" | "face" | "other";
  detail?: string;
}

export type ExpressionAgentImage =
  | { source: "attachment"; attachmentId: string }
  | { source: "generated"; mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; dataBase64: string; prompt: string }
  | { source: "url"; url: string }
  // ADR-0218 G3.6: one candidate of what the server assembled and kept under `assemblyId`.
  | { source: "assembled"; assemblyId: string; index: number };
export interface ExpressionAgentCandidate extends ExpressionMetadata {
  image: ExpressionAgentImage;
}
export interface ExpressionAgentAction {
  action: "expression.create";
  args: { candidates: ExpressionAgentCandidate[] };
}
/** Extension of ADR-0186 props.action.expression, authored only by the server. */
export interface ExpressionApproval {
  v: 1;
  candidates: ExpressionDraft[];
}
/** Extension of the existing decision request; not a separate approval route. */
export interface ExpressionDecision {
  expressionChoice: ExpressionChoice;
}
/** Extension of existing props.result.expression after the same-tx activation. */
export interface ExpressionResult {
  id: string;
  name: string;
  token: string;
}
/** Model (a): this is the entire expression-specific message input. */
export interface ExpressionMessageInput {
  body: string;
}

export interface ExpressionChanged {
  type: "expression.changed";
  workspaceId: string;
  version: ExpressionVersion;
}

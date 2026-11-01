import { expressionFailureLine } from "../approvals/approvalOutcome";
import { expressionCopy } from "./cardCopy";
import type { ExpressionChoice, ExpressionDraft, ManualUploadCode } from "./types";

const MANUAL_COPY: Record<ManualUploadCode, string> = {
  source_blocked: "이 출처에서 그림을 받지 못했어요. 직접 올려 주세요.",
  source_unavailable: "그림을 받지 못했어요. 출처에서 확인하고 직접 올려 주세요.",
  source_too_large: "파일이 커서 받지 못했어요. 크기를 줄여 직접 올려 주세요.",
  source_unsupported: "이 형식은 받지 못했어요. PNG나 GIF로 직접 올려 주세요.",
  source_timeout: "그림을 받는 시간이 길어졌어요. 직접 올려 주세요.",
  source_invalid_media: "그림을 확인하지 못했어요. 다른 파일을 직접 올려 주세요.",
  video_processing_unavailable: "영상 변환이 아직 준비되지 않았어요. GIF로 직접 올려 주세요.",
  video_conversion_failed: "영상을 변환하지 못했어요. GIF로 직접 올려 주세요.",
};

/**
 * The sentence for a slot that has no picture. A fetch failure, then a generation or
 * assembly failure (ADR-0218 G3.8), then a neutral line: a code this build has never seen
 * must not leave an empty line where the reason belongs. The key comes off the wire, so
 * the own-property check keeps `constructor` and `__proto__` from answering for a code.
 */
function manualUploadLine(code: string): string {
  return (Object.hasOwn(MANUAL_COPY, code) ? MANUAL_COPY[code as ManualUploadCode] : null)
    ?? expressionFailureLine(code)
    ?? expressionCopy("expressions.card.manualFallback");
}

/** Approval status is independent: a failed fetch leaves the request pending. */
export function expressionDraftCard(draft: ExpressionDraft, nowMs: number, pending = true) {
  const expired = nowMs >= draft.expiresAtMs;
  const open = pending && !expired;
  return {
    state: !pending ? "settled" as const : expired ? "expired" as const : draft.state,
    sourceLink: draft.origin.sourceUrl,
    preview: open && draft.state === "ready" ? draft.media : null,
    canApprove: open && draft.state === "ready",
    canUpload: open && draft.state === "manual_upload_required",
    uploadLabel: "직접 올리기",
    code: draft.code,
    line: !pending ? "처리가 끝난 요청이에요" : expired ? "승인을 기다리다 만료됐어요" :
      draft.state === "manual_upload_required" ? manualUploadLine(draft.code) : "이 그림을 팀 보관함에 등록할까요?",
  };
}

/** One 「원본 사진」 line. `attachmentId` is set only when there is a picture to try to show. */
export interface ExpressionSourceLine {
  kind: "attached" | "none";
  attachmentId: string | null;
  label: string;
  /** What the line says when the attachment cannot be opened: deleted or out of reach (G1). */
  missingLabel: string;
}

export interface ExpressionApprovalSummary {
  /** Pictures on the card that exist: a slot that failed is not a picture. */
  count: number;
  /** 「그림 n장」, or null when there is nothing to count. A number only (ADR-0218 G5, model A). */
  countLabel: string | null;
  /** One line per distinct original, in the order the candidates name them. */
  sources: ExpressionSourceLine[];
}

/**
 * What the head of an approval card says about AI-made pictures (ADR-0218 G1, G5).
 *
 * Both lines belong to `generated` candidates only: a picture fetched from a link or
 * uploaded by hand has no original photo and costs no generation, so a request made of
 * those reads exactly as it did before. Inside a generated candidate the pointer has three
 * answers and the card keeps them apart. A UUID is an attached original. `null` is a
 * request made from words alone, which the card says out loud. Absent means the server
 * (C2) does not say, and an unknown must not turn into a claim, so no line is made.
 */
export function expressionApprovalSummary(drafts: readonly ExpressionDraft[]): ExpressionApprovalSummary {
  const generated = drafts.filter((draft) => draft.origin.kind === "generated");
  const count = generated.filter((draft) => draft.state === "ready").length;
  const seen = new Set<string | null>();
  const sources: ExpressionSourceLine[] = [];
  for (const draft of generated) {
    const attachmentId = readSourcePointer(draft.origin.sourceAttachmentId);
    if (attachmentId === undefined || seen.has(attachmentId)) continue;
    seen.add(attachmentId);
    sources.push({
      kind: attachmentId === null ? "none" : "attached",
      attachmentId,
      label: expressionCopy(attachmentId === null ? "expressions.card.sourcePhotoNone" : "expressions.card.sourcePhoto"),
      missingLabel: expressionCopy("expressions.card.sourcePhotoNone"),
    });
  }
  return { count, countLabel: count > 0 ? expressionCopy("expressions.card.pictureCount", { count }) : null, sources };
}

/** A real id, `null` for words alone, or undefined for absent and anything unreadable. */
function readSourcePointer(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function expressionChoice(draft: ExpressionDraft, nowMs: number): ExpressionChoice | null {
  if (!expressionDraftCard(draft, nowMs).canApprove || draft.state !== "ready") return null;
  return { draftId: draft.draftId, revision: draft.revision, sha256: draft.media.large.sha256 };
}

/** A replacement upload invalidates every previously viewed choice. */
export function matchesExpressionChoice(draft: ExpressionDraft, choice: ExpressionChoice, nowMs: number): boolean {
  const current = expressionChoice(draft, nowMs);
  return current !== null && current.draftId === choice.draftId && current.revision === choice.revision && current.sha256 === choice.sha256;
}

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
      draft.state === "manual_upload_required" ? MANUAL_COPY[draft.code] : "이 그림을 팀 보관함에 저장할까요?",
  };
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

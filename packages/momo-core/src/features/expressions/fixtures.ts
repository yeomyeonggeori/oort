import { FIXTURE_MEDIA } from "./fixtureMedia";
import type {
  Expression, ExpressionApproval, ExpressionDraft, ExpressionList,
  ExpressionFailureCode, ExpressionMedia, ExpressionOrigin, ExpressionResult, ManualUploadCode,
} from "./types";

export const FIXTURE_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const FIXTURE_MEMBER_ID = "00000000-0000-4000-8000-000000000002";
export const FIXTURE_APPROVAL_ID = "00000000-0000-4000-8000-000000000003";
export const FIXTURE_CHANNEL_ID = "00000000-0000-4000-8000-000000000004";
export const FIXTURE_NOW_MS = 1793314800000;
export const FIXTURE_MEDIA_SET: ExpressionMedia = {
  small: { ...FIXTURE_MEDIA.gif.image },
  large: { ...FIXTURE_MEDIA.gif.image },
  thumb: { ...FIXTURE_MEDIA.png.image },
};

export const FIXTURE_EXPRESSIONS: Expression[] = [
  { id: "00000000-0000-4000-8000-000000000011", name: "party_parrot", displayName: "파티 앵무새", tags: ["축하", "🎉"] },
  { id: "00000000-0000-4000-8000-000000000012", name: "ki_jeol", displayName: "기절", tags: ["놀람"] },
  { id: "00000000-0000-4000-8000-000000000013", name: "thumbs_up", displayName: "엄지척", tags: ["좋아요", "👍"] },
].map((item, index) => ({
  ...item, workspaceId: FIXTURE_WORKSPACE_ID, version: String(index + 1),
  status: "active", media: FIXTURE_MEDIA_SET, origin: { kind: "upload", sourceUrl: null, prompt: null },
  subjectMemberId: null, createdBy: FIXTURE_MEMBER_ID, createdAtMs: FIXTURE_NOW_MS,
}));

export const FIXTURE_LIST: ExpressionList = {
  workspaceId: FIXTURE_WORKSPACE_ID, version: "3", baseVersion: null, reset: true,
  addPolicy: "members", items: FIXTURE_EXPRESSIONS,
};
export const FIXTURE_HIDDEN_DELTA: ExpressionList = {
  ...FIXTURE_LIST, version: "4", baseVersion: "3", reset: false,
  items: [{ ...FIXTURE_EXPRESSIONS[0], version: "4", status: "hidden", media: null }],
};
export const FIXTURE_READY_DRAFT: ExpressionDraft = {
  draftId: "00000000-0000-4000-8000-000000000021", workspaceId: FIXTURE_WORKSPACE_ID,
  revision: "1", name: "happy_dance", displayName: "신나는 춤", tags: ["축하", "춤"],
  subjectMemberId: null, expiresAtMs: FIXTURE_NOW_MS + 3600000,
  origin: { kind: "url", sourceUrl: "https://giphy.com/gifs/example", prompt: null },
  state: "ready", code: null, media: FIXTURE_MEDIA_SET,
};
export function fixtureManualDraft(code: ManualUploadCode | ExpressionFailureCode = "source_blocked"): ExpressionDraft {
  return { ...FIXTURE_READY_DRAFT, state: "manual_upload_required", code, media: null };
}
/** An attachment of the same conversation, as an AI-made request points back at it (ADR-0218 G1). */
export const FIXTURE_SOURCE_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000031";
/**
 * One candidate of a request made from a photo: a picture the server assembled, with the
 * original photo recorded in its origin. `sourceAttachmentId` is optional on the type, so a
 * caller can pass `null` (words alone) or leave it out (an older server) to see both cards.
 */
export function fixtureGeneratedDraft(index: number, origin: Partial<ExpressionOrigin> = {}): ExpressionDraft {
  return {
    ...FIXTURE_READY_DRAFT,
    draftId: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    name: `ai_dance_${index}`, displayName: `움직이는 춤 ${index}`, tags: ["축하"],
    origin: { kind: "generated", sourceUrl: null, prompt: "웃는 얼굴로 춤추는 모습", sourceAttachmentId: FIXTURE_SOURCE_ATTACHMENT_ID, ...origin },
  };
}
/** Three pictures and one slot the server could not make: the size of the result was over the limit. */
export const FIXTURE_AI_APPROVAL: ExpressionApproval = {
  v: 1,
  candidates: [
    fixtureGeneratedDraft(1), fixtureGeneratedDraft(2), fixtureGeneratedDraft(3),
    { ...fixtureGeneratedDraft(4), state: "manual_upload_required", code: "assembly_output_too_large", media: null },
  ],
};
export const FIXTURE_APPROVAL: ExpressionApproval = {
  v: 1, candidates: [FIXTURE_READY_DRAFT, { ...fixtureManualDraft(), draftId: "00000000-0000-4000-8000-000000000022", name: "dance_two" }],
};
export const FIXTURE_RESULT: ExpressionResult = {
  id: FIXTURE_EXPRESSIONS[0].id, name: "party_parrot", token: ":party_parrot:",
};

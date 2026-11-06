import type { ExpressionSetGrayCode, ExpressionSetSkipReason } from "./set";

/**
 * Card copy of the set proposal (ADR-0218 §12 L5–L7, #5442), one ko and one en message per key, in the
 * shape of `cardCopy.ts` (keys are `feature.surface.intent`, values are ICU messages with the same
 * arguments in both languages) so that the day the shared catalogs take these over is a copy and a swap
 * of `expressionSetCopy`.
 *
 * The grey-slot lines below say what happened and nothing else. None of them offers a way round it
 * (no "describe it differently", no "try another picture"): a scene the model refused is closed for good
 * (L7), and a sentence that invites a retry would teach the person to do the thing the rule forbids.
 * They are not in `approvals/expression-failure-copy.json` on purpose: that file is read by the server
 * at compile time and mirrored row for row against the six assembly codes (G3.8); the four grey codes
 * are the set's own vocabulary.
 */
export const EXPRESSION_SET_COPY = {
  "expressions.set.question": { ko: "이 세트를 팀 보관함에 등록할까요?", en: "Save this set to the team library?" },
  /** The rights line D6 asks the registering screen to show, once for the set (not once per picture). */
  "expressions.set.rights": {
    ko: "저장해도 되는 그림인지 확인해 주세요. 고른 그림만 등록돼요.",
    en: "Make sure you are allowed to keep these pictures. Only the ones you pick are saved.",
  },
  "expressions.set.summary.ready": { ko: "그림 {count, number}개", en: "{count, plural, one {# picture} other {# pictures}}" },
  "expressions.set.summary.gray": { ko: "만들지 못한 장면 {count, number}개", en: "{count, plural, one {# scene not made} other {# scenes not made}}" },
  "expressions.set.gray.refused": {
    ko: "이 장면은 그림 모델이 만들 수 없다고 했어요",
    en: "The picture model said it cannot make this scene.",
  },
  "expressions.set.gray.failed": { ko: "이 장면은 그림을 만들지 못했어요", en: "This scene could not be made." },
  "expressions.set.gray.not_made": {
    ko: "시간이 모자라서 이 장면은 만들지 못했어요",
    en: "There was not enough time to make this scene.",
  },
  "expressions.set.gray.base_missing": {
    ko: "바탕이 되는 그림이 없어서 움직임을 입히지 못했어요",
    en: "There is no base picture to add motion to.",
  },
  "expressions.set.skip.name_taken": { ko: "이름이 이미 있어서 건너뛰었어요", en: "Skipped: the name is already taken." },
  "expressions.set.skip.quota": { ko: "보관함이 가득 차서 건너뛰었어요", en: "Skipped: the library is full." },
  /**
   * Reference pictures (ADR-0218 §12 L18-L19). The notice names no company and no model version (F10: nobody can
   * pick or know which model draws) and is shown before any byte of a picture leaves the server. The second line is
   * what the person declares by pressing the plan card's button: a set drawn from references carries no human face (v1).
   */
  "expressions.set.reference.notice": {
    ko: "첨부한 그림이 Hermes의 그림 모델로 전송돼요",
    en: "Attached pictures are sent to Hermes's picture model.",
  },
  /** The plan card (ADR-0218 §12 L2.5): what the person looks at before the one button that lets anything leave. */
  "expressions.set.plan.references": {
    ko: "보낼 참조 그림 {count, number}장",
    en: "{count, plural, one {# reference picture to send} other {# reference pictures to send}}",
  },
  "expressions.set.plan.pictures": {
    ko: "만들 그림 {count, number}장",
    en: "{count, plural, one {# picture to make} other {# pictures to make}}",
  },
  "expressions.set.plan.confirm": { ko: "이대로 만들기", en: "Make it" },
  "expressions.set.plan.revise": { ko: "장면 고치기", en: "Edit scenes" },
  "expressions.set.plan.cancel": { ko: "취소", en: "Cancel" },
  "expressions.set.reference.declare": {
    ko: "사람 얼굴이 있는 그림은 보내지 마세요. 이 그림들에는 사람 얼굴이 없어요.",
    en: "Do not send pictures that show a person's face. These pictures show none.",
  },
  "expressions.set.reference.kept": {
    ko: "Hermes는 보낸 그림과 결과를 자기 기록에 남길 수 있어요",
    en: "Hermes may keep what it receives and makes in its own records.",
  },
  "expressions.set.reference.count": {
    ko: "참고한 그림 {count, number}장",
    en: "{count, plural, one {# reference picture} other {# reference pictures}}",
  },
  /** Why a bundle was not sent. The whole bundle is refused, so each line names the one thing to fix. */
  "expressions.set.reference.refused.too_many": { ko: "그림은 {max, number}장까지 보낼 수 있어요", en: "Up to {max, number} pictures can be sent." },
  "expressions.set.reference.refused.duplicate": { ko: "같은 그림이 두 번 들어 있어요", en: "The same picture is attached twice." },
  "expressions.set.reference.refused.format": { ko: "PNG·JPEG·WebP 그림만 보낼 수 있어요", en: "Only PNG, JPEG and WebP pictures can be sent." },
  "expressions.set.reference.refused.input_bytes": { ko: "그림 한 장은 {mb, number}MB까지 보낼 수 있어요", en: "A picture can be up to {mb, number} MB." },
  "expressions.set.reference.refused.input_pixels": { ko: "그림이 너무 커서 보내지 못했어요", en: "The picture is too large to send." },
  "expressions.set.reference.refused.prepared_bytes": { ko: "그림을 줄여도 너무 커서 보내지 못했어요", en: "The picture is still too large after shrinking." },
  "expressions.set.reference.refused.bundle_bytes": { ko: "그림을 모두 합치면 너무 커서 보내지 못했어요", en: "The pictures together are too large to send." },
  "expressions.set.result.saved": {
    ko: "{count, number}개를 팀 보관함에 저장했어요",
    en: "{count, plural, one {# picture} other {# pictures}} saved to the team library",
  },
  "expressions.set.result.savedSkipped": {
    ko: "{saved, number}개를 저장하고 {skipped, number}개는 건너뛰었어요",
    en: "{saved, number} saved, {skipped, number} skipped",
  },
} as const;

export type ExpressionSetCopyKey = keyof typeof EXPRESSION_SET_COPY;

const ARGUMENT = /\{(\w+)(?:, number)?\}/g;

/** Korean only, which is all this track renders; understands `{name}` and `{name, number}` and nothing else. */
export function expressionSetCopy(key: ExpressionSetCopyKey, values: Readonly<Record<string, number>> = {}): string {
  return EXPRESSION_SET_COPY[key].ko.replace(ARGUMENT, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}

/** The line under a grey slot. A code this build has never seen reads as `failed`, never as an empty line. */
export function expressionSetGrayLine(code: ExpressionSetGrayCode | string): string {
  const key = `expressions.set.gray.${code}`;
  return Object.hasOwn(EXPRESSION_SET_COPY, key) ? expressionSetCopy(key as ExpressionSetCopyKey) : expressionSetCopy("expressions.set.gray.failed");
}

/** The line after a slot was left out of a registration. */
export function expressionSetSkipLine(reason: ExpressionSetSkipReason): string {
  return expressionSetCopy(reason === "quota" ? "expressions.set.skip.quota" : "expressions.set.skip.name_taken");
}

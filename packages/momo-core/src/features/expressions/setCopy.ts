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

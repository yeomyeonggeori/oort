/**
 * Card copy for the AI-made pictures (#4820 B stage 2), one ko and one en message per key.
 *
 * The shared message catalogs of ADR-0213 live on the other track, so they do not exist
 * under this tree yet. Until they land these pairs stay in one place and use the catalog's
 * shape on purpose: keys are `feature.surface.intent`, values are ICU messages, and ko and
 * en must name the same arguments. Moving them later is a copy into
 * `i18n/catalogs/{ko-KR,en-US}/expressions.json` plus swapping `expressionCopy` for the
 * message service; no caller changes. The six failure sentences are not here: they are
 * code-keyed golden data shared with the server (`approvals/expression-failure-copy.json`).
 *
 * `expressionCopy` resolves Korean only, which is all this track renders. It understands
 * exactly the two argument forms these messages use and nothing else.
 */
export const EXPRESSION_CARD_COPY = {
  /** Only the pictures that really exist: a slot that failed is not counted (ADR-0218 G5). */
  "expressions.card.pictureCount": {
    ko: "그림 {count, number}장",
    en: "{count, plural, one {# picture} other {# pictures}}",
  },
  "expressions.card.sourcePhoto": { ko: "원본 사진", en: "Original photo" },
  /** No pointer, or the attachment it points at is gone (ADR-0218 G1). */
  "expressions.card.sourcePhotoNone": { ko: "원본 사진 없음", en: "No original photo" },
  /** A slot with no picture whose reason this build does not know; never an empty line. */
  "expressions.card.manualFallback": {
    ko: "그림을 준비하지 못했어요. 직접 올려 주세요.",
    en: "The picture is not ready. Please upload one yourself.",
  },
} as const;

export type ExpressionCopyKey = keyof typeof EXPRESSION_CARD_COPY;

const ARGUMENT = /\{(\w+)(?:, number)?\}/g;

export function expressionCopy(key: ExpressionCopyKey, values: Readonly<Record<string, number>> = {}): string {
  return EXPRESSION_CARD_COPY[key].ko.replace(ARGUMENT, (whole, name: string) => Object.hasOwn(values, name) ? String(values[name]) : whole);
}

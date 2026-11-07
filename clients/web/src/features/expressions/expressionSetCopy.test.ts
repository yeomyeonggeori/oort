import { describe, expect, it } from "vitest";
import enCatalog from "../../../../../packages/momo-core/src/i18n/catalogs/en-US/expressions.json";
import koCatalog from "../../../../../packages/momo-core/src/i18n/catalogs/ko-KR/expressions.json";
import { EXPRESSION_SET_COPY, type ExpressionSetCopyKey } from "@momo/core/features/expressions/setCopy";

// ADR-0218 §12 L19: the notice is shown to the member in the core's words (`expressionSetReferenceNotice`). The web draws its sentences from the
// shared dictionary (so the language follows the app), and this test keeps the dictionary and the core's own copy from drifting: one wording, two places.
const KO = koCatalog as Record<string, string>;
const EN = enCatalog as Record<string, string>;

/** core copy key -> dictionary key. A dictionary key has three parts, so the longer core names fold into one. */
const SHARED: Record<ExpressionSetCopyKey, string | null> = {
  "expressions.set.question": null,
  "expressions.set.rights": "expressions.set.rights",
  "expressions.set.summary.ready": "expressions.set.summaryReady",
  "expressions.set.summary.gray": "expressions.set.summaryGray",
  "expressions.set.gray.refused": "expressions.set.grayRefused",
  "expressions.set.gray.failed": "expressions.set.grayFailed",
  "expressions.set.gray.not_made": "expressions.set.grayNotMade",
  "expressions.set.gray.base_missing": "expressions.set.grayBaseMissing",
  "expressions.set.skip.name_taken": null,
  "expressions.set.skip.quota": null,
  "expressions.set.reference.notice": "expressions.plan.notice",
  "expressions.set.plan.references": "expressions.plan.references",
  "expressions.set.plan.pictures": "expressions.plan.pictures",
  "expressions.set.plan.confirm": "expressions.plan.confirm",
  "expressions.set.plan.revise": "expressions.plan.revise",
  "expressions.set.plan.cancel": "expressions.plan.cancel",
  "expressions.set.reference.declare": "expressions.plan.declare",
  "expressions.set.reference.kept": "expressions.plan.kept",
  "expressions.set.reference.count": "expressions.set.referenceCount",
  "expressions.set.reference.refused.too_many": null,
  "expressions.set.reference.refused.duplicate": null,
  "expressions.set.reference.refused.format": null,
  "expressions.set.reference.refused.input_bytes": null,
  "expressions.set.reference.refused.input_pixels": null,
  "expressions.set.reference.refused.prepared_bytes": null,
  "expressions.set.reference.refused.bundle_bytes": null,
  "expressions.set.result.saved": "expressions.set.resultSaved",
  "expressions.set.result.savedSkipped": "expressions.set.resultSavedSkipped",
};

describe("the dictionary says the set sentences the way the core does", () => {
  it("covers every core sentence the card draws, in both languages, word for word", () => {
    const used = Object.entries(SHARED).filter((entry): entry is [ExpressionSetCopyKey, string] => entry[1] !== null);
    // The sentences the server tells the requester (why a bundle was refused) and the per-skip lines are not on these two cards.
    expect(used).toHaveLength(18);
    for (const [coreKey, key] of used) {
      expect(KO[key], `${key} (ko)`).toBe(EXPRESSION_SET_COPY[coreKey].ko);
      expect(EN[key], `${key} (en)`).toBe(EXPRESSION_SET_COPY[coreKey].en);
    }
  });

  it("names every core key once, so a new core sentence has to be placed here on purpose", () => {
    expect(Object.keys(SHARED).sort()).toEqual(Object.keys(EXPRESSION_SET_COPY).sort());
  });

  it("holds the same keys in both languages for everything the two cards add", () => {
    const own = (catalog: Record<string, string>) => Object.keys(catalog).filter((key) => key.startsWith("expressions.set.") || key.startsWith("expressions.plan.")).sort();
    expect(own(KO)).toEqual(own(EN));
    expect(own(KO).length).toBeGreaterThanOrEqual(50);
  });

  it("never tells the person to retry, upload or reword a scene the model refused (L7)", () => {
    for (const key of ["grayRefused", "grayFailed", "grayNotMade", "grayBaseMissing"]) {
      for (const catalog of [KO, EN]) {
        const line = catalog[`expressions.set.${key}`];
        expect(line, key).toBeTruthy();
        expect(line, key).not.toMatch(/다시|올려|올리|시도|바꿔|다르게|retry|try again|upload|reword|rephrase/i);
      }
    }
  });
});

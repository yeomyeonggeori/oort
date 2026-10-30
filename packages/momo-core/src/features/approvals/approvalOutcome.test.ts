import { describe, expect, it } from "vitest";
import copy from "./settlement-copy.json";
import { approvalOutcomeLine } from "./approvalOutcome";

describe("approval settlement copy shared with the server", () => {
  it.each(copy)("$code", ({ code, line }) => {
    expect(approvalOutcomeLine(code)).toBe(line);
  });
  it("does not invent an outcome for an unknown code", () => {
    for (const code of [undefined, null, "constructor", "future_outcome"]) {
      expect(approvalOutcomeLine(code)).toBeNull();
    }
  });
});

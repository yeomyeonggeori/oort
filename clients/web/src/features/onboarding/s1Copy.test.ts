import { describe, expect, it } from "vitest";
import { S1_FAILURE } from "./s1Copy";

describe("S1 failure copy (N-R2-3)", () => {
  it("S1_FAILURE says 지금은 once", () => {
    expect(S1_FAILURE).toBe(
      "지금은 저장하지 못했습니다. 다시 시도하거나, 건너뛴 뒤 설정에서 바꿀 수 있습니다."
    );
    expect([...S1_FAILURE.matchAll(/지금은/g)]).toHaveLength(1);
  });
});

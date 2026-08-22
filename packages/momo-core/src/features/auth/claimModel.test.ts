import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { claimFailureCopy } from "./claimModel";

describe("claimFailureCopy", () => {
  it("maps an invalid token to a next-step sentence, not the server English", () => {
    const copy = claimFailureCopy(new ApiError(404, "claim token is invalid"));
    expect(copy.message).toContain("유효하지 않습니다");
    expect(copy.message).not.toContain("invalid");
    expect(copy.retryable).toBe(false);
    expect(copy.keepForm).toBe(false);
  });

  it("maps expiry to a request-a-new-link sentence", () => {
    const copy = claimFailureCopy(new ApiError(410, "claim token has expired"));
    expect(copy.message).toContain("만료");
    expect(copy.suggestSignIn).toBe(false);
  });

  it("maps reuse to a sign-in suggestion", () => {
    const copy = claimFailureCopy(
      new ApiError(409, "claim token has already been used")
    );
    expect(copy.suggestSignIn).toBe(true);
    expect(copy.keepForm).toBe(false);
    expect(copy.message).toContain("이미 사용");
  });

  it("passes a transport failure through", () => {
    const copy = claimFailureCopy(new NetworkError("unreachable", 15_000));
    expect(copy.retryable).toBe(true);
    expect(copy.keepForm).toBe(true);
    expect(copy.message.length).toBeGreaterThan(0);
  });

  it("maps 429 to wait-copy without a now retry", () => {
    const copy = claimFailureCopy(new ApiError(429, "rate limit exceeded"));
    expect(copy.retryable).toBe(false);
    expect(copy.keepForm).toBe(true);
    expect(copy.message).toContain("잠시");
  });
});

import { describe, expect, it } from "vitest";
import { ApiError, ClaimApiError } from "../../lib/api";
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

  // ADR-0215 D2 (#4593): the 400 names which rule the new password broke.
  it("tells a too-short password its minimum, keeping the form", () => {
    const copy = claimFailureCopy(
      new ApiError(
        400,
        "password must be at least 10 characters",
        "password_too_short"
      )
    );
    expect(copy.message).toContain("10자 이상");
    expect(copy.message).not.toContain("72");
    expect(copy.keepForm).toBe(true);
    expect(copy.retryable).toBe(false);
    expect(copy.suggestSignIn).toBe(false);
  });

  it("tells a too-long password its ceiling in bytes, and the rate to count it by", () => {
    const copy = claimFailureCopy(
      new ApiError(
        400,
        "password must be at most 72 bytes in UTF-8",
        "password_too_long"
      )
    );
    expect(copy.message).toContain("72바이트");
    expect(copy.message).toContain("한글은 한 자에 3바이트");
    expect(copy.message).toContain("한글만이면 24자");
    expect(copy.message).not.toContain("10자 이상");
    expect(copy.keepForm).toBe(true);
    expect(copy.retryable).toBe(false);
  });

  it("keeps the generic line for a 400 that names no password rule", () => {
    const generic = "비어 있거나 너무 깁니다";
    // No code (an empty password, or any 400 older than the named rules).
    expect(claimFailureCopy(new ApiError(400, "password is required")).message).toContain(
      generic
    );
    // A code this screen does not know must not borrow another rule's sentence, nor name a dictionary one.
    const unknown = claimFailureCopy(new ApiError(400, "a rule from the future", "password_future_rule"));
    expect(unknown.message).toContain(generic);
    expect(unknown.messageKey).toBeUndefined();
    // A rule code on a different status is not a password refusal.
    expect(
      claimFailureCopy(new ApiError(429, "rate limit exceeded", "password_too_short")).message
    ).toContain("잠시");
  });

  it("maps 429 to wait-copy without a now retry", () => {
    const copy = claimFailureCopy(new ApiError(429, "rate limit exceeded"));
    expect(copy.retryable).toBe(false);
    expect(copy.keepForm).toBe(true);
    expect(copy.message).toContain("잠시");
  });
});

// ADR-0215 D6 (#4601): a 409 or 410 that names the kind says who to ask for a new link.
describe("claimFailureCopy by claimKind", () => {
  const refused = (status: number, kind: "owner_bootstrap" | "password_reset") =>
    new ClaimApiError(new ApiError(status, "refused"), kind);

  it("sends an expired reset link to an admin, in the dictionary", () => {
    const copy = claimFailureCopy(refused(410, "password_reset"));
    expect(copy.messageKey).toBe("recovery.claim.resetExpired");
    expect(copy.keepForm).toBe(false);
    expect(copy.retryable).toBe(false);
    expect(copy.suggestSignIn).toBe(false);
  });

  it("tells a used or replaced reset link to sign in or ask for a new one, in the dictionary", () => {
    const copy = claimFailureCopy(refused(409, "password_reset"));
    expect(copy.messageKey).toBe("recovery.claim.resetUsed");
    expect(copy.suggestSignIn).toBe(true);
    expect(copy.keepForm).toBe(false);
  });

  it("keeps the first-owner sentences for a first-owner link", () => {
    const expired = claimFailureCopy(refused(410, "owner_bootstrap"));
    expect(expired.messageKey).toBeUndefined();
    expect(expired.message).toContain("설치를 실행한 쪽에 새 링크를 요청하세요");
    const used = claimFailureCopy(refused(409, "owner_bootstrap"));
    expect(used.messageKey).toBeUndefined();
    expect(used.message).toBe("이 링크는 이미 사용되었습니다. 로그인하세요.");
  });

  it("keeps the first-owner sentences when no kind was named (an older server)", () => {
    const expired = claimFailureCopy(new ApiError(410, "claim token has expired"));
    expect(expired.messageKey).toBeUndefined();
    expect(expired.message).toContain("설치를 실행한 쪽에 새 링크를 요청하세요");
    expect(claimFailureCopy(new ApiError(409, "used")).messageKey).toBeUndefined();
  });

  it("names a dictionary sentence for a password with a NUL character, and only for that code", () => {
    const copy = claimFailureCopy(new ApiError(400, "NUL", "password_invalid_char"));
    expect(copy.messageKey).toBe("recovery.claim.invalidChar");
    expect(copy.keepForm).toBe(true);
    // A 404 never names a kind, so it never asks anyone for a reset link.
    expect(claimFailureCopy(new ApiError(404, "invalid")).messageKey).toBeUndefined();
  });
});


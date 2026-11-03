import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { createMessageService } from "../../i18n/service";
import ko from "../../i18n/catalogs/ko-KR/recovery.json";
import {
  CURRENT_PASSWORD_INCORRECT_CODE,
  CURRENT_PASSWORD_REQUIRED_CODE,
  passwordResetIssueFailure,
  passwordResetIssueMessage,
  passwordResetIssueRequired,
} from "./passwordResetIssue";

// ADR-0215 D6 (#4603): the two password refusals are told apart by `error.code`, never by status alone.

describe("passwordResetIssueFailure", () => {
  it("says the wrong password at the password field, and empties it", () => {
    const failure = passwordResetIssueFailure(
      new ApiError(403, "current password is incorrect", CURRENT_PASSWORD_INCORRECT_CODE)
    );
    expect(failure).toEqual({
      key: "recovery.issue.errorWrongPassword",
      atPasswordField: true,
      clearPassword: true,
    });
  });

  it("says a missing password at the password field, and keeps what was typed", () => {
    const failure = passwordResetIssueFailure(
      new ApiError(400, "currentPassword is required", CURRENT_PASSWORD_REQUIRED_CODE)
    );
    expect(failure).toEqual(passwordResetIssueRequired());
    expect(failure.atPasswordField).toBe(true);
    expect(failure.clearPassword).toBe(false);
  });

  it("does not call a 403 without the password code a wrong password: it is the ladder", () => {
    const failure = passwordResetIssueFailure(new ApiError(403, "forbidden"));
    expect(failure.key).toBe("recovery.issue.errorForbidden");
    expect(failure.atPasswordField).toBe(false);
    expect(failure.clearPassword).toBe(false);
    // A password code on the wrong status is not the re-check either.
    expect(
      passwordResetIssueFailure(new ApiError(409, "x", CURRENT_PASSWORD_INCORRECT_CODE)).key
    ).toBe("recovery.issue.errorInactive");
  });

  it.each([
    [400, undefined, "recovery.issue.errorBadTarget"],
    [404, undefined, "recovery.issue.errorNotFound"],
    [409, undefined, "recovery.issue.errorInactive"],
    [429, undefined, "recovery.issue.errorRateLimited"],
    [500, undefined, "recovery.issue.errorGeneric"],
    [503, undefined, "recovery.issue.errorGeneric"],
  ] as const)("maps status %s to %s", (status, code, key) => {
    expect(passwordResetIssueFailure(new ApiError(status, "x", code)).key).toBe(key);
  });

  it("uses Retry-After seconds on a 429 when the server said them", () => {
    const failure = passwordResetIssueFailure(new ApiError(429, "slow down", undefined, 42));
    expect(failure.key).toBe("recovery.issue.errorRateLimitedAfter");
    expect(failure.seconds).toBe(42);
    // Zero or fractional seconds say nothing useful: the plain sentence stands.
    expect(passwordResetIssueFailure(new ApiError(429, "x", undefined, 0)).key).toBe(
      "recovery.issue.errorRateLimited"
    );
  });

  it("names the network and anything it cannot read", () => {
    expect(passwordResetIssueFailure(new NetworkError("unreachable", 15_000)).key).toBe(
      "recovery.issue.errorNetwork"
    );
    expect(passwordResetIssueFailure(new Error("boom")).key).toBe("recovery.issue.errorGeneric");
    expect(passwordResetIssueFailure("nope").key).toBe("recovery.issue.errorGeneric");
  });
});

describe("passwordResetIssueMessage", () => {
  const messages = createMessageService({ messageLocale: "en-US" });

  it("reads the dictionary, with the seconds in the sentence when there are any", () => {
    expect(
      passwordResetIssueMessage(passwordResetIssueFailure(new ApiError(429, "x", undefined, 7)), messages.formatMessage)
    ).toBe("Too many requests. Try again in 7 seconds.");
    expect(
      passwordResetIssueMessage(
        passwordResetIssueFailure(new ApiError(403, "x", CURRENT_PASSWORD_INCORRECT_CODE)),
        messages.formatMessage
      )
    ).toBe("That password is not correct. Try again.");
  });

  it("interpolates nothing but the seconds into a refusal sentence (no member, no password, no server text)", () => {
    // A refusal sentence is dictionary text only: an argument other than `seconds` would be a value the
    // sentence was never given (the member's name, the typed password, the server's English).
    const sentences = Object.entries(ko).filter(([key]) => key.startsWith("recovery.issue.error"));
    expect(sentences.length).toBeGreaterThanOrEqual(10);
    for (const [key, text] of sentences) {
      const arguments_ = [...text.matchAll(/\{(\w+)/g)].map((m) => m[1]);
      expect(arguments_.every((name) => name === "seconds"), key).toBe(true);
    }
  });
});

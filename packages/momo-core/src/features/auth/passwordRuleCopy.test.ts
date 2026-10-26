import { describe, expect, it } from "vitest";
import {
  NEW_PASSWORD_MAX_BYTES,
  NEW_PASSWORD_MAX_HANGUL,
  NEW_PASSWORD_MIN_CHARS,
  passwordRuleCopy,
} from "./passwordRuleCopy";

// ADR-0215 D2 (#4593). The sentences and the numbers they print are pinned as
// literals on purpose: a number or a sentence changed in this module goes red.
// Whether they still match the server is not decided here (core cannot read the
// server's file); `clients/web/src/features/auth/passwordRuleDrift.test.ts`
// reads `password_rules.rs` and compares.
describe("passwordRuleCopy", () => {
  it("says the minimum for a too-short password", () => {
    expect(passwordRuleCopy("password_too_short")).toBe(
      "비밀번호가 너무 짧습니다. 10자 이상으로 입력하세요."
    );
  });

  it("says the byte ceiling and the exchange rate for a too-long password", () => {
    expect(passwordRuleCopy("password_too_long")).toBe(
      "비밀번호가 너무 깁니다. 72바이트 이하로 입력하세요. 한글은 한 자에 3바이트입니다(한글만이면 24자)."
    );
  });

  it("gives a mix of scripts a rate to compute with, not two independent limits", () => {
    // Twenty Hangul and thirteen digits are inside "24 Hangul" and inside "72
    // Latin" taken one at a time, and still 73 bytes. The sentence has to let a
    // person work that out: one byte budget, and what a Hangul syllable costs
    // against it. The old per-script pair read as two limits.
    const sentence = passwordRuleCopy("password_too_long") ?? "";
    expect(sentence).toContain("72바이트 이하");
    expect(sentence).toContain("한글은 한 자에 3바이트");
    expect(sentence).not.toContain("영문은 72자");
    expect(sentence).not.toContain("한글은 24자");
  });

  it("names no rule for a code it does not know, or for none", () => {
    expect(passwordRuleCopy(undefined)).toBeNull();
    expect(passwordRuleCopy("")).toBeNull();
    // The server refuses a NUL with its own code. A keyboard cannot type one, so
    // no screen words it, and it must not borrow another rule's sentence.
    expect(passwordRuleCopy("password_invalid_char")).toBeNull();
    expect(passwordRuleCopy("invalid_request")).toBeNull();
  });

  it("pins the numbers its sentences print, and the Hangul figure whole", () => {
    expect(NEW_PASSWORD_MIN_CHARS).toBe(10);
    expect(NEW_PASSWORD_MAX_BYTES).toBe(72);
    // The sentence prints this number; a ceiling that is not a multiple of three
    // would print a fraction.
    expect(NEW_PASSWORD_MAX_HANGUL).toBe(24);
    expect(Number.isInteger(NEW_PASSWORD_MAX_HANGUL)).toBe(true);
  });
});

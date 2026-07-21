import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  classifyJoinError,
  inviteCodeFromUrl,
  validateJoinForm,
} from "./model";

const validForm = {
  email: "new@example.com",
  displayName: "새 멤버",
  handle: "new_member",
  password: "correct horse battery staple",
};

describe("invite code parsing", () => {
  it("reads /join?code without exposing another query value", () => {
    expect(
      inviteCodeFromUrl(new URL("https://chat.example/join?next=home&code=AbC_123"))
    ).toBe("AbC_123");
  });

  it("reads an /i path that reached the SPA fallback", () => {
    expect(inviteCodeFromUrl(new URL("https://chat.example/i/a%2Eb-1"))).toBe("a.b-1");
  });

  it("keeps the deployed /join/<code> link shape compatible", () => {
    expect(inviteCodeFromUrl(new URL("https://chat.example/join/legacy-code"))).toBe(
      "legacy-code"
    );
  });
});

describe("join form validation", () => {
  it("accepts the canonical form shape", () => {
    expect(validateJoinForm(validForm)).toBeNull();
  });

  it("rejects an invalid handle", () => {
    expect(validateJoinForm({ ...validForm, handle: "Bad Handle" })).toContain("핸들");
  });

  it("rejects an empty display name", () => {
    expect(validateJoinForm({ ...validForm, displayName: "   " })).toContain("표시 이름");
  });
});

describe("join terminal errors", () => {
  it("classifies an expired invite", () => {
    expect(classifyJoinError(new ApiError(410, "invite code is expired"))).toMatchObject({
      kind: "expired",
      terminal: true,
    });
  });

  it("classifies an exhausted invite", () => {
    expect(classifyJoinError(new ApiError(409, "invite code is exhausted"))).toMatchObject({
      kind: "exhausted",
      terminal: true,
    });
  });

  it("distinguishes a banned account from other forbidden joins", () => {
    const error = classifyJoinError(
      new ApiError(403, "member is banned from this workspace")
    );
    expect(error.kind).toBe("banned");
    expect(error.copy).toContain("차단된 계정");
    expect(error.terminal).toBe(true);
  });
});

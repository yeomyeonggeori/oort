import { describe, expect, it } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import {
  memberAvatarPickError,
  memberAvatarUploadError,
} from "./memberAvatarCopy";

describe("memberAvatarPickError", () => {
  const MIB = 1024 * 1024;
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])("%s 는 통과", (type) => {
    expect(memberAvatarPickError({ type, size: 10 })).toBeNull();
  });
  it("SVG·PDF·빈 type 은 거른다", () => {
    for (const type of ["image/svg+xml", "application/pdf", ""]) {
      expect(memberAvatarPickError({ type, size: 10 })).toMatch(/PNG, JPG, GIF, WebP/);
    }
  });
  it("5MiB 정확히는 통과, 1바이트 넘으면 거절, 0바이트도 거절", () => {
    expect(memberAvatarPickError({ type: "image/png", size: 5 * MIB })).toBeNull();
    expect(memberAvatarPickError({ type: "image/png", size: 5 * MIB + 1 })).toBe(
      "사진은 5MB까지 올릴 수 있어요."
    );
    expect(memberAvatarPickError({ type: "image/png", size: 0 })).toMatch(/비어 있는/);
  });
});

describe("memberAvatarUploadError", () => {
  it("서버 코드마다 다른 해요체 문구", () => {
    const messages = [413, 422, 409, 429, 500].map((status) =>
      memberAvatarUploadError(new ApiError(status, "x"))
    );
    expect(new Set(messages).size).toBe(5);
    expect(messages[0]).toMatch(/너무 커요/);
    expect(messages[1]).toMatch(/4096px/);
    expect(messages[2]).toMatch(/다시 골라/);
    expect(messages[3]).toMatch(/너무 자주/);
    for (const m of messages) expect(m).toMatch(/요[.]?$|요\.$/);
  });
  it("ApiError 가 아니면 일반 문구", () => {
    expect(memberAvatarUploadError(new Error("boom"))).toMatch(/올리지 못했어요/);
  });
});

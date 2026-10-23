import { describe, expect, it } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { AVATAR_EDITOR_COPY } from "@momo/core/features/workspace/avatarEditor";
import {
  MEMBER_AVATAR_MAX_SIDE,
  memberAvatarPickError,
  memberAvatarRemoveError,
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
      "프로필 사진은 5MB까지 올릴 수 있어요."
    );
    expect(memberAvatarPickError({ type: "image/png", size: 0 })).toMatch(/비어 있는/);
  });
});

describe("memberAvatarUploadError", () => {
  it("서버 코드마다 다른 합니다체 문구", () => {
    const messages = [413, 422, 409, 429, 500].map((status) =>
      memberAvatarUploadError(new ApiError(status, "x"))
    );
    expect(new Set(messages).size).toBe(5);
    expect(messages[0]).toMatch(/5MB까지/);
    expect(messages[1]).toMatch(/4096px/);
    expect(messages[2]).toMatch(/다시 골라/);
    expect(messages[3]).toMatch(/너무 자주/);
    for (const m of messages) expect(m).toMatch(/(어요|주세요)\.$/);
  });
  it("ApiError 가 아니면 일반 문구", () => {
    expect(memberAvatarUploadError(new Error("boom"))).toMatch(/올리지 못했어요/);
  });
});

describe("memberAvatarUploadError: 그려 올린 PNG (이모지·코메토)", () => {
  it("한도·형식 문장(프로필 사진·5MB·4096px)을 쓰지 않고 일반 문장으로 읽는다", () => {
    for (const status of [413, 422, 409, 500]) {
      const message = memberAvatarUploadError(new ApiError(status, "x"), "drawn");
      expect(message, String(status)).toBe(AVATAR_EDITOR_COPY.uploadFailed);
      expect(message, String(status)).not.toMatch(/프로필 사진|5MB|4096px/);
    }
    expect(memberAvatarUploadError(new Error("boom"), "drawn")).toBe(AVATAR_EDITOR_COPY.uploadFailed);
  });
  it("너무 잦은 변경(429)만 따로 말한다", () => {
    expect(memberAvatarUploadError(new ApiError(429, "x"), "drawn")).toBe(AVATAR_EDITOR_COPY.uploadTooOften);
    expect(AVATAR_EDITOR_COPY.uploadTooOften).not.toBe(AVATAR_EDITOR_COPY.uploadFailed);
  });
  it("종류를 안 주면 사진이다 (기존 호출부가 그대로 사진 문장을 받는다)", () => {
    expect(memberAvatarUploadError(new ApiError(413, "x"))).toMatch(/5MB까지/);
    expect(memberAvatarUploadError(new ApiError(413, "x"), "photo")).toMatch(/5MB까지/);
  });
  it("사진의 422 는 편집기와 같은 문장이고, 상한은 서버의 4096px 이다", () => {
    expect(memberAvatarUploadError(new ApiError(422, "x"), "photo")).toBe(AVATAR_EDITOR_COPY.photoUnusable);
    expect(AVATAR_EDITOR_COPY.photoUnusable).toContain(String(MEMBER_AVATAR_MAX_SIDE));
  });
});

describe("memberAvatarRemoveError", () => {
  it("편집기와 같은 되돌리기 실패 문장을 말한다", () => {
    expect(memberAvatarRemoveError()).toBe(AVATAR_EDITOR_COPY.resetFailed);
  });
});

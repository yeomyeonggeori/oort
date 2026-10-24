import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { uploadMyAvatarWith } from "./memberAvatarUpload";
import {
  MEMBER_AVATAR_TOO_LARGE,
  memberAvatarRemoveError,
  memberAvatarUploadError,
} from "./memberAvatarCopy";

const calls: string[] = [];
const create = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    createMyAvatarUpload: (...a: unknown[]) => create(...a),
    completeMyAvatarUpload: (...a: unknown[]) => complete(...a),
  };
});

const META = { name: "avatar.jpg", mime: "image/jpeg", size: 1234 };

beforeEach(() => {
  calls.length = 0;
  create.mockReset().mockImplementation(async () => {
    calls.push("create");
    return { id: "m1", status: "pending", uploadUrl: "https://drive.example/cap" };
  });
  complete.mockReset().mockImplementation(async () => {
    calls.push("complete");
    return { id: "m1", memberId: "u", status: "ready", avatarUrl: "/v1/workspaces/w/members/u/avatar/content?v=m1" };
  });
});

describe("uploadMyAvatarWith", () => {
  it("세션 열기 → put(uploadUrl) → complete 순서, 선언한 이름·mime·size 그대로", async () => {
    const put = vi.fn(async (url: string) => (calls.push(`put:${url}`), { ok: true }));
    const media = await uploadMyAvatarWith("w", META, put);
    expect(calls).toEqual(["create", "put:https://drive.example/cap", "complete"]);
    expect(create).toHaveBeenCalledWith("w", META);
    expect(complete).toHaveBeenCalledWith("w", "m1");
    expect(media.avatarUrl).toContain("?v=m1");
  });

  it("put 이 실패하면 complete 를 부르지 않고 status 0 ApiError", async () => {
    const error = await uploadMyAvatarWith("w", META, async () => ({ ok: false })).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it("세션 열기가 실패하면 put 도 complete 도 부르지 않는다", async () => {
    create.mockRejectedValueOnce(new ApiError(413, "too big"));
    const put = vi.fn(async () => ({ ok: true }));
    await expect(uploadMyAvatarWith("w", META, put)).rejects.toMatchObject({ status: 413 });
    expect(put).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("memberAvatarUploadError", () => {
  it.each([
    [413, MEMBER_AVATAR_TOO_LARGE],
    [422, "이 이미지는 사용할 수 없어요. 열 수 있는 이미지이고 가로세로 4096px 이하인지 확인해 주세요."],
    [409, "파일 형식이 맞지 않거나 그사이 다른 사진으로 바뀌었어요. 이미지를 다시 골라 주세요."],
    [429, "프로필 사진을 너무 자주 바꿨어요. 잠시 뒤에 다시 시도해 주세요."],
  ])("서버 %i 는 자기 문장을 말한다", (status, text) => {
    expect(memberAvatarUploadError(new ApiError(status, "x"))).toBe(text);
  });

  it("그 밖의 오류·status 0(Drive 실패)은 일반 문구, 서로 다른 넷과도 다르다", () => {
    const generic = memberAvatarUploadError(new ApiError(0, "x"));
    expect(memberAvatarUploadError(new Error("boom"))).toBe(generic);
    expect(memberAvatarUploadError(new ApiError(500, "x"))).toBe(generic);
    for (const status of [413, 422, 409, 429]) {
      expect(memberAvatarUploadError(new ApiError(status, "x"))).not.toBe(generic);
    }
    expect(memberAvatarRemoveError()).not.toBe(generic);
  });
});

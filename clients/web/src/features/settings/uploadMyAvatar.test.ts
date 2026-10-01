import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { uploadMyAvatar } from "./uploadMyAvatar";

const calls: string[] = [];
const create = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    createMyAvatarUpload: (...a: unknown[]) => create(...a),
    completeMyAvatarUpload: (...a: unknown[]) => complete(...a),
  };
});
vi.mock("@/features/attachments/uploadTransport", () => ({
  putAttachmentBytes: (...a: unknown[]) => put(...a),
}));

const file = new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" });

beforeEach(() => {
  calls.length = 0;
  create.mockReset().mockImplementation(async () => {
    calls.push("create");
    return { id: "m1", status: "pending", uploadUrl: "https://drive.example/secret" };
  });
  complete.mockReset().mockImplementation(async () => {
    calls.push("complete");
    return { id: "m1", memberId: "u", status: "ready", avatarUrl: "/v1/workspaces/w/members/u/avatar/content?v=m1" };
  });
  put.mockReset().mockImplementation(() => ({
    done: Promise.resolve({ ok: true }).then((r) => (calls.push("put"), r)),
    abort: () => undefined,
  }));
});

describe("uploadMyAvatar", () => {
  it("세션 열기 → Drive PUT → complete 순서, 선언한 mime·size 그대로", async () => {
    const media = await uploadMyAvatar("w", file, () => undefined);
    expect(calls).toEqual(["create", "put", "complete"]);
    expect(create).toHaveBeenCalledWith("w", { name: "me.png", mime: "image/png", size: 3 });
    expect(put.mock.calls[0]?.[3]).toBeTypeOf("function");
    expect(media.avatarUrl).toContain("?v=m1");
  });

  it("Drive PUT 이 실패하면 complete 를 부르지 않고 status 0 ApiError", async () => {
    put.mockImplementation(() => ({
      done: Promise.resolve({ ok: false, failure: "status", status: 413 }),
      abort: () => undefined,
    }));
    const failure = await uploadMyAvatar("w", file, () => undefined).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(String((failure as Error).message)).not.toContain("secret");
  });
});

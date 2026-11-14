import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "@momo/core/runtime/host";

// #5816 — 올리기에 이어지는 요청(완료 · 다음 건)은 그 올리기를 시작한 세션으로만 간다. 세션이 바뀌었으면 보내지 않고 그 초안은
// 실패로 끝난다.

const createAttachmentUpload = vi.fn();
const completeAttachmentUpload = vi.fn();
const putAttachmentBytes = vi.fn();

vi.mock("@momo/core/lib/api", () => ({
  ApiError: class extends Error {},
  createAttachmentUpload: (...args: unknown[]) => createAttachmentUpload(...args),
  completeAttachmentUpload: (...args: unknown[]) => completeAttachmentUpload(...args),
}));

vi.mock("./uploadTransport", () => ({
  putAttachmentBytes: (...args: unknown[]) => putAttachmentBytes(...args),
}));

const { addFiles, readSurface, resetAttachmentDraftsForTest, surfaceKey } = await import("./draftStore");

const KEY = surfaceKey("ws", "ch");
const TARGET = { workspaceId: "ws", channelId: "ch" };
const file = (name: string) => ({ name, size: 8, type: "text/plain" }) as unknown as File;
const settle = () => new Promise<void>((done) => setTimeout(done, 0));

let member: { id: string; workspaceId: string } | null;

beforeEach(() => {
  member = { id: "m-dohyeon", workspaceId: "ws" };
  const port: SessionPort = {
    getAccessToken: () => (member ? "at" : null),
    getRefreshToken: () => (member ? "rt" : null),
    getPersistedSession: () => (member ? ({ refreshToken: "rt", realtimeWebSocketUrl: "", member } as never) : null),
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
  };
  installCoreHost({ apiBase: () => "http://oort.test", absoluteApiBase: () => "http://oort.test", buildMode: () => "test", session: port });
  resetAttachmentDraftsForTest();
  createAttachmentUpload.mockReset();
  completeAttachmentUpload.mockReset();
  putAttachmentBytes.mockReset();
  createAttachmentUpload.mockResolvedValue({ id: "up-1", status: "pending", uploadUrl: "https://archive.invalid/up-1" });
  completeAttachmentUpload.mockResolvedValue({
    id: "att-1",
    channelId: "ch",
    uploaderMemberId: "m-dohyeon",
    name: "a.txt",
    mime: "text/plain",
    size: 8,
    status: "complete",
    createdAtMs: 0,
  });
});

afterEach(() => {
  resetCoreHost();
});

describe("올리기에 이어지는 요청", () => {
  it("시작한 세션이 끝났으면 완료도 다음 건도 보내지 않고, 남은 건을 다음 세션으로 올리지 않는다", async () => {
    let finish!: () => void;
    putAttachmentBytes.mockImplementationOnce(() => ({
      done: new Promise((resolve) => {
        finish = () => resolve({ ok: true });
      }),
      abort: () => {},
    }));
    addFiles(KEY, TARGET, [file("a.txt"), file("b.txt")]);
    await vi.waitFor(() => expect(putAttachmentBytes).toHaveBeenCalledTimes(1));
    member = { id: "m-seoyeon", workspaceId: "ws" };
    finish();
    await settle();
    await settle();
    expect(completeAttachmentUpload).not.toHaveBeenCalled();
    expect(createAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(readSurface(KEY).drafts.map((d) => d.status)).toEqual(["failed", "failed"]);
    // 다음 세션이 같은 칸에 파일을 더하면 그 파일만 올라간다.
    putAttachmentBytes.mockImplementation(() => ({ done: Promise.resolve({ ok: true }), abort: () => {} }));
    addFiles(KEY, TARGET, [file("c.txt")]);
    await vi.waitFor(() => expect(completeAttachmentUpload).toHaveBeenCalledTimes(1));
    expect(createAttachmentUpload.mock.calls.map((call) => (call[2] as { name: string }).name)).toEqual(["a.txt", "c.txt"]);
  });

  it("시작한 세션이 끝났으면 완료 답이 와도 끝남으로 두지 않는다", async () => {
    let confirm!: () => void;
    completeAttachmentUpload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = () =>
            resolve({ id: "att-1", channelId: "ch", uploaderMemberId: "m-dohyeon", name: "a.txt", mime: "text/plain", size: 8, status: "complete", createdAtMs: 0 });
        })
    );
    putAttachmentBytes.mockImplementation(() => ({ done: Promise.resolve({ ok: true }), abort: () => {} }));
    addFiles(KEY, TARGET, [file("a.txt")]);
    await vi.waitFor(() => expect(completeAttachmentUpload).toHaveBeenCalledTimes(1));
    member = null;
    confirm();
    await settle();
    expect(readSurface(KEY).drafts.map((d) => d.status)).toEqual(["failed"]);
  });

  it("세션이 그대로면 예전처럼 끝까지 올린다", async () => {
    putAttachmentBytes.mockImplementation(() => ({ done: Promise.resolve({ ok: true }), abort: () => {} }));
    addFiles(KEY, TARGET, [file("a.txt"), file("b.txt")]);
    await vi.waitFor(() => expect(completeAttachmentUpload).toHaveBeenCalledTimes(2));
    await settle();
    expect(readSurface(KEY).drafts.map((d) => d.status)).toEqual(["uploaded", "uploaded"]);
  });
});

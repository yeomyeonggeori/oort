import { beforeEach, describe, expect, it, vi } from "vitest";

// 세 왕복의 순서를 재는 테스트 (#1202 첨부 축).
//
// 이 파일이 대는 것은 「업로드가 되는가」가 아니라 **화면이 언제 무엇을 말하는가**
// 다. 특히 하나: 바이트를 다 건넨 순간과 서버가 완료를 확인한 순간 사이에 칩이
// 「업로드 완료」라고 말하면 안 된다. `xhr.upload.onprogress` 는 소켓에 건넨
// 바이트를 세지 상대가 받은 것을 세지 않으므로, 그 사이가 정확히 진행률이
// 거짓말하는 구간이다.

const createAttachmentUpload = vi.fn();
const completeAttachmentUpload = vi.fn();
const putAttachmentBytes = vi.fn();

class FakeApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

vi.mock("@momo/core/lib/api", () => ({
  ApiError: FakeApiError,
  createAttachmentUpload: (...args: unknown[]) => createAttachmentUpload(...args),
  completeAttachmentUpload: (...args: unknown[]) =>
    completeAttachmentUpload(...args),
}));

vi.mock("./uploadTransport", () => ({
  putAttachmentBytes: (...args: unknown[]) => putAttachmentBytes(...args),
}));

const {
  addFiles,
  clearSurface,
  dropDraft,
  readSurface,
  resetAttachmentDraftsForTest,
  retryDraft,
  surfaceKey,
  takeSent,
} = await import("./draftStore");

const KEY = surfaceKey("ws", "ch");
const TARGET = { workspaceId: "ws", channelId: "ch" };

/**
 * 파일 한 건. `size` 를 손으로 정하기 위해 실제 `File` 을 만들지 않는다 — 상한을
 * 넘는 경우를 대려면 100 MB 를 실제로 할당해야 하고, 저장소가 이 값에서 읽는 것은
 * 이름·타입·크기 셋뿐이다(바이트는 전송 계층으로 그대로 넘어가고 그쪽은 mock 이다).
 */
function file(name: string, size: number, type = "text/plain"): File {
  return { name, size, type } as unknown as File;
}

/** 다음 마이크로태스크 큐가 다 비워질 때까지. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0));
}

/** 손으로 여닫는 업로드 한 건. 진행률과 종료 시점을 테스트가 쥔다. */
function manualUpload() {
  let resolve!: (value: { ok: boolean; failure?: string; status?: number }) => void;
  const done = new Promise<{ ok: boolean; failure?: string; status?: number }>(
    (r) => {
      resolve = r;
    }
  );
  const abort = vi.fn(() => resolve({ ok: false, failure: "aborted" }));
  let report: ((fraction: number) => void) | null = null;
  putAttachmentBytes.mockImplementationOnce(
    (_url: string, _blob: Blob, _mime: string, onProgress: (f: number) => void) => {
      report = onProgress;
      return { done, abort };
    }
  );
  return {
    progress: (fraction: number) => report?.(fraction),
    finish: () => resolve({ ok: true }),
    fail: (failure: string, status?: number) =>
      resolve({ ok: false, failure, ...(status === undefined ? {} : { status }) }),
    abort,
  };
}

beforeEach(() => {
  resetAttachmentDraftsForTest();
  createAttachmentUpload.mockReset();
  completeAttachmentUpload.mockReset();
  putAttachmentBytes.mockReset();
  // 손으로 여닫지 않은 업로드는 곧바로 성공한다. `manualUpload()` 가 등록하는
  // `mockImplementationOnce` 가 이 기본값보다 먼저 소비된다.
  putAttachmentBytes.mockImplementation(() => ({
    done: Promise.resolve({ ok: true }),
    abort: () => {},
  }));
  createAttachmentUpload.mockResolvedValue({
    id: "att-1",
    status: "pending",
    uploadUrl: "https://archive.invalid/session",
  });
  completeAttachmentUpload.mockResolvedValue({
    id: "att-1",
    channelId: "ch",
    uploaderMemberId: "m",
    name: "drain.log",
    mime: "text/plain",
    size: 8,
    status: "complete",
    createdAtMs: 0,
  });
});

describe("upload orchestration", () => {
  it("never says uploaded while the server is still verifying", async () => {
    const upload = manualUpload();
    // 완료 왕복도 손으로 연다. 그 왕복이 열려 있는 동안이 정확히 진행률이
    // 거짓말할 수 있는 구간이고, 이 테스트가 재는 것이 그 구간이다.
    let confirm!: () => void;
    completeAttachmentUpload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = () =>
            resolve({
              id: "att-1",
              channelId: "ch",
              uploaderMemberId: "m",
              name: "drain.log",
              mime: "text/plain",
              size: 8,
              status: "complete",
              createdAtMs: 0,
            });
        })
    );
    addFiles(KEY, TARGET, [file("drain.log", 8)]);
    await settle();

    expect(readSurface(KEY).drafts[0].status).toBe("uploading");
    upload.progress(0.5);
    expect(readSurface(KEY).drafts[0].progress).toBeCloseTo(0.5);

    // 바이트는 다 갔다. 여기서 「업로드 완료」가 뜨면 그것이 거짓말이다.
    upload.finish();
    await settle();
    expect(readSurface(KEY).drafts[0].status).toBe("verifying");
    expect(readSurface(KEY).drafts[0].attachmentId).toBeUndefined();

    confirm();
    await settle();
    expect(readSurface(KEY).drafts[0].status).toBe("uploaded");
    expect(readSurface(KEY).drafts[0].attachmentId).toBe("att-1");
  });

  it("uploads one at a time, in the order the files were picked", async () => {
    const first = manualUpload();
    const second = manualUpload();
    addFiles(KEY, TARGET, [file("a.log", 8), file("b.log", 8)]);
    await settle();

    expect(readSurface(KEY).drafts.map((d) => d.status)).toEqual([
      "uploading",
      "ready",
    ]);
    expect(putAttachmentBytes).toHaveBeenCalledTimes(1);

    first.finish();
    await settle();
    await settle();
    expect(readSurface(KEY).drafts.map((d) => d.status)).toEqual([
      "uploaded",
      "uploading",
    ]);
    second.finish();
    await settle();
    await settle();
    expect(readSurface(KEY).drafts.map((d) => d.status)).toEqual([
      "uploaded",
      "uploaded",
    ]);
  });

  it("names a CSP refusal as a deployment problem, not a network one", async () => {
    const upload = manualUpload();
    addFiles(KEY, TARGET, [file("a.log", 8)]);
    await settle();
    upload.fail("blocked");
    await settle();
    expect(readSurface(KEY).drafts[0].status).toBe("failed");
    expect(readSurface(KEY).drafts[0].issue).toBe("blocked");
  });

  it("turns the session refusal's status into the reason", async () => {
    createAttachmentUpload.mockRejectedValueOnce(new FakeApiError(503));
    addFiles(KEY, TARGET, [file("a.log", 8)]);
    await settle();
    expect(readSurface(KEY).drafts[0].issue).toBe("no-archive");
    // 세션이 안 열렸으면 바이트는 한 번도 움직이지 않는다.
    expect(putAttachmentBytes).not.toHaveBeenCalled();
  });

  it("turns a verification mismatch into a retryable failure", async () => {
    const upload = manualUpload();
    completeAttachmentUpload.mockRejectedValueOnce(new FakeApiError(409));
    addFiles(KEY, TARGET, [file("a.log", 8)]);
    await settle();
    upload.finish();
    await settle();
    await settle();
    expect(readSurface(KEY).drafts[0].status).toBe("failed");
    expect(readSurface(KEY).drafts[0].issue).toBe("mismatch");
  });

  it("retries a failed upload from the top and lands it", async () => {
    const failing = manualUpload();
    addFiles(KEY, TARGET, [file("a.log", 8)]);
    await settle();
    failing.fail("network");
    await settle();
    expect(readSurface(KEY).drafts[0].status).toBe("failed");

    const retried = manualUpload();
    retryDraft(KEY, TARGET, readSurface(KEY).drafts[0].localId);
    await settle();
    expect(readSurface(KEY).drafts[0].status).toBe("uploading");
    retried.finish();
    await settle();
    await settle();
    expect(readSurface(KEY).drafts[0].status).toBe("uploaded");
  });

  it("aborts the byte transfer when the chip is removed", async () => {
    const upload = manualUpload();
    addFiles(KEY, TARGET, [file("a.log", 8)]);
    await settle();
    dropDraft(KEY, readSurface(KEY).drafts[0].localId);
    expect(upload.abort).toHaveBeenCalled();
    expect(readSurface(KEY).drafts).toHaveLength(0);
  });

  it("refuses an oversize file without ever opening a session", async () => {
    addFiles(KEY, TARGET, [file("huge.bin", 100 * 1024 * 1024 + 1, "video/mp4")]);
    await settle();
    expect(readSurface(KEY).drafts[0].status).toBe("failed");
    expect(readSurface(KEY).drafts[0].issue).toBe("too-large");
    // 서버가 413 으로 답할 것을 알면서 100 MB 를 올려 보내지 않는다.
    expect(createAttachmentUpload).not.toHaveBeenCalled();
    expect(putAttachmentBytes).not.toHaveBeenCalled();
  });

  it("names an empty browser mime rather than sending one the server rejects", async () => {
    addFiles(KEY, TARGET, [file("noext", 8, "")]);
    await settle();
    expect(createAttachmentUpload).toHaveBeenCalledWith("ws", "ch", {
      name: "noext",
      mime: "application/octet-stream",
      size: 8,
    });
  });

  it("hands the ids to the send and empties the tray in one step", async () => {
    const upload = manualUpload();
    addFiles(KEY, TARGET, [file("a.log", 8)]);
    await settle();
    upload.finish();
    await settle();
    await settle();

    const sent = takeSent(KEY);
    expect(sent.attachmentIds).toEqual(["att-1"]);
    expect(sent.attachments[0]).toMatchObject({ id: "att-1", name: "a.log" });
    expect(readSurface(KEY).drafts).toHaveLength(0);
  });

  it("keeps a thread tray separate from its channel's tray", async () => {
    const threadKey = surfaceKey("ws", "ch", "root-1");
    expect(threadKey).not.toBe(KEY);
    manualUpload();
    addFiles(KEY, TARGET, [file("a.log", 8)]);
    await settle();
    expect(readSurface(threadKey).drafts).toHaveLength(0);
    expect(readSurface(KEY).drafts).toHaveLength(1);
  });

  it("clears everything a surface holds, aborting what was in flight", async () => {
    const upload = manualUpload();
    addFiles(KEY, TARGET, [file("a.log", 8)]);
    await settle();
    clearSurface(KEY);
    expect(upload.abort).toHaveBeenCalled();
    expect(readSurface(KEY).drafts).toHaveLength(0);
  });
});

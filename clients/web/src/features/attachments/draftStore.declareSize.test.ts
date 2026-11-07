import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 보내는 쪽의 가로세로 선언 (ADR-0151 증보 9 I7, #5469) — 세 왕복 뒤의 네 번째 걸음.
//
// 이 파일이 재는 것은 셋이다. ① **순서**: 완료 뒤, 칩이 「올림」으로 바뀌기 **전**(서버는 아직 메시지에 안 묶인 첨부에만 쓰므로 바뀐 뒤에
// 부르면 빠른 전송이 먼저 묶어 조용히 404 가 된다). ② **덤**: 무엇이 잘못돼도 칩은 올림이 되고 보내기는 요약 없이 간다. ③ **무엇을**:
// 닫힌 목록 안의 사진·GIF 만, `{kind: "image", width, height}` 로, 재지 못했으면 아무것도.
// 서버 쪽 규칙(업로더·미묶임·범위·종류·매직)은 server-rust 의 `attachment_media_conformance_pg` 가 증명한다.

const createAttachmentUpload = vi.fn();
const completeAttachmentUpload = vi.fn();
const setAttachmentMedia = vi.fn();
const putAttachmentBytes = vi.fn();
const measureImageFile = vi.fn();

/** `true` 면 선언 호출을 **꺼내는 것부터** 터진다(선언 함수가 던지는 일을 흉내: 코어의 `declareImageSize` 는 던지지 않는다). */
let declarationBlowsUp = false;

class FakeApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code?: string) {
    super(`HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

vi.mock("@momo/core/lib/api", () => ({
  ApiError: FakeApiError,
  createAttachmentUpload: (...args: unknown[]) => createAttachmentUpload(...args),
  completeAttachmentUpload: (...args: unknown[]) => completeAttachmentUpload(...args),
  get setAttachmentMedia() {
    if (declarationBlowsUp) throw new Error("the declaration code blew up");
    return (...args: unknown[]) => setAttachmentMedia(...args);
  },
}));

vi.mock("./uploadTransport", () => ({
  putAttachmentBytes: (...args: unknown[]) => putAttachmentBytes(...args),
}));

vi.mock("./imageDimensions", () => ({
  measureImageFile: (...args: unknown[]) => measureImageFile(...args),
}));

const { INLINE_PREVIEW_MAX_BYTES } = await import("@momo/core/features/attachments/model");
const { addFiles, readSurface, resetAttachmentDraftsForTest, surfaceKey } = await import("./draftStore");

const KEY = surfaceKey("ws", "ch");
const TARGET = { workspaceId: "ws", channelId: "ch" };

function file(name: string, type: string, size = 3_000): File {
  return { name, size, type } as unknown as File;
}

/** 마이크로태스크와 한 번의 타이머가 다 비워질 때까지. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0));
}

const draft = () => {
  const found = readSurface(KEY).drafts[0];
  if (found === undefined) throw new Error("a draft is on the surface");
  return found;
};

function completedRow(id: string, mime: string) {
  return {
    id,
    channelId: "ch",
    uploaderMemberId: "m",
    name: "photo",
    mime,
    size: 3_000,
    status: "complete",
    createdAtMs: 0,
  };
}

beforeEach(() => {
  declarationBlowsUp = false;
  resetAttachmentDraftsForTest();
  createAttachmentUpload.mockReset();
  completeAttachmentUpload.mockReset();
  setAttachmentMedia.mockReset();
  putAttachmentBytes.mockReset();
  measureImageFile.mockReset();
  putAttachmentBytes.mockImplementation(() => ({
    done: Promise.resolve({ ok: true }),
    abort: () => {},
  }));
  createAttachmentUpload.mockResolvedValue({
    id: "att-1",
    status: "pending",
    uploadUrl: "https://archive.invalid/session",
  });
  completeAttachmentUpload.mockImplementation(async () => completedRow("att-1", "image/jpeg"));
  setAttachmentMedia.mockImplementation(async (_ws, _ch, _id, body) => body);
  measureImageFile.mockResolvedValue({ width: 4032, height: 3024 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the declaration's place in the upload", () => {
  it("comes after the server completed the file and before the chip says uploaded", async () => {
    const order: string[] = [];
    completeAttachmentUpload.mockImplementation(async () => {
      order.push("complete");
      return completedRow("att-1", "image/jpeg");
    });
    setAttachmentMedia.mockImplementation(async (_ws, _ch, _id, body) => {
      // 그 순간 칩은 아직 「확인하는 중」이다: 올림이면 보내기가 먼저 묶을 수 있다
      order.push(`media while ${readSurface(KEY).drafts[0]?.status}`);
      return body;
    });
    addFiles(KEY, TARGET, [file("IMG_0001.jpg", "image/jpeg")]);
    await settle();
    expect(order).toEqual(["complete", "media while verifying"]);
    expect(draft().status).toBe("uploaded");
    expect(draft().attachmentId).toBe("att-1");
  });

  it("holds the chip on verifying until the declaration has been answered", async () => {
    let answer!: () => void;
    setAttachmentMedia.mockImplementation(
      (_ws, _ch, _id, body) =>
        new Promise((resolve) => {
          answer = () => resolve(body);
        })
    );
    addFiles(KEY, TARGET, [file("IMG_0002.jpg", "image/jpeg")]);
    await settle();
    expect(draft().status).toBe("verifying");
    answer();
    await settle();
    expect(draft().status).toBe("uploaded");
  });

  it("declares to the attachment the server completed, the same one the chip will send", async () => {
    createAttachmentUpload.mockResolvedValue({
      id: "att-from-the-session",
      status: "pending",
      uploadUrl: "https://archive.invalid/session",
    });
    completeAttachmentUpload.mockImplementation(async () =>
      completedRow("att-from-the-server", "image/jpeg")
    );
    addFiles(KEY, TARGET, [file("IMG_0003.jpg", "image/jpeg")]);
    await settle();
    expect(setAttachmentMedia).toHaveBeenCalledTimes(1);
    expect(setAttachmentMedia.mock.calls[0]?.[2]).toBe("att-from-the-server");
    expect(draft().attachmentId).toBe("att-from-the-server");
  });

  it("never reaches the declaration when the server did not complete the file — and nothing escapes the upload", async () => {
    // a step that carried on past the failure would trip over the row it never got: that is a rejection nobody awaits
    const escaped: unknown[] = [];
    const watch = (reason: unknown) => {
      escaped.push(reason);
    };
    process.on("unhandledRejection", watch);
    try {
      completeAttachmentUpload.mockRejectedValue(new FakeApiError(409));
      addFiles(KEY, TARGET, [file("IMG_0004.jpg", "image/jpeg")]);
      await settle();
      await settle();
    } finally {
      process.off("unhandledRejection", watch);
    }
    expect(escaped).toEqual([]);
    expect(setAttachmentMedia).not.toHaveBeenCalled();
    expect(draft().status).toBe("failed");
  });
});

describe("what is declared", () => {
  it("is the measured size as a picture's request, to this workspace, channel and attachment", async () => {
    addFiles(KEY, TARGET, [file("IMG_0005.jpg", "image/jpeg")]);
    await settle();
    expect(setAttachmentMedia).toHaveBeenCalledTimes(1);
    expect(setAttachmentMedia).toHaveBeenCalledWith("ws", "ch", "att-1", {
      kind: "image",
      width: 4032,
      height: 3024,
    });
    expect(measureImageFile).toHaveBeenCalledTimes(1);
  });

  it("declares a JPEG, a PNG, a GIF and a WebP (the server's whole closed list)", async () => {
    for (const [type, size] of [
      ["image/jpeg", { width: 4032, height: 3024 }],
      ["image/png", { width: 1170, height: 2532 }],
      ["image/gif", { width: 480, height: 270 }],
      ["image/webp", { width: 1024, height: 1024 }],
    ] as const) {
      resetAttachmentDraftsForTest();
      setAttachmentMedia.mockClear();
      measureImageFile.mockResolvedValue(size);
      completeAttachmentUpload.mockImplementation(async () => completedRow("att-1", type));
      addFiles(KEY, TARGET, [file(`picture.${type.slice(6)}`, type)]);
      await settle();
      expect(setAttachmentMedia, type).toHaveBeenCalledTimes(1);
      expect(setAttachmentMedia, type).toHaveBeenCalledWith("ws", "ch", "att-1", { kind: "image", ...size });
      expect(draft().status, type).toBe("uploaded");
    }
  });

  it("is nothing for a file the server would refuse a size for, and the file is not even decoded", async () => {
    for (const type of [
      "text/plain",
      "application/pdf",
      "application/octet-stream",
      "image/heic",
      "image/svg+xml",
      "image/avif",
      "video/mp4",
    ]) {
      resetAttachmentDraftsForTest();
      measureImageFile.mockClear();
      setAttachmentMedia.mockClear();
      completeAttachmentUpload.mockImplementation(async () => completedRow("att-1", type));
      addFiles(KEY, TARGET, [file("thing", type)]);
      await settle();
      expect(measureImageFile, type).not.toHaveBeenCalled();
      expect(setAttachmentMedia, type).not.toHaveBeenCalled();
      expect(draft().status, type).toBe("uploaded");
    }
  });

  it("is nothing for a picture too big for the timeline to draw inline (nobody boxes it), up to the limit", async () => {
    addFiles(KEY, TARGET, [file("huge.png", "image/png", INLINE_PREVIEW_MAX_BYTES + 1)]);
    await settle();
    expect(measureImageFile).not.toHaveBeenCalled();
    expect(setAttachmentMedia).not.toHaveBeenCalled();
    expect(draft().status).toBe("uploaded");

    resetAttachmentDraftsForTest();
    addFiles(KEY, TARGET, [file("exactly.png", "image/png", INLINE_PREVIEW_MAX_BYTES)]);
    await settle();
    expect(measureImageFile).toHaveBeenCalledTimes(1);
    expect(setAttachmentMedia).toHaveBeenCalledTimes(1);
  });

  it("is nothing when the size could not be measured, and the file goes on without a summary", async () => {
    for (const measured of [
      () => Promise.resolve(null),
      () => Promise.reject(new Error("decode failed")),
      () => Promise.resolve({ width: 0, height: 100 }),
      () => Promise.resolve({ width: 16_385, height: 100 }),
    ]) {
      resetAttachmentDraftsForTest();
      setAttachmentMedia.mockClear();
      measureImageFile.mockImplementation(measured);
      addFiles(KEY, TARGET, [file("IMG_0006.jpg", "image/jpeg")]);
      await settle();
      expect(setAttachmentMedia).not.toHaveBeenCalled();
      expect(draft().status).toBe("uploaded");
    }
  });
});

describe("a declaration that does not happen never costs the send", () => {
  it("leaves the chip uploaded when the server refuses (a rate limit, a 404 of a file already sent, a 400)", async () => {
    for (const status of [429, 404, 400, 403, 500]) {
      resetAttachmentDraftsForTest();
      setAttachmentMedia.mockReset();
      setAttachmentMedia.mockRejectedValue(new FakeApiError(status));
      addFiles(KEY, TARGET, [file("IMG_0007.jpg", "image/jpeg")]);
      await settle();
      expect(setAttachmentMedia, String(status)).toHaveBeenCalledTimes(1);
      expect(draft().status, String(status)).toBe("uploaded");
      expect(draft().attachmentId, String(status)).toBe("att-1");
    }
  });

  it("leaves the chip uploaded when the connection fails", async () => {
    setAttachmentMedia.mockRejectedValue(new TypeError("Failed to fetch"));
    addFiles(KEY, TARGET, [file("IMG_0008.jpg", "image/jpeg")]);
    await settle();
    expect(draft().status).toBe("uploaded");
  });

  it("leaves the chip uploaded when the declaration code itself throws", async () => {
    declarationBlowsUp = true;
    addFiles(KEY, TARGET, [file("IMG_0009.jpg", "image/jpeg")]);
    await settle();
    expect(setAttachmentMedia).not.toHaveBeenCalled();
    expect(draft().status).toBe("uploaded");
    expect(draft().attachmentId).toBe("att-1");
  });

  it("stops waiting for a server that never answers, after the budget", async () => {
    vi.useFakeTimers();
    setAttachmentMedia.mockImplementation(() => new Promise(() => {}));
    addFiles(KEY, TARGET, [file("IMG_0010.jpg", "image/jpeg")]);
    await vi.advanceTimersByTimeAsync(3_900);
    expect(draft().status).toBe("verifying");
    await vi.advanceTimersByTimeAsync(200);
    expect(draft().status).toBe("uploaded");
  });

  it("does not hold the next file behind a declaration that failed", async () => {
    setAttachmentMedia.mockRejectedValueOnce(new FakeApiError(429));
    addFiles(KEY, TARGET, [file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg")]);
    await settle();
    await settle();
    const drafts = readSurface(KEY).drafts;
    expect(drafts.map((entry) => entry.status)).toEqual(["uploaded", "uploaded"]);
  });
});

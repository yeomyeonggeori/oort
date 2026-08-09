import { describe, expect, it } from "vitest";
import {
  admitDrafts,
  attachmentIdsOf,
  attachmentMetaLine,
  beginUpload,
  completeUpload,
  draftFor,
  failUpload,
  formatBytes,
  formatMimeLabel,
  INLINE_PREVIEW_MAX_BYTES,
  isRetryableIssue,
  issueForStatus,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  progressUpload,
  removeDraft,
  requeueUpload,
  rewindUpload,
  sendBlockReason,
  sentAttachmentsOf,
  showsInlinePreview,
  uploadIssueCopy,
  verifyUpload,
  type AttachmentDraft,
} from "./model";

function picked(over: Partial<AttachmentDraft> = {}): AttachmentDraft {
  return {
    ...draftFor("local-1", {
      name: "drain-log.txt",
      mime: "text/plain",
      sizeBytes: 2048,
    }),
    ...over,
  };
}

describe("attachment draft state machine", () => {
  it("refuses a file over the server ceiling before any byte moves", () => {
    const draft = draftFor("local-big", {
      name: "capture.mov",
      mime: "video/quicktime",
      sizeBytes: MAX_ATTACHMENT_BYTES + 1,
    });
    expect(draft.status).toBe("failed");
    expect(draft.issue).toBe("too-large");
  });

  it("accepts a file exactly at the ceiling", () => {
    const draft = draftFor("local-edge", {
      name: "exact.bin",
      mime: "application/octet-stream",
      sizeBytes: MAX_ATTACHMENT_BYTES,
    });
    expect(draft.status).toBe("ready");
    expect(draft.issue).toBeUndefined();
  });

  it("walks ready to uploading to verifying to uploaded", () => {
    let list = [picked()];
    list = beginUpload(list, "local-1");
    expect(list[0].status).toBe("uploading");
    list = progressUpload(list, "local-1", 0.4);
    expect(list[0].progress).toBeCloseTo(0.4);
    list = verifyUpload(list, "local-1");
    expect(list[0].status).toBe("verifying");
    expect(list[0].progress).toBe(1);
    list = completeUpload(list, "local-1", "att-1");
    expect(list[0].status).toBe("uploaded");
    expect(list[0].attachmentId).toBe("att-1");
  });

  it("never lets progress go backwards", () => {
    let list = beginUpload([picked()], "local-1");
    list = progressUpload(list, "local-1", 0.8);
    list = progressUpload(list, "local-1", 0.2);
    expect(list[0].progress).toBeCloseTo(0.8);
  });

  it("ignores progress once the bytes are being verified", () => {
    let list = verifyUpload(beginUpload([picked()], "local-1"), "local-1");
    list = progressUpload(list, "local-1", 0.3);
    expect(list[0].status).toBe("verifying");
    expect(list[0].progress).toBe(1);
  });

  it("does not re-upload something already uploaded (mac idempotence)", () => {
    const uploaded = completeUpload([picked()], "local-1", "att-1");
    expect(beginUpload(uploaded, "local-1")[0].status).toBe("uploaded");
  });

  it("treats a cancellation as a rewind, not a failure (mac :1438)", () => {
    const list = rewindUpload(beginUpload([picked()], "local-1"), "local-1");
    expect(list[0].status).toBe("ready");
    expect(list[0].issue).toBeUndefined();
  });

  it("clears the old issue when a retry re-enters the upload", () => {
    const failed = failUpload([picked()], "local-1", "unavailable");
    expect(failed[0].issue).toBe("unavailable");
    const requeued = requeueUpload(failed, "local-1");
    expect(requeued[0].status).toBe("ready");
    expect(requeued[0].issue).toBeUndefined();
  });

  it("refuses to requeue a failure that retrying cannot change", () => {
    for (const issue of ["too-large", "forbidden", "no-archive", "blocked"] as const) {
      const failed = failUpload([picked()], "local-1", issue);
      expect(requeueUpload(failed, "local-1")[0].status).toBe("failed");
      expect(isRetryableIssue(issue)).toBe(false);
    }
  });

  it("removes a draft by its local id only", () => {
    const list = [picked(), picked({ localId: "local-2" })];
    expect(removeDraft(list, "local-1").map((d) => d.localId)).toEqual(["local-2"]);
  });
});

describe("count ceiling", () => {
  it("admits only what fits and reports what it turned away", () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE - 2 }, (_, i) =>
      picked({ localId: `have-${i}` })
    );
    const incoming = [
      picked({ localId: "new-1" }),
      picked({ localId: "new-2" }),
      picked({ localId: "new-3" }),
    ];
    const { next, rejected } = admitDrafts(existing, incoming);
    expect(next).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    // mac 은 넘친 것을 말없이 떨궜다. 개수가 돌아오는 것이 그 침묵을 닫는다.
    expect(rejected).toBe(1);
  });

  it("keeps the list identical when nothing fits", () => {
    const full = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, i) =>
      picked({ localId: `have-${i}` })
    );
    const { next, rejected } = admitDrafts(full, [picked({ localId: "new-1" })]);
    expect(next).toBe(full);
    expect(rejected).toBe(1);
  });
});

describe("send gating", () => {
  it("blocks while any byte is still moving", () => {
    const list = [
      completeUpload([picked()], "local-1", "att-1")[0],
      beginUpload([picked({ localId: "local-2" })], "local-2")[0],
    ];
    expect(sendBlockReason(list)).toBe("uploading");
  });

  it("blocks while the server is still verifying", () => {
    const list = verifyUpload(beginUpload([picked()], "local-1"), "local-1");
    expect(sendBlockReason(list)).toBe("uploading");
  });

  it("blocks on a failure so the server never has to roll the message back", () => {
    const list = [
      completeUpload([picked()], "local-1", "att-1")[0],
      failUpload([picked({ localId: "local-2" })], "local-2", "unavailable")[0],
    ];
    expect(sendBlockReason(list)).toBe("failed");
  });

  it("allows a send when every draft is uploaded, and none at all", () => {
    expect(sendBlockReason([])).toBeNull();
    const done = completeUpload([picked()], "local-1", "att-1");
    expect(sendBlockReason(done)).toBeNull();
    expect(attachmentIdsOf(done)).toEqual(["att-1"]);
    expect(sentAttachmentsOf(done)).toEqual([
      { id: "att-1", name: "drain-log.txt", mime: "text/plain", sizeBytes: 2048 },
    ]);
  });

  it("drops ids for drafts that never got one", () => {
    const list = [picked(), completeUpload([picked({ localId: "local-2" })], "local-2", "att-2")[0]];
    expect(attachmentIdsOf(list)).toEqual(["att-2"]);
  });
});

describe("failure vocabulary", () => {
  it("maps the server's refusals onto reasons a person can act on", () => {
    expect(issueForStatus(413)).toBe("too-large");
    expect(issueForStatus(400)).toBe("too-large");
    expect(issueForStatus(403)).toBe("forbidden");
    expect(issueForStatus(503)).toBe("no-archive");
    expect(issueForStatus(502)).toBe("no-archive");
    expect(issueForStatus(409)).toBe("mismatch");
    expect(issueForStatus(500)).toBe("unavailable");
  });

  it("keeps the two mac sentences verbatim", () => {
    expect(uploadIssueCopy("too-large")).toBe("100MB를 초과함");
    expect(uploadIssueCopy("unavailable")).toBe("업로드 실패");
  });

  it("gives every reason a sentence", () => {
    for (const issue of [
      "too-large",
      "forbidden",
      "no-archive",
      "mismatch",
      "blocked",
      "unavailable",
    ] as const) {
      expect(uploadIssueCopy(issue).length).toBeGreaterThan(0);
    }
  });
});

describe("presentation", () => {
  it("counts in 1024s so the ceiling prints as the ceiling sentence says", () => {
    expect(formatBytes(MAX_ATTACHMENT_BYTES)).toBe("100 MB");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(18)).toBe("18 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1024 * 1024 * 2.4)).toBe("2.4 MB");
    expect(formatBytes(-1)).toBe("0 B");
  });

  it("labels a type from its subtype", () => {
    expect(formatMimeLabel("image/png")).toBe("PNG");
    expect(formatMimeLabel("application/pdf")).toBe("PDF");
    expect(formatMimeLabel("text/plain; charset=utf-8")).toBe("PLAIN");
    expect(formatMimeLabel("application/x-tar")).toBe("TAR");
    expect(formatMimeLabel("nonsense")).toBe("NONSENSE");
  });

  it("builds the card's second line the way mac does", () => {
    expect(
      attachmentMetaLine({
        id: "a",
        name: "note.txt",
        mime: "text/plain",
        sizeBytes: 18,
      })
    ).toBe("PLAIN · 18 B");
  });

  it("opens an inline preview only for a bounded raster image", () => {
    const image = {
      id: "a",
      name: "screen.png",
      mime: "image/png",
      sizeBytes: 1024,
    };
    expect(showsInlinePreview(image)).toBe(true);
    expect(
      showsInlinePreview({ ...image, sizeBytes: INLINE_PREVIEW_MAX_BYTES + 1 })
    ).toBe(false);
    // SVG 는 이미지여도 카드다. 서버가 nosniff 로 막은 실행 경로를 화면이 되살리지
    // 않는다.
    expect(showsInlinePreview({ ...image, mime: "image/svg+xml" })).toBe(false);
    expect(showsInlinePreview({ ...image, mime: "application/pdf" })).toBe(false);
  });
});

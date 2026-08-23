import { describe, expect, it } from "vitest";
import {
  admitDrafts,
  ATTACH_COPY,
  draftAnnouncement,
  draftStatusLine,
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
  sendBlockCopy,
  sendBlockReason,
  sentAttachmentsOf,
  showsInlinePreview,
  splitFileName,
  uploadIssueCopy,
  uploadIssueNext,
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

  it("counts a queued draft as uploading, not as a failure", () => {
    // 리뷰 N-2: `ready` 를 실패 갈래에 접어 두면 재시도 직후 한 프레임 동안
    // 실패한 것이 없는데 실패를 말한다.
    expect(sendBlockReason([picked()])).toBe("uploading");
    expect(sendBlockCopy([picked()])).toBe(ATTACH_COPY.sendBlocked);
  });

  it("points at the retry only when a retry button will exist", () => {
    // 리뷰 M-1: 되돌릴 값이 없는 실패만 남았을 때 "다시 시도한 뒤"는 화면에 없는
    // 버튼을 가리키는 안내다.
    const retryable = failUpload([picked()], "local-1", "unavailable");
    expect(sendBlockCopy(retryable)).toBe(ATTACH_COPY.sendBlockedRetryable);
    const terminal = failUpload([picked()], "local-1", "forbidden");
    expect(sendBlockCopy(terminal)).toBe(ATTACH_COPY.sendBlockedFailed);
    expect(sendBlockCopy(completeUpload([picked()], "local-1", "att-1"))).toBeNull();
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

  it("says the next action exactly where no retry button will stand", () => {
    // 리뷰 M-1. 재시도가 서는 둘은 버튼이 곧 다음 행동이라 문장이 없고,
    // 안 서는 넷은 화면에 남는 행동이 제거뿐이라 문장이 있어야 한다.
    for (const issue of ["too-large", "forbidden", "no-archive", "blocked"] as const) {
      expect(isRetryableIssue(issue)).toBe(false);
      expect(uploadIssueNext(issue)).not.toBeNull();
    }
    for (const issue of ["mismatch", "unavailable"] as const) {
      expect(isRetryableIssue(issue)).toBe(true);
      expect(uploadIssueNext(issue)).toBeNull();
    }
    expect(isRetryableIssue("permission-denied")).toBe(false);
    expect(uploadIssueNext("permission-denied")).not.toBeNull();
    // 고르기를 무른 것은 실패가 아니므로 다음 행동을 명령하지 않는다.
    expect(isRetryableIssue("selection-cancelled")).toBe(false);
    expect(uploadIssueNext("selection-cancelled")).toBeNull();
  });

  it("does not repeat the retry verb in the sentence beside the retry button", () => {
    // 리뷰 H-4: 앞 판은 "…다릅니다. 다시 시도하세요" + 버튼 "다시 시도" +
    // 발치 "…다시 시도한 뒤" 로 두 줄에 같은 동사를 세 번 찍었다.
    expect(uploadIssueCopy("mismatch")).not.toContain(ATTACH_COPY.retry);
  });

  it("gives every reason a sentence", () => {
    for (const issue of [
      "selection-cancelled",
      "permission-denied",
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

describe("the line under the name", () => {
  it("says the size in every state, not only after it finished", () => {
    // 리뷰 M-7: 크기가 가장 궁금한 순간은 기다리는 동안이다.
    for (const list of [
      [picked()],
      beginUpload([picked()], "local-1"),
      verifyUpload(beginUpload([picked()], "local-1"), "local-1"),
      completeUpload([picked()], "local-1", "att-1"),
      failUpload([picked()], "local-1", "unavailable"),
    ]) {
      expect(draftStatusLine(list[0]).text.startsWith("2 KB · ")).toBe(true);
    }
  });

  it("omits the size when the native picker could not measure it", () => {
    const unknown = picked({ sizeBytes: 0, sizeKnown: false });
    expect(draftStatusLine(unknown).text).toBe(ATTACH_COPY.queued);
    expect(draftAnnouncement([], [unknown])).toBe(
      `drain-log.txt ${ATTACH_COPY.queued}`
    );
  });

  it("keeps a measured empty file distinct from an unknown size", () => {
    const empty = picked({ sizeBytes: 0, sizeKnown: true });
    expect(draftStatusLine(empty).text).toBe(`0 B · ${ATTACH_COPY.queued}`);
  });

  it("carries the reason and the next action on a terminal failure", () => {
    const failed = failUpload([picked()], "local-1", "too-large")[0];
    const line = draftStatusLine(failed);
    expect(line.danger).toBe(true);
    expect(line.text).toContain(uploadIssueCopy("too-large"));
    expect(line.text).toContain(uploadIssueNext("too-large") as string);
  });

  it("puts the percentage on the status line, not beside the name", () => {
    // 리뷰 N-B: 이름 옆에 두면 첫 측정과 「확인 중」에 이름 열 폭이 두 번 바뀐다.
    const measured = progressUpload(beginUpload([picked()], "local-1"), "local-1", 0.34);
    expect(draftStatusLine(measured[0]).percent).toBe(34);
    // 잰 값이 없으면 수를 말하지 않는다 (B-3 과 같은 규율).
    expect(draftStatusLine(beginUpload([picked()], "local-1")[0]).percent).toBeNull();
    expect(
      draftStatusLine(verifyUpload(measured, "local-1")[0]).percent
    ).toBeNull();
  });

  it("announces words, never percentages", () => {
    // 리뷰 H-3: 진행률을 live region 에 실으면 초당 몇 번씩 낭독된다. 낱말이
    // 바뀔 때만 바뀌는 문장이 「확인 중 → 업로드 완료」에 소리를 준다.
    let list = beginUpload([picked()], "local-1");
    const moved = progressUpload(list, "local-1", 0.42);
    // 진행률만 움직인 렌더는 낭독할 것이 없다.
    expect(draftAnnouncement(list, moved)).toBeNull();
    list = moved;
    const verifying = draftAnnouncement(list, verifyUpload(list, "local-1"));
    const done = draftAnnouncement(list, completeUpload(list, "local-1", "att-1"));
    expect(verifying).toContain(ATTACH_COPY.verifying);
    expect(done).toContain(ATTACH_COPY.uploaded);
    expect(verifying).not.toBe(done);
    expect(draftAnnouncement([], [])).toBeNull();
  });

  it("speaks only the chip that changed, not the whole tray (M-A)", () => {
    // 20개를 올리는 동안 한 칩이 바뀔 때마다 20줄이 낭독되던 것이 M-A 다.
    const many = Array.from({ length: 20 }, (_, i) =>
      picked({ localId: `l-${i}`, name: `batch-${i}.log` })
    );
    const after = completeUpload(beginUpload(many, "l-7"), "l-7", "att-7");
    const said = draftAnnouncement(many, after) as string;
    expect(said).toContain("batch-7.log");
    for (const other of ["batch-0.log", "batch-19.log"]) {
      expect(said).not.toContain(other);
    }
    // 한 줄이다: 목록을 이어 붙이지 않는다.
    expect(said.split(",")).toHaveLength(1);
  });

  it("summarises a batch by word and count, never as a vague change", () => {
    const before: AttachmentDraft[] = [];
    const after = [
      picked({ localId: "l-1" }),
      picked({ localId: "l-2" }),
      picked({ localId: "l-3" }),
    ];
    expect(draftAnnouncement(before, after)).toBe(
      `${ATTACH_COPY.tray} 3개 ${ATTACH_COPY.queued}`
    );
    // 섞이면 낱말별로 세어 말한다. 「N개 상태가 바뀌었습니다」는 아무것도 말하지
    // 않으므로 쓰지 않는다.
    const mixed = beginUpload(after, "l-1");
    expect(draftAnnouncement(before, mixed)).toBe(
      `${ATTACH_COPY.tray} 2개 ${ATTACH_COPY.queued}, 1개 ${ATTACH_COPY.uploading}`
    );
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

  it("labels a type with a word a person reads, never a subtype", () => {
    // 리뷰 M-7a: "PLAIN" 은 낱말이 아니다. 최상위 타입은 IANA 가 정한 여덟 개짜리
    // 사실상 닫힌 집합이라, 서브타입 사전과 달리 조용히 틀리는 자리가 없다.
    expect(formatMimeLabel("image/png")).toBe("이미지");
    expect(formatMimeLabel("text/plain; charset=utf-8")).toBe("텍스트");
    expect(formatMimeLabel("application/pdf")).toBe("PDF");
    expect(formatMimeLabel("application/x-tar")).toBe("압축");
    expect(formatMimeLabel("video/quicktime")).toBe("동영상");
    expect(formatMimeLabel("audio/mpeg")).toBe("오디오");
    expect(formatMimeLabel("application/json")).toBe("텍스트");
    // 모르는 것은 「파일」로 떨어진다. 확장자는 파일명이 이미 말한다.
    expect(formatMimeLabel("application/vnd.acme.thing")).toBe("파일");
    expect(formatMimeLabel("nonsense")).toBe("파일");
  });

  it("keeps the extension alive when a narrow chip truncates the name", () => {
    // 리뷰 N-A: 끝에서 자르면 파일을 서로 구별해 주는 조각이 먼저 죽는다.
    const split = splitFileName("release-2026-08-09-드레인-워커-지연-로그-전문.log");
    expect(split.tail).toBe("전문.log");
    expect(split.head + split.tail).toBe(
      "release-2026-08-09-드레인-워커-지연-로그-전문.log"
    );
    // 확장자가 없으면 가를 것이 없다.
    expect(splitFileName("Makefile")).toEqual({ head: "Makefile", tail: "" });
    expect(splitFileName(".gitignore")).toEqual({ head: ".gitignore", tail: "" });
  });

  it("builds the card's second line the way mac does", () => {
    expect(
      attachmentMetaLine({
        id: "a",
        name: "note.txt",
        mime: "text/plain",
        sizeBytes: 18,
      })
    ).toBe("텍스트 · 18 B");
    expect(
      attachmentMetaLine({
        id: "unknown",
        name: "provider.bin",
        mime: "application/octet-stream",
        sizeBytes: 0,
      })
    ).toBe("파일 · 0 B");
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

import { describe, expect, it } from "vitest";
import {
  completeUpload,
  draftFor,
  failUpload,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentDraft,
} from "@momo/core/features/attachments/model";
import {
  cardKind,
  cardShape,
  focusAfterRemove,
  moveTarget,
  rovingStop,
  stripFade,
  trayCounts,
  trayKeyAction,
} from "./trayModel";

// 입력창 안 첨부 줄의 판정 (#5200). 화면은 이 값을 그리기만 한다.

const draft = (
  id: string,
  mime = "image/png",
  over: Partial<AttachmentDraft> = {}
): AttachmentDraft => ({
  ...draftFor(id, { name: `${id}.bin`, mime, sizeBytes: 1_000 }),
  ...over,
});

const many = (n: number): AttachmentDraft[] =>
  Array.from({ length: n }, (_, at) => draft(`d${at}`));

describe("카드의 종류와 모양", () => {
  it("종류는 최상위 mime 으로만 가른다(대소문자 무시)", () => {
    expect(cardKind("image/png")).toBe("image");
    expect(cardKind("IMAGE/WEBP")).toBe("image");
    expect(cardKind("video/mp4")).toBe("video");
    expect(cardKind("audio/mpeg")).toBe("audio");
    expect(cardKind("application/pdf")).toBe("file");
    expect(cardKind("text/plain")).toBe("file");
    expect(cardKind("application/octet-stream")).toBe("file");
  });

  it("안전한 래스터 이미지는 thumb 이고, 썸네일이 그려지는 중이어도 thumb 이다(도착 순간에 자라지 않는다)", () => {
    expect(cardShape(draft("a", "image/png"), "none")).toBe("thumb");
    expect(cardShape(draft("a", "image/png"), "loading")).toBe("thumb");
    expect(cardShape(draft("a", "image/png"), "ready")).toBe("thumb");
  });

  it("디코드에 실패한 이미지는 이름이 보이는 file 카드로 돌아간다", () => {
    expect(cardShape(draft("a", "image/heic"), "failed")).toBe("file");
  });

  it("영상·PDF·로그·SVG·크기를 모르는 그림은 file 이다", () => {
    expect(cardShape(draft("v", "video/mp4"), "none")).toBe("file");
    expect(cardShape(draft("p", "application/pdf"), "none")).toBe("file");
    expect(cardShape(draft("t", "text/plain"), "none")).toBe("file");
    expect(cardShape(draft("s", "image/svg+xml"), "none")).toBe("file");
    expect(cardShape(draft("u", "image/png", { sizeKnown: false }), "none")).toBe("file");
  });

  it("실패한 것은 종류와 상관없이 failed 다(이유를 읽어야 한다)", () => {
    const failed = failUpload([draft("a", "image/png")], "a", "unavailable")[0] as AttachmentDraft;
    expect(cardShape(failed, "ready")).toBe("failed");
    const failedVideo = failUpload([draft("v", "video/mp4")], "v", "too-large")[0] as AttachmentDraft;
    expect(cardShape(failedVideo, "none")).toBe("failed");
  });

  it("끝난 것(uploaded)은 모양을 바꾸지 않는다", () => {
    const done = completeUpload([draft("a", "image/png")], "a", "att-1")[0] as AttachmentDraft;
    expect(cardShape(done, "ready")).toBe("thumb");
  });
});

describe("키보드", () => {
  it("카드에서 가져가는 키는 빼기(Backspace·Delete)와 이동(←→·Home·End)뿐이다", () => {
    expect(trayKeyAction("Backspace")).toBe("remove");
    expect(trayKeyAction("Delete")).toBe("remove");
    expect(trayKeyAction("ArrowLeft")).toBe("prev");
    expect(trayKeyAction("ArrowRight")).toBe("next");
    expect(trayKeyAction("Home")).toBe("first");
    expect(trayKeyAction("End")).toBe("last");
    for (const key of ["Enter", " ", "Tab", "ArrowUp", "ArrowDown", "a", "Escape"]) {
      expect(trayKeyAction(key)).toBeNull();
    }
  });

  it("탭 정거장은 줄에 하나다: 기억한 카드, 사라졌으면 첫 카드, 비었으면 없음", () => {
    expect(rovingStop([], null)).toBeNull();
    expect(rovingStop(["a", "b", "c"], null)).toBe("a");
    expect(rovingStop(["a", "b", "c"], "c")).toBe("c");
    expect(rovingStop(["a", "b", "c"], "gone")).toBe("a");
  });

  it("←/→ 는 끝에서 돌아 나가지 않는다", () => {
    const ids = ["a", "b", "c"];
    expect(moveTarget(ids, "b", "prev")).toBe("a");
    expect(moveTarget(ids, "b", "next")).toBe("c");
    expect(moveTarget(ids, "a", "prev")).toBe("a");
    expect(moveTarget(ids, "c", "next")).toBe("c");
    expect(moveTarget(ids, "b", "first")).toBe("a");
    expect(moveTarget(ids, "b", "last")).toBe("c");
    expect(moveTarget(ids, "nope", "next")).toBeNull();
    expect(moveTarget([], "a", "next")).toBeNull();
  });

  it("카드를 뺀 뒤 초점: 같은 자리로 올라온 다음 카드 → 마지막이었으면 앞 카드 → 하나뿐이면 글 칸(null)", () => {
    const ids = ["a", "b", "c"];
    expect(focusAfterRemove(ids, "a")).toBe("b");
    expect(focusAfterRemove(ids, "b")).toBe("c");
    expect(focusAfterRemove(ids, "c")).toBe("b");
    expect(focusAfterRemove(["a"], "a")).toBeNull();
    expect(focusAfterRemove(ids, "nope")).toBeNull();
  });
});

describe("가장자리 흐림은 넘치는 쪽만이다", () => {
  const view = { clientWidth: 300, scrollWidth: 900 };

  it("넘치지 않으면 흐리지 않다", () => {
    expect(stripFade({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toBe("none");
    expect(stripFade({ scrollLeft: 0, clientWidth: 300, scrollWidth: 301 })).toBe("none");
  });

  it("맨 앞에서는 오른쪽만, 맨 끝에서는 왼쪽만, 가운데에서는 양쪽이 흐리다", () => {
    expect(stripFade({ ...view, scrollLeft: 0 })).toBe("end");
    expect(stripFade({ ...view, scrollLeft: 300 })).toBe("both");
    expect(stripFade({ ...view, scrollLeft: 600 })).toBe("start");
  });

  it("소수점 스크롤이 만드는 2px 의 가짜 넘침은 무시한다", () => {
    expect(stripFade({ ...view, scrollLeft: 598.5 })).toBe("start");
    expect(stripFade({ ...view, scrollLeft: 1.5 })).toBe("end");
  });
});

describe("개수와 알림", () => {
  it("상한은 코어의 20 이고 스무 장이면 찬 줄이다", () => {
    expect(trayCounts(many(1), 0, 0).limit).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(20);
    expect(trayCounts(many(19), 0, 0).full).toBe(false);
    expect(trayCounts(many(20), 0, 0).full).toBe(true);
  });

  it("「모두 지우기」는 넷부터다(셋 이하는 하나씩 빼는 쪽이 빠르다)", () => {
    expect(trayCounts(many(3), 0, 0).showsClearAll).toBe(false);
    expect(trayCounts(many(4), 0, 0).showsClearAll).toBe(true);
  });

  it("상한·폴더로 못 받은 것이 있을 때만 알림이 선다", () => {
    expect(trayCounts(many(2), 0, 0).showsNotice).toBe(false);
    expect(trayCounts(many(20), 3, 0)).toMatchObject({ showsNotice: true, rejected: 3 });
    expect(trayCounts([], 0, 2)).toMatchObject({ showsNotice: true, folders: 2 });
  });

  it("막힌 이유: 올라가는 중이 있으면 uploading, 실패만 남으면 failed, 다 끝났으면 null", () => {
    const uploading = [draft("a", "image/png")];
    expect(trayCounts(uploading, 0, 0).blocked).toBe("uploading");
    const failed = failUpload([draft("a")], "a", "unavailable");
    expect(trayCounts(failed, 0, 0).blocked).toBe("failed");
    const done = completeUpload([draft("a")], "a", "att-1");
    expect(trayCounts(done, 0, 0).blocked).toBeNull();
  });
});

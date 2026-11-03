import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import {
  admitDrafts,
  beginUpload,
  draftAnnouncement,
  draftFor,
  draftStatusLine,
  draftStatusWord,
  failUpload,
  requeueUpload,
} from "../attachments/model";
import { uploadReasonKey, verdictForRequestFailure, verdictForTransferFailure } from "./uploadFailure";

// 올리기 실패를 상태 코드 대신 분류로 말한다. 502·503이 「파일 보관소 없음」이던 것이 이 시험의 중심이다: 기다리면 되는 일에
// 관리자를 부르지 않는다.

const network = new NetworkError("unreachable", 15_000);

describe("올리기 요청이 던진 실패의 분류", () => {
  // 지키는 것: 닿지 못함(응답 없음·502·504·코드 없는 503)은 보관소 이야기가 아니라 원인으로 말하고 다시 올릴 수 있다.
  it("닿지 못한 실패는 다시 올릴 수 있는 실패(unavailable)와 원인으로 말한다", () => {
    expect(verdictForRequestFailure(network, false)).toEqual({ issue: "unavailable", cause: "deviceOffline" });
    expect(verdictForRequestFailure(network, true)).toEqual({ issue: "unavailable", cause: "serverUnreachable" });
    for (const status of [502, 503, 504]) {
      expect(verdictForRequestFailure(new ApiError(status, "x"), true)).toEqual({
        issue: "unavailable",
        cause: "serverUnreachable",
      });
    }
  });

  // 지키는 것: 서버가 직접 이름을 붙여 거절한 것은 그대로 말한다(보관소 미연결·권한·크기·검증 불일치).
  it("서버가 직접 거절한 응답은 이유 그대로 남고 원인은 없다", () => {
    const named = (status: number, code?: string) => verdictForRequestFailure(new ApiError(status, "x", code), true);
    expect(named(503, "archive_not_configured")).toEqual({ issue: "no-archive", cause: null });
    expect(named(403)).toEqual({ issue: "forbidden", cause: null });
    expect(named(413)).toEqual({ issue: "too-large", cause: null });
    expect(named(409)).toEqual({ issue: "mismatch", cause: null });
    expect(named(500)).toEqual({ issue: "unavailable", cause: null });
    expect(verdictForRequestFailure(new Error("boom"), true)).toEqual({ issue: "unavailable", cause: null });
  });
});

describe("바이트 올리기 실패의 분류", () => {
  it("막힘(CSP)은 배포 문제, 답한 코드는 요청과 같은 규칙, 연결 실패는 기기 상태로 가른다", () => {
    expect(verdictForTransferFailure("blocked", undefined, true)).toEqual({ issue: "blocked", cause: null });
    expect(verdictForTransferFailure("status", 502, true)).toEqual({ issue: "unavailable", cause: "serverUnreachable" });
    expect(verdictForTransferFailure("status", 413, true)).toEqual({ issue: "too-large", cause: null });
    expect(verdictForTransferFailure("network", undefined, false)).toEqual({ issue: "unavailable", cause: "deviceOffline" });
    expect(verdictForTransferFailure("network", undefined, null)).toEqual({ issue: "unavailable", cause: "serverUnreachable" });
  });
});

describe("원인 문장의 사전 키", () => {
  // 지키는 것: 모델의 표를 그대로 읽는다. 올리기 실패를 설명하지 못하는 원인은 칩의 기존 문장을 쓴다.
  it("오프라인·서버에 닿지 못함만 문장이 있고 나머지는 없다", () => {
    expect(uploadReasonKey("deviceOffline")).toBe("connection.upload.failedOffline");
    expect(uploadReasonKey("serverUnreachable")).toBe("connection.upload.failedServer");
    expect(uploadReasonKey("realtimeDown")).toBeNull();
    expect(uploadReasonKey("unknown")).toBeNull();
    expect(uploadReasonKey(undefined)).toBeNull();
  });
});

describe("칩에 원인을 싣기", () => {
  const picked = () => {
    const { next } = admitDrafts([], [draftFor("d1", { name: "보고서.pdf", mime: "application/pdf", sizeBytes: 10 })]);
    return beginUpload(next, "d1");
  };

  // 지키는 것: 새 실패는 이전 실패의 원인을 물려받지 않는다.
  it("원인을 싣고, 다음 실패에 원인이 없으면 걷는다. 다시 올리면 상태가 대기로 돌아온다", () => {
    const list = picked();
    const id = list[0]!.localId;
    const withCause = failUpload(list, id, "unavailable", "serverUnreachable");
    expect(withCause[0]).toMatchObject({ status: "failed", issue: "unavailable", failureCause: "serverUnreachable" });
    const without = failUpload(withCause, id, "forbidden");
    expect(without[0]!.failureCause).toBeUndefined();
    expect(without[0]).toMatchObject({ status: "failed", issue: "forbidden" });
    expect(requeueUpload(withCause, id)[0]!.status).toBe("ready");
  });

  // 지키는 것: 화면이 준 이유 문장이 눈에 보이는 줄과 낭독에 똑같이 쓰인다. 주지 않으면 기존 문장이다.
  it("이유 문장을 갈아 끼우면 칩의 줄과 낭독이 같은 문장을 쓰고, 안 주면 기존 문장이다", () => {
    const list = picked();
    const failed = failUpload(list, list[0]!.localId, "unavailable", "deviceOffline");
    const reasonFor = () => "오프라인이라 올리지 못했어요";
    expect(draftStatusWord(failed[0]!, reasonFor)).toBe("오프라인이라 올리지 못했어요");
    expect(draftStatusLine(failed[0]!, reasonFor).text).toContain("오프라인이라 올리지 못했어요");
    expect(draftAnnouncement(list, failed, reasonFor)).toContain("오프라인이라 올리지 못했어요");
    expect(draftStatusWord(failed[0]!)).toBe("업로드 실패");
    expect(draftAnnouncement(list, failed)).toContain("업로드 실패");
  });
});

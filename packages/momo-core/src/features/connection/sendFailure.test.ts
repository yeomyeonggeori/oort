import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { AUTO_RESEND_MAX_ATTEMPTS, AUTO_RESEND_WINDOW_MS } from "./thresholds";
import {
  isFailedRow,
  isSendingRow,
  isServerAnswer,
  pickAutoResends,
  recordSendFailure,
  resendAllContinuesAfter,
  sendFailureKind,
  sendFailureReasonKey,
  type SendFailureRecord,
} from "./sendFailure";

const T0 = 1_700_000_000_000;
const network = new NetworkError("unreachable", 15_000);

function row(clientMsgId: string, status: "sending" | "failed" = "failed") {
  return { clientMsgId, status } as const;
}

describe("보내지 못한 글의 원인 한 줄", () => {
  // 지키는 것: 원인 한 줄이 실제 실패를 따라간다(오프라인 / 서버에 닿지 못함 / 서버 거절 / 알 수 없음).
  it("응답 없음은 기기 상태로 offline·server, 서버가 직접 낸 거절은 rejected, 알 수 없는 오류는 null", () => {
    expect(sendFailureKind(network, false)).toBe("offline");
    expect(sendFailureKind(network, true)).toBe("server");
    expect(sendFailureKind(new ApiError(502, "bad gateway"), true)).toBe("server");
    expect(sendFailureKind(new ApiError(413, "too large"), true)).toBe("rejected");
    expect(sendFailureKind(new ApiError(500, "boom"), true)).toBe("rejected");
    expect(sendFailureKind(new Error("boom"), true)).toBeNull();
  });

  // 지키는 것: 종류마다 다른 완결된 문장(서로 다른 사전 키).
  it("종류마다 서로 다른 사전 키를 낸다", () => {
    const keys = (["offline", "server", "rejected"] as const).map(sendFailureReasonKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      "connection.send.reasonOffline",
      "connection.send.reasonServer",
      "connection.send.reasonRejected",
    ]);
  });
});

describe("실패 기록", () => {
  // 지키는 것: 처음 실패한 때는 다시 실패해도 그대로다(5분은 첫 실패로부터 센다).
  it("처음 실패한 때를 지키고, 자동으로 다시 보낸 실패만 횟수에 센다", () => {
    const first = recordSendFailure(undefined, network, true, T0, false);
    expect(first).toMatchObject({ kind: "server", firstFailedAt: T0, autoAttempts: 0 });
    const auto = recordSendFailure(first, network, true, T0 + 10_000, true);
    expect(auto).toMatchObject({ firstFailedAt: T0, autoAttempts: 1 });
    // 손으로 보낸 것은 세지 않고 상한을 되돌리지도 않는다.
    const manual = recordSendFailure(auto, network, true, T0 + 20_000, false);
    expect(manual).toMatchObject({ firstFailedAt: T0, autoAttempts: 1 });
    // 마지막 시도가 던진 것으로 종류가 바뀐다.
    const rejected = recordSendFailure(manual, new ApiError(403, "no"), true, T0 + 30_000, false);
    expect(rejected).toMatchObject({ kind: "rejected", firstFailedAt: T0, autoAttempts: 1 });
  });
});

describe("저절로 다시 보낼 행 고르기", () => {
  const records = (entries: Record<string, SendFailureRecord>) => new Map(Object.entries(entries));
  const fresh = (failure: unknown, autoAttempts = 0, firstFailedAt = T0): SendFailureRecord => ({
    failure,
    kind: null,
    firstFailedAt,
    autoAttempts,
  });

  // 지키는 것: 결정 ⑤. 네트워크로 못 보낸 글만 고르고, 서버가 거절한 글·보내는 중인 행·기록 없는 행은 고르지 않는다.
  it("네트워크 실패만 보낸 순서대로 고르고, 거절된 글·보내는 중·기록 없는 행은 거른다", () => {
    const picked = pickAutoResends(
      [row("a"), row("b"), row("c"), row("d", "sending"), row("e"), row("f")],
      records({
        a: fresh(network),
        b: fresh(new ApiError(413, "too large")),
        c: fresh(new NetworkError("timeout", 15_000)),
        d: fresh(network),
        f: fresh(new Error("boom")),
      }),
      T0 + 1_000
    );
    expect(picked).toEqual(["a", "c"]);
  });

  // 지키는 것: 한 글 3회·5분 상한(S-A 판정 그대로).
  it("3회를 채웠거나 첫 실패로부터 5분이 지난 글은 고르지 않는다", () => {
    const picked = pickAutoResends(
      [row("under"), row("spent"), row("late"), row("edge")],
      records({
        under: fresh(network, AUTO_RESEND_MAX_ATTEMPTS - 1),
        spent: fresh(network, AUTO_RESEND_MAX_ATTEMPTS),
        late: fresh(network, 0, T0 - AUTO_RESEND_WINDOW_MS - 1),
        edge: fresh(network, 0, T0 - AUTO_RESEND_WINDOW_MS),
      }),
      T0
    );
    expect(picked).toEqual(["under"]);
  });
});

describe("연결이 돌아왔다는 신호와 모두 다시 보내기의 이어 가기", () => {
  const base = { at: 1, method: "GET", target: "/v1/x" } as const;

  // 지키는 것: 서버가 답했다(응답이 왔고 5xx가 아니다)만 신호다.
  it("5xx 미만의 응답만 서버가 답한 신호이고, 5xx 응답과 응답 없음은 아니다", () => {
    expect(isServerAnswer({ ...base, kind: "response", status: 200 })).toBe(true);
    expect(isServerAnswer({ ...base, kind: "response", status: 404 })).toBe(true);
    expect(isServerAnswer({ ...base, kind: "response", status: 499 })).toBe(true);
    expect(isServerAnswer({ ...base, kind: "response", status: 500 })).toBe(false);
    expect(isServerAnswer({ ...base, kind: "response", status: 502 })).toBe(false);
    expect(isServerAnswer({ ...base, kind: "network", failure: "unreachable" })).toBe(false);
  });

  // 지키는 것: 서버가 직접 거절한 글 뒤에는 이어 가고, 네트워크 실패·이유 모름·기록 없음 뒤에는 멈춘다(순서 보존).
  it("거절 뒤에는 이어 가고, 네트워크 실패·이유 모름·기록 없음 뒤에는 멈춘다", () => {
    const record = (kind: SendFailureRecord["kind"]): SendFailureRecord => ({
      failure: null,
      kind,
      firstFailedAt: T0,
      autoAttempts: 0,
    });
    expect(resendAllContinuesAfter(record("rejected"))).toBe(true);
    expect(resendAllContinuesAfter(record("server"))).toBe(false);
    expect(resendAllContinuesAfter(record("offline"))).toBe(false);
    expect(resendAllContinuesAfter(record(null))).toBe(false);
    expect(resendAllContinuesAfter(undefined)).toBe(false);
  });

  it("행의 상태 판정", () => {
    expect([isFailedRow({ status: "failed" }), isFailedRow({ status: "sending" })]).toEqual([true, false]);
    expect([isSendingRow({ status: "sending" }), isSendingRow({ status: "failed" })]).toEqual([true, false]);
  });
});

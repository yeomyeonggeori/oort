import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { judgeAutoResend } from "./autoResend";

// 결정 ⑤의 판정: 네트워크로 못 보낸 글만, 한 글 3회·5분 안에서. 숫자는 글자 그대로 단정한다.

const T0 = 1_700_000_000_000;
const network = new NetworkError("unreachable", 15_000);
const timeout = new NetworkError("timeout", 15_000);

describe("자동 재전송 판정", () => {
  // 지키는 것: 서버가 거절한 글을 몰래 다시 보내지 않는다. 네트워크로 못 보낸 글만 같은 멱등 키로 다시 보낸다.
  it("NetworkError(응답 없음·시간 초과)만 다시 보내고, 서버가 거절한 글(ApiError)·알 수 없는 오류는 손으로 둔다", () => {
    for (const failure of [network, timeout]) {
      expect(judgeAutoResend({ failure, attempts: 0, firstFailedAt: T0, now: T0 })).toEqual({
        retryable: true,
        attempt: 1,
        exhausted: false,
        limit: null,
        resend: true,
      });
    }
    for (const failure of [new ApiError(403, "forbidden"), new ApiError(503, "unavailable"), new Error("boom"), "x"]) {
      expect(judgeAutoResend({ failure, attempts: 0, firstFailedAt: T0, now: T0 })).toMatchObject({
        retryable: false,
        exhausted: false,
        resend: false,
      });
    }
  });

  // 지키는 것: 한 글을 끝없이 다시 보내지 않는다(3회, 첫 실패로부터 5분).
  it("몇 번째인지 세고, 3회를 채우거나 첫 실패로부터 5분이 되면 상한이다", () => {
    const at = (attempts: number, ms: number) =>
      judgeAutoResend({ failure: network, attempts, firstFailedAt: T0, now: T0 + ms });
    expect([0, 1, 2].map((attempts) => at(attempts, 0).attempt)).toEqual([1, 2, 3]);
    expect(at(2, 0)).toMatchObject({ resend: true, exhausted: false });
    expect(at(3, 0)).toMatchObject({ resend: false, exhausted: true, limit: "attempts" });
    expect(at(0, 299_999)).toMatchObject({ resend: true, exhausted: false });
    expect(at(0, 300_000)).toMatchObject({ resend: false, exhausted: true, limit: "window" });
  });
});

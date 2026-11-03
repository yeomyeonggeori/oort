import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { causeOfFailure } from "./failure";

// 실패한 그 자리가 말하는 원인. 서버가 직접 답한 거절을 「서버에 닿지 못함」이라 부르면 사람이 할 수 있는 일(내용을
// 고치기)을 숨기고, 닿지 못한 것을 거절이라 부르면 기다리면 될 일에 겁을 준다.

describe("실패의 원인 분류", () => {
  // 지키는 것: 응답이 없었으면 기기 상태로 오프라인과 서버를 가른다. 기기 상태를 모르면 오프라인이라 하지 않는다.
  it("응답 없음(NetworkError)은 기기가 꺼져 있으면 오프라인, 켜져 있거나 모르면 서버에 닿지 못함", () => {
    const failure = new NetworkError("unreachable", 15_000);
    expect(causeOfFailure(failure, false)).toBe("deviceOffline");
    expect(causeOfFailure(failure, true)).toBe("serverUnreachable");
    expect(causeOfFailure(failure, null)).toBe("serverUnreachable");
    expect(causeOfFailure(new NetworkError("timeout", 15_000), true)).toBe("serverUnreachable");
  });

  // 지키는 것: 길 위의 장비가 낸 5xx만 서버에 닿지 못함이다(모델의 선언 규칙과 같다). 우리 서버가 코드를 붙여 낸
  // 503은 아니다.
  it("502·504·코드 없는 503은 서버에 닿지 못함, 그 밖의 응답(4xx·500·코드 있는 503)은 원인 없음", () => {
    for (const status of [502, 504]) {
      expect(causeOfFailure(new ApiError(status, "bad gateway"), true)).toBe("serverUnreachable");
    }
    expect(causeOfFailure(new ApiError(503, "unavailable"), true)).toBe("serverUnreachable");
    expect(causeOfFailure(new ApiError(503, "no archive", "archive_not_configured"), true)).toBeNull();
    for (const status of [400, 403, 404, 409, 413, 429, 500]) {
      expect(causeOfFailure(new ApiError(status, "no"), true)).toBeNull();
    }
  });

  // 지키는 것: 응답이 온 실패는 기기가 꺼져 있다고 해서 오프라인이 되지 않는다(응답이 왔다는 것은 길이 있었다는 뜻).
  it("응답이 온 실패는 기기 상태와 무관하다", () => {
    expect(causeOfFailure(new ApiError(502, "bad gateway"), false)).toBe("serverUnreachable");
    expect(causeOfFailure(new ApiError(403, "forbidden"), false)).toBeNull();
  });

  it("알 수 없는 오류와 값은 원인 없음", () => {
    expect(causeOfFailure(new Error("boom"), false)).toBeNull();
    expect(causeOfFailure("x", true)).toBeNull();
    expect(causeOfFailure(undefined, true)).toBeNull();
  });
});

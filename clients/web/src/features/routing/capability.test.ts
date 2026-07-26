import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { NetworkError } from "@/lib/http";
import fixtures from "./routingFixtures.json";
import {
  SEND_UNSUPPORTED_REASON,
  UNSUPPORTED_REASON,
  isUnknownFieldRejection,
  learnedRoutingReason,
  noteRoutingUnsupported,
  resetLearnedRoutingSupport,
  verdictFromBody,
  verdictFromError,
  verdictFromSendProbe,
} from "./capability";

// =============================================================================
// capability 판정의 경계 (MOMO-626 §3 "서버 미반영 상태 정직성").
//
// 여기서 지키는 두 문장:
//   ① **못 물어본 것과 아니라고 들은 것은 다른 사실이다.** 404만 "지원하지
//      않습니다"가 되고, 401/403/네트워크/모르는 모양은 전부 "확인하지
//      못했습니다"로 남는다. 이 구분이 무너지면 로그인이 만료된 순간 화면이
//      "이 서버는 라우팅을 지원하지 않습니다"라고 거짓말한다.
//   ② **한 표면의 200이 다른 표면의 근거가 되지 않는다.** effort-table(MOMO-621)과
//      전송 표면 routing(MOMO-625)은 다른 커밋이고, 621만 올라간 서버가 실제로
//      존재한다. 그래서 전송 표면은 전송 표면에게 직접 물어본 답으로만 판정한다.
// =============================================================================

const SCOPE = "http://127.0.0.1:28000|00000000-0000-7000-8000-000000000001";
const OTHER_SCOPE = "https://momo.example|00000000-0000-7000-8000-000000000009";

beforeEach(() => {
  resetLearnedRoutingSupport();
});

describe("verdictFromBody", () => {
  it("아는 모양의 표는 ready", () => {
    const { verdict, table } = verdictFromBody(fixtures.effortTable);
    expect(verdict).toEqual({ support: "ready", reason: null });
    expect(table?.entries).toHaveLength(4);
  });

  it("200이지만 모르는 모양이면 absent가 아니라 unknown", () => {
    const { verdict, table } = verdictFromBody({ schema: "something.else" });
    expect(verdict.support).toBe("unknown");
    expect(verdict.reason).toContain("읽지 못했습니다");
    expect(table).toBeNull();
  });
});

describe("verdictFromError", () => {
  it("404/405/501만 '지원하지 않는다'로 읽는다", () => {
    for (const status of [404, 405, 501]) {
      expect(verdictFromError(new ApiError(status, "not found"))).toEqual({
        support: "absent",
        reason: UNSUPPORTED_REASON,
      });
    }
  });

  it("401/403은 권한 이야기이지 기능 유무가 아니다", () => {
    expect(verdictFromError(new ApiError(401, "unauthorized")).support).toBe("unknown");
    expect(verdictFromError(new ApiError(403, "forbidden")).support).toBe("unknown");
  });

  it("아무도 답하지 않았으면 그 문장을 그대로 쓴다", () => {
    const error = new NetworkError("timeout", 15_000);
    const verdict = verdictFromError(error);
    expect(verdict.support).toBe("unknown");
    expect(verdict.reason).toBe(error.message);
  });

  it("500은 기능이 없다는 뜻이 아니다", () => {
    expect(verdictFromError(new ApiError(500, "boom")).support).toBe("unknown");
  });
});

describe("verdictFromSendProbe", () => {
  // 프로브는 두 세대 모두가 반드시 거절하는 요청 하나다(없는 rootId + 유효하지
  // 않은 effort 토큰). 갈리는 지점은 "서버가 routing을 읽었는가" 하나뿐이다.
  it("서버가 routing을 이름으로 부르며 거절하면 그 블록을 읽은 것이다", () => {
    for (const message of [
      "routing.effort must be one of low, medium, high, xhigh, max",
      "routing contains unknown fields",
      "routing must be an object",
    ]) {
      expect(verdictFromSendProbe(new ApiError(400, message))).toEqual({
        support: "ready",
        reason: null,
      });
    }
  });

  it("routing을 건너뛰고 다음 검사로 넘어갔으면 조용히 버린 것이다", () => {
    // momowebqa(=main 형상) 실측 응답. 메시지는 만들어지지 않는다.
    const verdict = verdictFromSendProbe(new ApiError(404, "thread root not found"));
    expect(verdict.support).toBe("absent");
    expect(verdict.reason).toBe(SEND_UNSUPPORTED_REASON);
  });

  it("권한과 네트워크는 기능 유무에 대한 진술이 아니다", () => {
    expect(verdictFromSendProbe(new ApiError(403, "forbidden")).support).toBe("unknown");
    expect(verdictFromSendProbe(new ApiError(401, "unauthorized")).support).toBe("unknown");
    expect(verdictFromSendProbe(new ApiError(500, "boom")).support).toBe("unknown");
    expect(
      verdictFromSendProbe(new NetworkError("unreachable", 15_000)).support
    ).toBe("unknown");
  });

  it("프로브가 성공하면 우리가 서버를 잘못 읽은 것이므로 ready라고 하지 않는다", () => {
    expect(verdictFromSendProbe(null).support).toBe("unknown");
  });
});

describe("isUnknownFieldRejection", () => {
  it("closed-world 디코더의 '모르는 필드' 400을 잡는다", () => {
    expect(
      isUnknownFieldRejection(new ApiError(400, "unknown agent-profile field"))
    ).toBe(true);
    expect(
      isUnknownFieldRejection(new ApiError(400, "routing contains unknown fields"))
    ).toBe(true);
    expect(
      isUnknownFieldRejection(new ApiError(400, "unknown agent run request field"))
    ).toBe(true);
  });

  it("404는 '그 사이에 사라졌다'이지 '이 서버에 그 축이 없다'가 아니다", () => {
    // 프로필 PUT은 에이전트가 있다고 믿고 부르는 호출이다. 그 404를 축 강등으로
    // 읽으면 되돌릴 수 없는 오판이 남는다(R1 M3).
    expect(isUnknownFieldRejection(new ApiError(404, "agent profile not found"))).toBe(
      false
    );
  });

  it("정당한 게이트 거절은 강등 사유가 아니다", () => {
    // ADR-0134 D1: 허용목록 밖 모델은 400이지만 기능은 살아 있다.
    expect(
      isUnknownFieldRejection(
        new ApiError(
          400,
          "routing.model is not in workspace.settings.allowed_agent_models"
        )
      )
    ).toBe(false);
    expect(
      isUnknownFieldRejection(
        new ApiError(400, "routing.effort is not supported by model hermes-fast")
      )
    ).toBe(false);
    expect(isUnknownFieldRejection(new NetworkError("unreachable", 15_000))).toBe(false);
  });
});

describe("배운 판정 (learned downgrade)", () => {
  it("거절당하기 전에는 아무것도 배우지 않았다", () => {
    expect(learnedRoutingReason(SCOPE)).toBeNull();
  });

  it("한 번 거절당하면 그 서버에 대해 기억하고, 두 표면이 같은 판정을 공유한다", () => {
    // 프로브가 200을 준 서버에서도 쓰기는 거절될 수 있다: effort-table은 있는데
    // agent_profile.effort_pref writer는 없는 상태가 track/engine의 현재 모습이다.
    noteRoutingUnsupported(SCOPE);
    expect(learnedRoutingReason(SCOPE)).toBe(UNSUPPORTED_REASON);
    // 강등은 멱등이다: 두 번째 거절이 사유를 덮어쓰지 않는다.
    noteRoutingUnsupported(SCOPE);
    expect(learnedRoutingReason(SCOPE)).toBe(UNSUPPORTED_REASON);
  });

  it("다른 서버에는 물려주지 않는다", () => {
    // 로그아웃 후 다른 주소로 들어간 사람에게 앞 서버의 판정을 보여 주면, 그
    // 화면은 아무도 말한 적 없는 사실을 말하게 된다(R1 M5).
    noteRoutingUnsupported(SCOPE);
    expect(learnedRoutingReason(OTHER_SCOPE)).toBeNull();
    noteRoutingUnsupported(OTHER_SCOPE);
    expect(learnedRoutingReason(OTHER_SCOPE)).toBe(UNSUPPORTED_REASON);
    expect(learnedRoutingReason(SCOPE)).toBeNull();
  });

  it("리셋하면 다시 모르는 상태로 돌아간다", () => {
    noteRoutingUnsupported(SCOPE);
    resetLearnedRoutingSupport();
    expect(learnedRoutingReason(SCOPE)).toBeNull();
  });
});

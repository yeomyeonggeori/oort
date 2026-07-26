import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { NetworkError } from "@/lib/http";
import fixtures from "./routingFixtures.json";
import {
  UNSUPPORTED_REASON,
  isUnknownFieldRejection,
  learnedRoutingReason,
  noteRoutingUnsupported,
  resetLearnedRoutingSupport,
  verdictFromBody,
  verdictFromError,
} from "./capability";

// =============================================================================
// capability 판정의 경계 (MOMO-626 §3 "서버 미반영 상태 정직성").
//
// 여기서 지키는 한 문장: **못 물어본 것과 아니라고 들은 것은 다른 사실이다.**
// 404만 "지원하지 않습니다"가 되고, 401/403/네트워크/모르는 모양은 전부
// "확인하지 못했습니다"로 남는다. 이 구분이 무너지면 로그인이 만료된 순간
// 화면이 "이 서버는 라우팅을 지원하지 않습니다"라고 거짓말한다.
// =============================================================================

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
    expect(isUnknownFieldRejection(new ApiError(404, "no such route"))).toBe(true);
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
    expect(learnedRoutingReason()).toBeNull();
  });

  it("한 번 거절당하면 세션 동안 기억하고, 두 표면이 같은 판정을 공유한다", () => {
    // 프로브가 200을 준 서버에서도 쓰기는 거절될 수 있다: effort-table은 있는데
    // agent_profile.effort_pref writer는 없는 상태가 track/engine의 현재 모습이다
    // (ENGINE_HANDOFF X-14). 그래서 판정은 훅 밖에서도 읽히는 한 벌이어야 한다.
    noteRoutingUnsupported();
    expect(learnedRoutingReason()).toBe(UNSUPPORTED_REASON);
    // 강등은 멱등이다: 두 번째 거절이 사유를 덮어쓰지 않는다.
    noteRoutingUnsupported();
    expect(learnedRoutingReason()).toBe(UNSUPPORTED_REASON);
  });

  it("리셋하면 다시 모르는 상태로 돌아간다", () => {
    noteRoutingUnsupported();
    resetLearnedRoutingSupport();
    expect(learnedRoutingReason()).toBeNull();
  });
});

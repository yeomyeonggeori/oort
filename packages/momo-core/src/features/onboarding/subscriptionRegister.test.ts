import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  CALM_BADGE,
  agentHandleProblem,
  attachInstrument,
  calmDetail,
  calmLine,
  classifyRegisterFailure,
  confirmBullets,
  confirmCreateLabel,
  confirmTitle,
  defaultAgentHandle,
  doneDetail,
  handleToSend,
  isCalmRefusal,
  manualDetail,
  registerRequestBody,
} from "./subscriptionRegister";

describe("거절 분류는 문장이 아니라 error.code다", () => {
  it("Claude 기본 꺼짐과 킬 스위치를 코드로 가른다", () => {
    expect(
      classifyRegisterFailure(new ApiError(409, "x", "claude_subscription_agent_paused"))
    ).toBe("paused");
    expect(
      classifyRegisterFailure(new ApiError(409, "x", "subscription_agents_disabled"))
    ).toBe("disabled");
    expect(classifyRegisterFailure(new ApiError(409, "x", "subscription_agent_limit"))).toBe(
      "limit"
    );
    expect(
      classifyRegisterFailure(new ApiError(409, "x", "subscription_agent_cleanup_pending"))
    ).toBe("cleanup");
  });

  it("서버 문장이 바뀌어도 분류는 코드를 따른다", () => {
    expect(
      classifyRegisterFailure(
        new ApiError(409, "something entirely reworded", "claude_subscription_agent_paused")
      )
    ).toBe("paused");
    // 옛 문장만 있고 코드가 없으면 핸들 충돌로 읽는다(D15), 문장 정규식에 기대지 않는다.
    expect(
      classifyRegisterFailure(new ApiError(409, "claude subscription agents are paused"))
    ).toBe("handle-taken");
  });

  it("403은 차분한 안내, 400은 이름 칸, 그 밖은 실패", () => {
    expect(classifyRegisterFailure(new ApiError(403, "no"))).toBe("forbidden");
    expect(classifyRegisterFailure(new ApiError(400, "bad"))).toBe("invalid-name");
    expect(classifyRegisterFailure(new ApiError(500, "boom"))).toBe("other");
    expect(classifyRegisterFailure(new Error("net"))).toBe("other");
  });

  it("멈춤·꺼짐·권한·상한은 차분하고, 이름 충돌과 실패는 아니다", () => {
    for (const r of ["paused", "disabled", "forbidden", "limit", "cleanup"] as const) {
      expect(isCalmRefusal(r)).toBe(true);
    }
    for (const r of ["handle-taken", "invalid-name", "other"] as const) {
      expect(isCalmRefusal(r)).toBe(false);
    }
  });
});

describe("차분한 문구에는 오류 어휘가 없다", () => {
  const ERROR_WORDS = /실패|오류|에러|못했|문제|경고|잘못|거절|차단/;
  it("회색 · 문의 중 배지와 안내", () => {
    expect(CALM_BADGE.paused).toBe("회색 · 문의 중");
    for (const r of ["paused", "disabled", "forbidden", "limit", "cleanup"] as const) {
      for (const h of ["claude", "codex"] as const) {
        expect(calmLine(r, h)).not.toMatch(ERROR_WORDS);
        expect(calmDetail(r, h)).not.toMatch(ERROR_WORDS);
      }
    }
    expect(CALM_BADGE.paused).not.toMatch(ERROR_WORDS);
    expect(CALM_BADGE.disabled).not.toMatch(ERROR_WORDS);
  });

  it("멈춤 안내는 사람이 직접 쓰는 길만 말한다", () => {
    expect(calmDetail("paused", "claude")).toContain("터미널에서 직접");
    expect(calmLine("paused", "claude")).toBe(
      "이 서버에서는 Claude Code 구독 에이전트가 잠시 멈춰 있어요."
    );
  });
});

describe("이름", () => {
  it("기본 이름은 서버와 같은 규칙이다", () => {
    expect(defaultAgentHandle("claude", "Seongjae")).toBe("seongjae-claude");
    expect(defaultAgentHandle("codex", "성재")).toBe("my-codex");
    expect(defaultAgentHandle("claude", "a".repeat(40)).length).toBeLessThanOrEqual(32);
  });

  it("고치지 않으면 handle을 보내지 않는다(서버가 -2를 정한다)", () => {
    const base = {
      harness: "claude" as const,
      deviceId: "oort-abcdef012345",
      defaultHandle: "kim-claude",
    };
    expect(registerRequestBody({ ...base, typedHandle: "kim-claude" })).toEqual({
      harness: "claude_code",
      deviceId: "oort-abcdef012345",
    });
    expect(registerRequestBody({ ...base, typedHandle: "@Kim-Claude " })).toEqual({
      harness: "claude_code",
      deviceId: "oort-abcdef012345",
    });
    expect(handleToSend("sj-bot", "kim-claude")).toBe("sj-bot");
    expect(
      registerRequestBody({ ...base, typedHandle: "sj-bot", deviceLabel: "mbp" })
    ).toEqual({
      harness: "claude_code",
      deviceId: "oort-abcdef012345",
      deviceLabel: "mbp",
      handle: "sj-bot",
    });
  });

  it("이름 칸 검사는 서버 is_valid_handle과 같다", () => {
    expect(agentHandleProblem("ok_name-1")).toBeNull();
    expect(agentHandleProblem("")).not.toBeNull();
    expect(agentHandleProblem("a")).not.toBeNull();
    expect(agentHandleProblem("a".repeat(33))).not.toBeNull();
    expect(agentHandleProblem("성재-claude")).not.toBeNull();
    expect(agentHandleProblem("has space")).not.toBeNull();
  });
});

describe("문장", () => {
  it("질문은 시안 문장이고 조사가 맞다", () => {
    expect(confirmTitle("claude", "sj-claude")).toBe(
      "이 맥의 Claude Code를 @sj-claude로 부를 수 있게 할까요?"
    );
    // 라틴 글자는 받침 없음으로 읽는다(저장소 규칙, koreanParticle).
    expect(confirmTitle("codex", "sj-bot")).toBe(
      "이 맥의 Codex를 @sj-bot로 부를 수 있게 할까요?"
    );
    expect(attachInstrument("영일")).toBe("영일로");
    expect(attachInstrument("성재")).toBe("성재로");
    expect(attachInstrument("한솔")).toBe("한솔로");
    expect(attachInstrument("김밥")).toBe("김밥으로");
    expect(confirmCreateLabel("sj-claude")).toBe("@sj-claude 만들기");
  });

  it("상시 줄: 로그인 정보는 저장하지 않는다, 나만 부른다, 비용은 내 구독", () => {
    const bullets = confirmBullets("claude").join("\n");
    expect(bullets).toContain("로그인 정보는 oort에 저장하지 않아요.");
    expect(bullets).toContain("나만 부를 수 있어요.");
    expect(bullets).toContain("내 Claude Code 구독");
  });

  it("사용자 문장에 줄표와 들뜬 말이 없다", () => {
    const all = [
      ...confirmBullets("claude"),
      ...confirmBullets("codex"),
      doneDetail("claude"),
      manualDetail("codex", "codex"),
      manualDetail("claude", "cli-failed"),
      manualDetail("claude", "cli-missing"),
      manualDetail("claude", "unsupported"),
      calmDetail("paused", "claude"),
      calmDetail("disabled", "codex"),
    ].join("\n");
    expect(all).not.toMatch(/[—–]/);
    expect(all).not.toMatch(/원활|손쉽|매끄러/);
  });
});

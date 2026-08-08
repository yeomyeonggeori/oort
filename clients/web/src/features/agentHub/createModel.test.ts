import { describe, expect, it } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  agentBaseUrlIssue,
  agentDisplayNameIssue,
  agentHandleIssue,
  agentModelIssue,
  canCreateAgent,
  canCreateAgentNow,
  createAgentFailure,
  instructionsIssue,
  normalizeAgentHandle,
} from "./createModel";

describe("에이전트 만들기 검증", () => {
  it("핸들을 서버의 알파벳과 길이 그대로 판정한다", () => {
    expect(agentHandleIssue("kim-intern")).toBeNull();
    expect(agentHandleIssue("  KIM_Intern2 ")).toBeNull();
    expect(normalizeAgentHandle("  KIM_Intern2 ")).toBe("kim_intern2");
    expect(agentHandleIssue("")).toBe("required");
    expect(agentHandleIssue("a")).toBe("length");
    expect(agentHandleIssue("a".repeat(33))).toBe("length");
    // 한글 핸들은 "너무 짧다"가 아니라 "쓸 수 없는 글자"다: 두 글자여도
    // 알파벳에서 먼저 걸려야 고칠 방법을 알려 주는 문장이 나온다.
    expect(agentHandleIssue("인턴")).toBe("unsupportedCharacters");
    expect(agentHandleIssue("kim intern")).toBe("unsupportedCharacters");
  });

  it("표시 이름과 모델은 바이트가 아니라 글자로 잰다", () => {
    expect(agentDisplayNameIssue("김인턴")).toBeNull();
    // 100 Korean characters is 300 bytes and still legal (server counts chars).
    expect(agentDisplayNameIssue("가".repeat(100))).toBeNull();
    expect(agentDisplayNameIssue("가".repeat(101))).toBe("tooLong");
    expect(agentDisplayNameIssue("   ")).toBe("required");
    expect(agentModelIssue("hermes-agent")).toBeNull();
    expect(agentModelIssue("m".repeat(201))).toBe("tooLong");
  });

  it("게이트웨이 주소는 서버의 네 가지 거절을 그대로 가른다", () => {
    expect(agentBaseUrlIssue("https://gw.example.com/v1")).toBeNull();
    // 루프백은 이 클라이언트가 판정하지 않는다: 허용 여부가 서버 환경 변수라
    // 여기서 막으면 로컬 개발을 클라가 금지하는 정책이 된다.
    expect(agentBaseUrlIssue("http://localhost:8080/v1")).toBeNull();
    expect(agentBaseUrlIssue("http://127.0.0.1:8080")).toBeNull();

    expect(agentBaseUrlIssue("")).toBe("required");
    expect(agentBaseUrlIssue("gw.example.com/v1")).toBe("shape");
    expect(agentBaseUrlIssue("https://user:pw@gw.example.com/v1")).toBe("shape");
    expect(agentBaseUrlIssue("https://gw.example.com/v1?key=sk-live")).toBe("shape");
    expect(agentBaseUrlIssue("https://gw.example.com/v1#tail")).toBe("shape");
    expect(agentBaseUrlIssue("ftp://gw.example.com")).toBe("scheme");
    expect(agentBaseUrlIssue("https://MOCK-provider.example.com")).toBe("mockHost");
    expect(agentBaseUrlIssue("http://gw.example.com/v1")).toBe("plaintextRemote");
  });

  it("지시문은 UTF-8 바이트로 잰다", () => {
    expect(instructionsIssue("가".repeat(2_730))).toBeNull(); // 8,190 bytes
    expect(instructionsIssue("가".repeat(2_731))).toBe("tooLong"); // 8,193 bytes
  });
});

describe("만들 수 있는 사람", () => {
  it("사람인 오너·관리자만 만들 수 있고, 역할이 없으면 서버가 답하게 둔다", () => {
    expect(canCreateAgent("human", "owner")).toBe(true);
    expect(canCreateAgent("human", "admin")).toBe(true);
    expect(canCreateAgent("human", "member")).toBe(false);
    expect(canCreateAgent("human", "guest")).toBe(false);
    expect(canCreateAgent("human", undefined)).toBe(true);
    // require_human은 역할보다 먼저 선다.
    expect(canCreateAgent("agent", "owner")).toBe(false);
  });

  it("명부가 오기 전에는 제안하지 않는다", () => {
    expect(canCreateAgentNow(false, "human", "owner")).toBe(false);
    expect(canCreateAgentNow(true, "human", "owner")).toBe(true);
  });
});

describe("거절을 어느 상자에 붙이나", () => {
  it("409는 핸들 상자로 간다", () => {
    const failure = createAgentFailure(
      new ApiError(409, "agent handle already exists")
    );
    expect(failure.field).toBe("handle");
    expect(failure.message).toContain("핸들");
  });

  it("400은 서버가 이름을 부른 그 필드로 간다", () => {
    expect(
      createAgentFailure(new ApiError(400, "baseUrl must use http:// or https://"))
        .field
    ).toBe("baseUrl");
    expect(
      createAgentFailure(new ApiError(400, "model must contain 1...200 characters"))
        .field
    ).toBe("model");
    expect(
      createAgentFailure(new ApiError(400, "handle is required")).field
    ).toBe("handle");
    // 알아보지 못하는 400은 폼 전체에 붙는다. 아무 상자에나 붙이지 않는다.
    expect(
      createAgentFailure(new ApiError(400, "config must be a JSON object")).field
    ).toBeNull();
  });

  it("404는 다시 시도하라고 말하지 않는다", () => {
    const failure = createAgentFailure(new ApiError(404, "not found"));
    expect(failure.field).toBeNull();
    expect(failure.message).toContain("아직");
    expect(failure.message).not.toContain("다시 시도");
  });

  it("서버 영어 원문을 사람에게 그대로 옮기지 않는다", () => {
    for (const status of [400, 403, 409, 429, 500]) {
      const failure = createAgentFailure(new ApiError(status, "internal error"));
      expect(failure.message).not.toContain("internal error");
    }
  });

  it("전송이 답을 못 받은 경우에는 전송 계층의 문장을 그대로 쓴다", () => {
    const cause = new NetworkError("timeout", 15_000);
    const failure = createAgentFailure(cause);
    // 데드라인 초 수가 든 그 문장 그대로. 여기서 두 번째 어휘를 만들지 않는다.
    expect(failure.message).toContain(cause.message);
    expect(failure.message).toContain("15초");
  });
});

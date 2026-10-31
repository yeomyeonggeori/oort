import { afterEach, describe, expect, it, vi } from "vitest";
import { browserLaunchBlocked } from "./agentSandbox";

// 격리 표시가 있으면 브라우저 시험이 브라우저를 띄우지 않는다(#4861). 마지막 시험은 엔진이 설치된
// 컴퓨터에서만 RED가 될 수 있다 — 엔진이 없는 CI에서는 가드가 없어도 목록이 비기 때문이다.
const ORIGINAL = process.env.CODEX_SANDBOX;

describe("에이전트 격리와 브라우저 시험", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (ORIGINAL === undefined) delete process.env.CODEX_SANDBOX;
    else process.env.CODEX_SANDBOX = ORIGINAL;
  });

  it("격리 표시가 있으면 띄우지 않을 이유를 돌려준다", () => {
    vi.stubEnv("CODEX_SANDBOX", "seatbelt");
    expect(browserLaunchBlocked()).toContain("CODEX_SANDBOX=seatbelt");
  });

  it("격리 표시가 없으면 막지 않는다", () => {
    delete process.env.CODEX_SANDBOX;
    expect(browserLaunchBlocked()).toBeNull();
  });

  it("격리 안에서는 공용 엔진 목록이 비어 브라우저 시험이 건너뛴다", async () => {
    vi.stubEnv("CODEX_SANDBOX", "seatbelt");
    const { ENGINES } = await import("@/design/appearance/compileTokensTestKit");
    expect(ENGINES).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOSTED_PRESETS } from "@momo/core/features/hostedAgents/presets";
import {
  DETECT_CAP_MS,
  DETECT_INITIAL_MS,
  DETECT_MAX_DELAY_MS,
  FIRST_AGENT_CAP_COPY,
  FIRST_AGENT_CARDS,
  FIRST_AGENT_CONNECTED_CLAIM,
  FIRST_AGENT_DETECTING_DETAIL,
  FIRST_AGENT_DETECTING_HEADLINE,
  FIRST_AGENT_STAGE_ORDER,
  copyClaimsConnected,
  firstAgentCardsUseHostedPresets,
  isHostedDetected,
  nextDetectDelayMs,
  parseFirstAgentCapturePose,
  shouldAutoPass,
  type DetectDelay,
} from "./firstAgent";

function src(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("첫 에이전트 카드 4종", () => {
  it("카드가 넷이고 Grok·generic 문구는 HOSTED_PRESETS 를 쓴다", () => {
    expect(FIRST_AGENT_CARDS).toHaveLength(4);
    expect(FIRST_AGENT_CARDS.map((card) => card.id)).toEqual([
      "claude-code",
      "codex",
      "grok",
      "openai-compat",
    ]);
    expect(firstAgentCardsUseHostedPresets()).toBe(true);
    const grok = HOSTED_PRESETS.find((preset) => preset.id === "grok");
    expect(grok?.verified).toBe(false);
    expect(grok?.unverifiedNote).toBeTruthy();
    expect(FIRST_AGENT_CARDS[2]?.detail).toContain(grok?.unverifiedNote ?? "");
  });
});

describe("로그인 뒤 first-run 순서", () => {
  it("렌더 계약은 킥오프 → 첫 에이전트 → 폰 연결이다", () => {
    expect(FIRST_AGENT_STAGE_ORDER).toEqual([
      "kickoff",
      "first-agent",
      "phone-link",
    ]);
  });
});

describe("자동 통과", () => {
  it("연결이 하나라도 있으면 통과한다", () => {
    expect(shouldAutoPass([])).toBe(false);
    expect(shouldAutoPass([{ status: "expired" }])).toBe(false);
    expect(shouldAutoPass([{ status: "pairing_pending" }])).toBe(true);
    expect(shouldAutoPass([{ status: "detected" }])).toBe(true);
    expect(shouldAutoPass([{ status: "active" }])).toBe(true);
  });
});

describe("감지는 서버 상태만 본다", () => {
  it("detected 와 active 만 감지다", () => {
    expect(isHostedDetected("pairing_pending")).toBe(false);
    expect(isHostedDetected("detected")).toBe(true);
    expect(isHostedDetected("active")).toBe(true);
  });

  it("감지 문장은 연결됨을 말하지 않는다", () => {
    expect(copyClaimsConnected(FIRST_AGENT_DETECTING_HEADLINE)).toBe(false);
    expect(copyClaimsConnected(FIRST_AGENT_DETECTING_DETAIL)).toBe(false);
    expect(copyClaimsConnected(FIRST_AGENT_CAP_COPY)).toBe(false);
    expect(FIRST_AGENT_CAP_COPY).toBe(
      "아직 감지되지 않았습니다. 설정 › 연결 › 에이전트 자격에서 이어갈 수 있습니다."
    );
    expect(FIRST_AGENT_CAP_COPY).not.toMatch(/[—–]/);
  });
});

describe("폴링 상한", () => {
  it("상한에 닿으면 cap 이다", () => {
    expect(nextDetectDelayMs(0, 0)).toBe(DETECT_INITIAL_MS);
    expect(nextDetectDelayMs(0, 4)).toBe(DETECT_MAX_DELAY_MS);
    expect(nextDetectDelayMs(DETECT_CAP_MS, 0)).toBe("cap");
    expect(nextDetectDelayMs(DETECT_CAP_MS + 1, 99)).toBe("cap");
  });
});

describe("사보타주 ③ 폴링 상한을 빼면 붉다", () => {
  it("상한 없는 대기는 숫자를 계속 돌려 무한 폴링이 된다", () => {
    const withoutCap = (elapsedMs: number, attempt: number): DetectDelay => {
      void elapsedMs;
      return Math.min(
        DETECT_INITIAL_MS * 2 ** Math.max(0, attempt),
        DETECT_MAX_DELAY_MS
      );
    };
    expect(nextDetectDelayMs(DETECT_CAP_MS, 0)).toBe("cap");
    expect(withoutCap(DETECT_CAP_MS, 0)).not.toBe("cap");
    expect(src("./firstAgent.ts")).toContain("if (elapsedMs >= DETECT_CAP_MS) return \"cap\"");
  });
});

describe("사보타주 ② 서버 전에 연결됨을 말하면 붉다", () => {
  it("감지 카피가 연결됨을 포함하면 이 단정이 실패한다", () => {
    expect(FIRST_AGENT_CONNECTED_CLAIM).toBe("연결됨");
    expect(copyClaimsConnected("연결됨")).toBe(true);
    expect(copyClaimsConnected(FIRST_AGENT_DETECTING_HEADLINE)).toBe(false);
    const stage = src("./FirstAgentStage.tsx");
    expect(stage).not.toContain(FIRST_AGENT_CONNECTED_CLAIM);
  });
});

describe("캡처 포즈", () => {
  it("다섯 포즈만 받는다", () => {
    expect(parseFirstAgentCapturePose("cards")).toBe("cards");
    expect(parseFirstAgentCapturePose("one-time")).toBe("one-time");
    expect(parseFirstAgentCapturePose("detecting")).toBe("detecting");
    expect(parseFirstAgentCapturePose("cap-exceeded")).toBe("cap-exceeded");
    expect(parseFirstAgentCapturePose("done")).toBe("done");
    expect(parseFirstAgentCapturePose("wizard")).toBeNull();
  });
});

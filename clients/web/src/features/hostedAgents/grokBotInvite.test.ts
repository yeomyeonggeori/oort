import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function src(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("T-5 그록봇 초대 표면은 수동적 감지와 기존 위저드만 쓴다", () => {
  const invite = src("./GrokBotInvite.tsx");
  const wizard = src("./HostedAgentWizard.tsx");
  const probe = src("./useHostedAgentProbe.ts");
  const launch = src("./hostedWizardLaunch.ts");

  it("CDP·포트 스캔·devtools 를 부르지 않는다", () => {
    for (const file of [invite, wizard, probe, launch]) {
      expect(file).not.toMatch(/CDP|9222|devtools|chrome-debugging/i);
      expect(file).not.toMatch(/localhost:\d+/);
    }
  });

  it("비밀값을 저장소나 로그에 넣지 않는다", () => {
    expect(launch).not.toMatch(/pairingCredential|credential:/);
    expect(invite).not.toMatch(/console\.(log|warn|error|debug)/);
    expect(probe).not.toMatch(/console\.(log|warn|error|debug)/);
    expect(invite).not.toMatch(/localStorage\s*\./);
  });

  it("위저드 단계 목록을 다시 정의하지 않는다", () => {
    expect(wizard).toContain("HOSTED_WIZARD_STEPS");
    expect(invite).not.toContain("HOSTED_WIZARD_STEPS");
    expect(wizard).toContain("PAIRING_NATURAL_LANGUAGE_HANDOFF");
    expect(wizard).toContain("GROK_PAIRING_PURPOSE");
    expect(wizard).toContain("GROK_PAIRING_REVEAL_HEADLINE");
  });

  it("원클릭 자동 발급은 열림 시점 online 에서만 소비한다", () => {
    expect(wizard).toContain("decideAutoAdvance");
    expect(wizard).toContain("initialAutoAdvanceArmed");
    expect(wizard).toContain("autoAdvanceArmedRef");
  });

  it("자동 발급 스켈레톤은 자동 시도 진행에만 묶인다", () => {
    expect(wizard).toMatch(/advancingToPairing = autoAdvancePending && pairing === null/);
    expect(wizard).not.toMatch(/advancingToPairing =\s*\n\s*launch\?\.autoAdvance !== undefined/);
  });

  it("오프라인이고 목록이 없으면 스켈레톤 대신 침묵한다", () => {
    expect(invite).toContain("if (list.isPending)");
    expect(invite).toContain("if (offline) return null");
    expect(invite).not.toContain("grokbot-invite-offline");
  });

  it("순수 웹은 프로브를 호출하지 않는다", () => {
    expect(probe).toContain("if (!desktop)");
    expect(probe).toContain("detectHostedAgents");
  });
});

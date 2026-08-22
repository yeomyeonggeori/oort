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
  });

  it("순수 웹은 프로브를 호출하지 않는다", () => {
    expect(probe).toContain("if (!desktop)");
    expect(probe).toContain("detectHostedAgents");
  });
});

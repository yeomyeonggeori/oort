import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function src(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("T-6 첫 왕복 표면은 위저드에 이어 붙기만 한다", () => {
  const surface = src("./FirstMentionOnboarding.tsx");
  const wizard = src("./HostedAgentWizard.tsx");
  const invite = src("./GrokBotInvite.tsx");
  const launch = src("./hostedWizardLaunch.ts");

  it("위저드 단계 목록과 원클릭 초대를 다시 정의하지 않는다", () => {
    expect(surface).not.toContain("HOSTED_WIZARD_STEPS");
    expect(surface).not.toContain("planHostedInvite");
    expect(invite).not.toContain("FirstMentionOnboarding");
    expect(launch).not.toContain("firstMention");
  });

  it("네 상태와 에이전트 뱃지가 실존한다", () => {
    expect(surface).toContain("first-mention-agent-badge");
    expect(surface).toContain("FIRST_MENTION_AGENT_BADGE");
    expect(surface).toContain("first-mention-offline");
    expect(surface).toContain("first-mention-error");
    expect(surface).toContain('data-phase={surface.phase}');
    expect(surface).toContain("SkeletonRows");
    expect(surface).toContain("InlineBanner");
  });

  it("비밀값과 CDP 를 부르지 않는다", () => {
    expect(surface).not.toMatch(/pairingCredential|credential:/);
    expect(surface).not.toMatch(/console\.(log|warn|error|debug)/);
    expect(surface).not.toMatch(/CDP|9222|devtools/i);
    expect(wizard).toContain("firstMention=");
  });

  it("인라인 배너로 오류를 그리고 카드 스택을 쓰지 않는다", () => {
    expect(surface).toContain("InlineBanner");
    expect(surface).not.toContain("Card");
  });
});

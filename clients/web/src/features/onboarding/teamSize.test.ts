import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const authRoot = fileURLToPath(new URL("../auth", import.meta.url));
const onboardingRoot = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (/\.test\.(ts|tsx)$/.test(entry)) return [];
    if (!/\.(ts|tsx)$/.test(entry)) return [];
    return [path];
  });
}

describe("onboarding copy: 팀 규모 질문 0 (ADR-0185 D-A)", () => {
  it("features/auth 와 features/onboarding 에 팀 규모 문구가 없다", () => {
    const files = [...sourceFiles(authRoot), ...sourceFiles(onboardingRoot)];
    const hits: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (/팀 규모|team size/i.test(source)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});

describe("issued invite code stays off the console", () => {
  it("S2 and the shared invite helpers never console.log", () => {
    const files = [
      fileURLToPath(new URL("./InviteStage.tsx", import.meta.url)),
      fileURLToPath(new URL("./OwnerOnboarding.tsx", import.meta.url)),
      fileURLToPath(new URL("./WorkspaceProfileStage.tsx", import.meta.url)),
      fileURLToPath(new URL("../settings/useIssueInvite.ts", import.meta.url)),
      fileURLToPath(new URL("../settings/IssuedInviteCard.tsx", import.meta.url)),
    ];
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /\bconsole\.(log|info|debug|dir)\b/
      );
    }
  });
});

describe("issued invite card Korean keep-all (#2356 M-2b)", () => {
  it("both shared sentences carry break-keep so 화면에서만 cannot split", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../settings/IssuedInviteCard.tsx", import.meta.url)),
      "utf8"
    );
    expect(source).toContain("화면에서만");
    expect(source).not.toMatch(/화면에서\s*\n\s*만/);
    const tags = [...source.matchAll(/<p className="([^"]*)">/g)].map(
      (match) => match[1]
    );
    expect(tags.length).toBe(2);
    expect(tags.every((cls) => cls.split(/\s+/).includes("break-keep"))).toBe(
      true
    );
  });
});

describe("S2 skip does not issue", () => {
  it("skip 버튼 onClick 은 handleSkipClick 만 부르고 발급을 넣지 않는다", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./InviteStage.tsx", import.meta.url)),
      "utf8"
    );
    expect(source).toContain("function handleSkipClick");
    const start = source.indexOf("function handleSkipClick");
    const body = source.slice(start, source.indexOf("export function InviteStage"));
    expect(body).toContain("onSkip();");
    expect(body).not.toContain("handleIssue");
    expect(body).not.toContain("mutate");
    expect(body).not.toContain("createInvite");
    const skipAt = source.indexOf('data-testid="onboarding-s2-skip"');
    expect(skipAt).toBeGreaterThan(0);
    const buttonStart = source.lastIndexOf("<Button", skipAt);
    const skipButton = source.slice(buttonStart, skipAt + 40);
    expect(skipButton).toContain("handleSkipClick(onSkip)");
    expect(skipButton).not.toContain("handleIssue");
    expect(skipButton).not.toContain("create.mutate");
    expect(skipButton).not.toContain("createInvite");
  });
});

describe("S1 error copy and identity handoff (H-1/H-2)", () => {
  it("never paints error.message and always calls replaceSessionMember", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./WorkspaceProfileStage.tsx", import.meta.url)),
      "utf8"
    );
    expect(source).not.toMatch(/setHandleError\(error\.message\)/);
    expect(source).not.toMatch(/setWorkspaceError\(error\.message\)/);
    expect(source).not.toMatch(/setDisplayError\(error\.message\)/);
    expect(source).not.toMatch(/setFormError\(error\.message\)/);
    expect(source).toContain("replaceSessionMember(member)");
  });
});

describe("S1 stale 409 shares the settings component", () => {
  it("S1 and settings both mount StaleWorkspaceNameConflict", () => {
    const s1 = readFileSync(
      fileURLToPath(new URL("./WorkspaceProfileStage.tsx", import.meta.url)),
      "utf8"
    );
    const settings = readFileSync(
      fileURLToPath(new URL("../settings/WorkspaceSection.tsx", import.meta.url)),
      "utf8"
    );
    expect(s1).toContain("StaleWorkspaceNameConflict");
    expect(settings).toContain("StaleWorkspaceNameConflict");
    expect(s1).not.toContain("S1_KEEP_THEIRS");
    expect(s1).toContain("refetchWorkspaceToken(true)");
    expect(settings).not.toContain("setDraft(latest.name)");
    const copy = readFileSync(
      fileURLToPath(new URL("./StaleWorkspaceNameConflict.tsx", import.meta.url)),
      "utf8"
    );
    expect(copy).toContain("directionParticle");
    expect(copy).not.toMatch(/」으로/);
    expect(copy).not.toMatch(/whitespace-nowrap[^>]*>\s*「\{otherName\}/);
    expect(copy).toContain("whitespace-nowrap");
    expect(s1).toContain("staleName ? S1_STALE_MESSAGE_ID");
  });
});

describe("settings doors record the S1 flag (M-R3-5)", () => {
  it("each section calls recordOwnerOnboardingSettingsSave for its door", () => {
    const workspace = readFileSync(
      fileURLToPath(new URL("../settings/WorkspaceSection.tsx", import.meta.url)),
      "utf8"
    );
    const profile = readFileSync(
      fileURLToPath(new URL("../settings/ProfileSection.tsx", import.meta.url)),
      "utf8"
    );
    expect(workspace).toContain('recordOwnerOnboardingSettingsSave("workspace")');
    expect(profile).toContain('recordOwnerOnboardingSettingsSave("profile")');
  });
});

describe("S2 naming shares settings invite labels (#2356 M-9)", () => {
  it("S2 issue CTA is assigned the settings constant, not a second literal", () => {
    const s2 = readFileSync(
      fileURLToPath(new URL("./s2Copy.ts", import.meta.url)),
      "utf8"
    );
    expect(s2).toMatch(/S2_PRIMARY_LABEL = INVITE_CREATE_LABEL/);
    expect(s2).not.toMatch(/S2_PRIMARY_LABEL = "/);
    const settings = readFileSync(
      fileURLToPath(new URL("../settings/InviteSection.tsx", import.meta.url)),
      "utf8"
    );
    expect(settings).toContain(
      '{create.isPending ? "만드는 중" : INVITE_CREATE_LABEL}'
    );
    const labels = readFileSync(
      fileURLToPath(new URL("../settings/inviteLabels.ts", import.meta.url)),
      "utf8"
    );
    expect(labels).toContain('export const INVITE_CREATE_LABEL = "초대 링크 만들기"');
    expect(labels).toContain('export const INVITE_COPY_CARD_LABEL = "초대 카드 복사"');
  });

  it("issued card copy control uses INVITE_COPY_CARD_LABEL on both modes", () => {
    const card = readFileSync(
      fileURLToPath(new URL("../settings/IssuedInviteCard.tsx", import.meta.url)),
      "utf8"
    );
    expect(card).toContain("label={INVITE_COPY_CARD_LABEL}");
    expect(card).not.toMatch(/label="링크 복사"/);
    expect(card).not.toMatch(/label="초대 카드 복사"/);
  });
});

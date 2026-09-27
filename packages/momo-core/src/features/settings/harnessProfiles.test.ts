import { describe, expect, it } from "vitest";
import {
  PROFILE_LABEL_MAX,
  destructiveActionLabel,
  myAccountRowTitle,
  myAccountRows,
  normalizeProfileList,
  normalizeRemoveOutcome,
  parseHiddenDefaults,
  profileLabelProblem,
  serializeHiddenDefaults,
  unlinkAfterExit,
  unlinkAfterRemove,
  unlinkDialogBody,
  unlinkDialogTitle,
  unlinkFailedDetail,
  type UnlinkFailure,
} from "./harnessProfiles";

describe("라벨 (셸 check_label과 같은 규칙)", () => {
  it("한 폴더 이름만 받는다", () => {
    for (const ok of ["개인", "회사", "work-2", "Team (Max)", "가".repeat(PROFILE_LABEL_MAX)]) {
      expect(profileLabelProblem(ok), ok).toBeNull();
    }
    for (const bad of ["", "  ", ".", "..", ".hidden", "a/b", "../x", "/tmp/x", "a\\b", "a:b", " 개인", "개인 ", "a\nb", "가".repeat(PROFILE_LABEL_MAX + 1)]) {
      expect(profileLabelProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(profileLabelProblem("회사", ["회사"])).toBe("이 이름의 계정이 이미 있어요.");
  });

  it("목록 정규화는 모양이 틀리거나 하네스가 모르는 줄을 버린다", () => {
    expect(
      normalizeProfileList([
        { harness: "claude", label: "회사" },
        { harness: "grok", label: "x" },
        { harness: "codex", label: "../x" },
        { harness: "codex", label: 3 },
        null,
        { harness: "codex", label: "개인", path: "/ignored" },
      ])
    ).toEqual([
      { harness: "claude", label: "회사" },
      { harness: "codex", label: "개인" },
    ]);
    expect(normalizeProfileList("nope")).toEqual([]);
  });

  it("셸 삭제 결과는 모르는 값을 「모름」(폴더가 남음)으로 읽는다", () => {
    expect(normalizeRemoveOutcome("removed")).toBe("removed");
    expect(normalizeRemoveOutcome("still_signed_in")).toBe("still_signed_in");
    expect(normalizeRemoveOutcome("Removed")).toBe("unknown");
    expect(normalizeRemoveOutcome(undefined)).toBe("unknown");
  });
});

describe("내 계정 줄", () => {
  const probes = [
    { id: "claude" as const, installed: true, auth: "logged_in" as const },
    { id: "codex" as const, installed: false, auth: "unknown" as const },
  ];

  it("기본 로그인(설치된 CLI) 뒤에 프로필이 하네스·라벨 순서로 선다", () => {
    const rows = myAccountRows({
      probes,
      profiles: [
        { harness: "codex", label: "개인" },
        { harness: "claude", label: "회사" },
        { harness: "claude", label: "개인" },
      ],
      hiddenDefaults: [],
    });
    expect(rows.map((row) => row.key)).toEqual([
      "default:claude",
      "profile:claude/개인",
      "profile:claude/회사",
      // CLI가 없어도 폴더가 있는 프로필은 남는다.
      "profile:codex/개인",
    ]);
    expect(rows.map(myAccountRowTitle)).toEqual(["Claude", "Claude · 개인", "Claude · 회사", "ChatGPT · 개인"]);
  });

  it("목록에서 뺀 기본 로그인은 서지 않고, 프로필에는 영향이 없다", () => {
    const rows = myAccountRows({
      probes,
      profiles: [{ harness: "claude", label: "회사" }],
      hiddenDefaults: ["claude"],
    });
    expect(rows.map((row) => row.key)).toEqual(["profile:claude/회사"]);
  });

  it("뺀 목록 저장값은 알려진 하네스만 읽는다", () => {
    expect(parseHiddenDefaults(null)).toEqual([]);
    expect(parseHiddenDefaults("not json")).toEqual([]);
    expect(parseHiddenDefaults('["codex","grok","claude"]')).toEqual(["claude", "codex"]);
    expect(serializeHiddenDefaults(["codex", "claude"])).toBe('["claude","codex"]');
  });
});

describe("해제 문장 (시안 §3 · 이슈 결정)", () => {
  it("oort 프로필: 제목과 본문이 시안 그대로, 단추는 「연결 해제」", () => {
    const row = { harness: "claude" as const, profile: "개인" };
    expect(unlinkDialogTitle(row)).toBe("Claude · 개인 연결을 해제할까요?");
    expect(unlinkDialogBody(row)).toBe(
      "이 계정 전용 폴더의 로그인을 Claude Code로 로그아웃하고 목록에서 뺍니다. 터미널에서 쓰던 claude 로그인은 그대로예요."
    );
    expect(destructiveActionLabel(row)).toBe("연결 해제");
  });

  it("이 맥의 기본 로그인: 「목록에서 빼기」, 로그아웃하지 않는다고 말한다", () => {
    const row = { harness: "codex" as const, profile: null };
    expect(destructiveActionLabel(row)).toBe("목록에서 빼기");
    expect(unlinkDialogBody(row)).toContain("로그아웃하지 않아요");
    expect(unlinkDialogBody(row)).toContain("터미널에서 쓰던 codex 로그인은 그대로예요");
  });

  it("실패 설명은 모두 폴더가 남았다고(또는 남는다고) 말한다", () => {
    const reasons: UnlinkFailure[] = ["logout-failed", "still-signed-in", "unknown", "spawn", "timeout", "remove-failed"];
    for (const reason of reasons) {
      expect(unlinkFailedDetail("claude", reason), reason).toMatch(/폴더/);
    }
  });
});

describe("해제 순서 (ADR-0190 D3-f)", () => {
  it("로그아웃 종료 코드 0만 폴더 정리로 간다", () => {
    expect(unlinkAfterExit({ code: 0, signal: null })).toEqual({ phase: "removing" });
    for (const exit of [
      { code: 1, signal: null },
      { code: null, signal: "SIGHUP" },
      { code: 0, signal: "SIGKILL" },
      null,
    ]) {
      expect(unlinkAfterExit(exit)).toEqual({ phase: "failed", reason: "logout-failed" });
    }
  });

  it("셸이 지웠을 때만 끝이다", () => {
    expect(unlinkAfterRemove("removed")).toEqual({ phase: "done" });
    expect(unlinkAfterRemove("still_signed_in")).toEqual({ phase: "failed", reason: "still-signed-in" });
    expect(unlinkAfterRemove("unknown")).toEqual({ phase: "failed", reason: "unknown" });
  });
});

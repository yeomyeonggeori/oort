import { describe, expect, it } from "vitest";
import { GIT_READ_COMMANDS, normalizeGitReadResult } from "./gitRead";

describe("normalizeGitReadResult", () => {
  it("셸의 세 모양을 그대로 받는다", () => {
    expect(
      normalizeGitReadResult({ outcome: "ok", value: { kind: "aheadBehind", behind: 1, ahead: 2 } })
    ).toEqual({ outcome: "ok", value: { kind: "aheadBehind", behind: 1, ahead: 2 } });
    expect(normalizeGitReadResult({ outcome: "noUpstream" })).toEqual({ outcome: "noUpstream" });
    expect(normalizeGitReadResult({ outcome: "unknown" })).toEqual({ outcome: "unknown" });
  });

  it("모르는 모양은 확인 못 함이다", () => {
    for (const raw of [null, undefined, "ok", [], { outcome: "ok" }, { outcome: "ok", value: {} }, { outcome: "stdout" }]) {
      expect(normalizeGitReadResult(raw)).toEqual({ outcome: "unknown" });
    }
  });

  it("명령 번호는 여덟 개다", () => {
    expect(GIT_READ_COMMANDS).toEqual(["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"]);
  });
});

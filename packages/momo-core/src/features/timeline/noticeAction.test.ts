import { describe, expect, it } from "vitest";
import { HOSTED_SKIP_NOTICE_SOURCE, noticeAction } from "./noticeAction";

const reachable = (section: string) => section === "agents";

function row(overrides: Record<string, unknown> = {}, type = "system") {
  return {
    type,
    props: {
      source: HOSTED_SKIP_NOTICE_SOURCE,
      kind: "agent_hosted_skip",
      reason: "hosted_channel_unapproved",
      notice_action: { label: "에이전트 자격 열기", href: "/settings?section=agents" },
      ...overrides,
    },
  } as Parameters<typeof noticeAction>[0];
}

describe("noticeAction", () => {
  it("opens the in-app door the server named", () => {
    expect(noticeAction(row(), reachable)).toEqual({
      label: "에이전트 자격 열기",
      href: "/settings?section=agents",
    });
  });

  it("refuses a section this build cannot reach", () => {
    expect(
      noticeAction(
        row({ notice_action: { label: "코드 실행 호스트", href: "/settings?section=code" } }),
        reachable
      )
    ).toBeNull();
  });

  it("refuses anything that is not a settings path", () => {
    for (const href of [
      "https://evil.example/settings?section=agents",
      "//evil.example",
      "javascript:alert(1)",
      "/settings?section=agents&next=/x",
      "/agents",
    ]) {
      expect(noticeAction(row({ notice_action: { label: "열기", href } }), reachable)).toBeNull();
    }
  });

  it("only reads the hosted notice source on a system row", () => {
    expect(noticeAction(row({ source: "someone.else" }), reachable)).toBeNull();
    expect(noticeAction(row({}, "text"), reachable)).toBeNull();
    expect(noticeAction(row({ notice_action: undefined }), reachable)).toBeNull();
    expect(
      noticeAction(row({ notice_action: { label: " ", href: "/settings?section=agents" } }), reachable)
    ).toBeNull();
  });
});

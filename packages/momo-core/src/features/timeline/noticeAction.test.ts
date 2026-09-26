import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
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

// Security review Medium-3 (#2889): the exact body the server writes for an
// agent named `[보안 재인증](https://evil.example)` (see the PG conformance
// `a_dm_with_a_hosted_agent_says_dms_are_not_delivered_without_a_door` and
// `hosted_notice.rs` `inert_display_name`). The shared parser must find no
// link in it, on web and phone alike.

function links(body: string): string[] {
  const found: string[] = [];
  const walk = (nodes: unknown): void => {
    if (Array.isArray(nodes)) return nodes.forEach(walk);
    if (nodes && typeof nodes === "object") {
      const node = nodes as Record<string, unknown>;
      if (node["kind"] === "link") found.push(String(node["href"]));
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(parseMarkdown(body));
  return found;
}

describe("hosted skip line with a hostile agent name", () => {
  it("renders no link from the name", () => {
    expect(
      links(
        "1:1 대화는 ［보안 재인증］(https：//evil.example)에게 전달되지 않아요. 외부 에이전트는 승인된 채널에서 불러 주세요."
      )
    ).toEqual([]);
  });

  it("the raw name would have planted one (the RED this guards)", () => {
    expect(
      links("1:1 대화는 [보안 재인증](https://evil.example)에게 전달되지 않아요.")
    ).toEqual(["https://evil.example/"]);
  });

  it("keeps the guide link and only the guide link", () => {
    expect(
      links(
        "［x］(https：//evil.example)에게 메시지를 전달하지 못했어요. 서버 관리자에게 [켜는 방법](https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST.md#hosted-agent-agent-port-on-self-host)을 전해 주세요."
      )
    ).toEqual([
      "https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST.md#hosted-agent-agent-port-on-self-host",
    ]);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { MessageBody } from "./MessageBody";

const SELF = "11111111-1111-4111-8111-111111111111";

function member(
  id: string,
  handle: string,
  status: RosterMember["status"] = "active"
): RosterMember {
  return {
    id,
    workspaceId: "ws",
    kind: "human",
    status,
    displayName: handle,
    handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member(SELF, "seongjae"),
  member("22222222-2222-4222-8222-222222222222", "intern-kim"),
  member("33333333-3333-4333-8333-333333333333", "gone", "deleted"),
]);

describe("message mention rendering", () => {
  it("highlights active directory matches and leaves unmatched handles plain", () => {
    const html = renderToStaticMarkup(
      <MessageBody
        body="@intern-kim @missing @gone"
        directory={DIRECTORY}
        selfMemberId={SELF}
      />
    );

    expect(html).toContain('data-mention-handle="intern-kim"');
    expect(html).toContain('data-testid="message-mention"');
    expect(html).toContain('class="text-accent"');
    expect(html).toContain("@missing @gone");
    expect(html).not.toContain('data-mention-handle="missing"');
    expect(html).not.toContain('data-mention-handle="gone"');
  });

  it("adds the accent-soft treatment only to a self mention", () => {
    const html = renderToStaticMarkup(
      <MessageBody
        body="@Seongjae @intern-kim"
        directory={DIRECTORY}
        selfMemberId={SELF}
      />
    );

    expect(html).toContain('data-testid="message-self-mention"');
    expect(html).toContain(
      'class="text-accent bg-accent-soft font-semibold"'
    );
    expect(html).toContain('data-mention-handle="intern-kim"');
    expect(html.match(/bg-accent-soft/g)).toHaveLength(1);
  });
});

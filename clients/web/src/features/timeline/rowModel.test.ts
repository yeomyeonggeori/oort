import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/api";
import { isProvisional, rowPresentation } from "./rowModel";

// =============================================================================
// The precedence chain one timeline row runs (MOMO-620 R1).
//
// This file exists because the chain shipped with the failure case inverted and
// nothing caught it: artifacts.test.ts covered the model, agentCardModel.test.ts
// covered the card, and the rule that decides between them was inline in a
// component with no test at all. A failing agent turn whose body was a patch
// rendered as a finished, confident diff card with its status chip, its error
// note and its body all gone.
//
// Every B1 case from the review is a case below.
// =============================================================================

const PATCH = [
  "diff --git a/relay/Sources/Relay/OutboxDrain.swift b/relay/Sources/Relay/OutboxDrain.swift",
  "--- a/relay/Sources/Relay/OutboxDrain.swift",
  "+++ b/relay/Sources/Relay/OutboxDrain.swift",
  "@@ -18,7 +18,8 @@ struct OutboxDrain {",
  "-    let pollInterval: Duration = .milliseconds(200)",
  "+    let pollInterval: Duration = .milliseconds(50)",
].join("\n");

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "019f9b10-0000-7000-8000-0000000000aa",
    channelId: "00000000-0000-7000-8000-000000000201",
    seq: 12,
    hlcTs: 1_753_000_000_000,
    hlcCount: 0,
    authorMemberId: "00000000-0000-7000-8000-000000000103",
    type: "text",
    createdAtMs: 1_753_000_000_000,
    ...overrides,
  };
}

describe("an approval outranks everything", () => {
  it("stays an approval card even when its body is a patch", () => {
    const row = rowPresentation(
      msg({
        type: "approval_request",
        body: PATCH,
        props: {
          approval_id: "019f9b10-0000-7000-8000-0000000000b1",
          title: "OutboxDrain 패치를 적용할까요?",
        },
      })
    );
    expect(row.card?.kind).toBe("approval");
    expect(row.artifact).toBeNull();
    // The 승인/거부 action is the whole point of the row; a read-only diff
    // would hide the only thing the human is being asked to do.
    expect(row.keepsBody).toBe(false);
  });
});

describe("an artifact outranks the tool/turn card, but never its state", () => {
  it("renders a settled tool result as a plain diff with no chip", () => {
    const row = rowPresentation(
      msg({
        type: "tool_result",
        body: PATCH,
        props: { tool_name: "apply_patch", status: "succeeded" },
      })
    );
    expect(row.artifact?.kind).toBe("diff");
    expect(row.card).toBeNull();
    expect(row.artifactState).toBeNull();
    expect(isProvisional(row.artifactState)).toBe(false);
  });

  it("[B1-1] keeps the failure of an errored tool result", () => {
    const row = rowPresentation(
      msg({
        type: "tool_result",
        body: PATCH,
        props: {
          tool_name: "apply_patch",
          is_error: true,
          status: "error",
          error: "패치가 3번째 hunk에서 충돌했습니다.",
        },
      })
    );
    expect(row.artifact?.kind).toBe("diff");
    expect(row.artifactState).toEqual({
      status: "error",
      note: "패치가 3번째 hunk에서 충돌했습니다.",
    });
    // A failed run still produced a complete patch text, so its counts are
    // exact: the card says 실패, not "still counting".
    expect(isProvisional(row.artifactState)).toBe(false);
  });

  it("[B1-1b] says 실패 even when the server sent no error text", () => {
    const row = rowPresentation(
      msg({
        type: "tool_result",
        body: PATCH,
        props: { tool_name: "apply_patch", is_error: true },
      })
    );
    expect(row.artifactState).toEqual({ status: "error" });
  });

  it("[B1-2] marks a streaming tool call's counters as still moving", () => {
    const row = rowPresentation(
      msg({
        type: "tool_call",
        body: PATCH,
        props: { tool_name: "apply_patch", status: "streaming" },
      })
    );
    expect(row.artifact?.kind).toBe("diff");
    expect(row.artifactState).toEqual({ status: "streaming" });
    expect(isProvisional(row.artifactState)).toBe(true);
  });

  it("[B1-3] keeps a failed turn's error note on the diff", () => {
    const row = rowPresentation(
      msg({
        type: "text",
        body: PATCH,
        props: { status: "error", error: "샤드 클레임이 타임아웃됐습니다." },
      })
    );
    expect(row.artifact?.kind).toBe("diff");
    expect(row.card).toBeNull();
    expect(row.artifactState).toEqual({
      status: "error",
      note: "샤드 클레임이 타임아웃됐습니다.",
    });
  });

  it("never promotes silence to failure", () => {
    const row = rowPresentation(
      msg({
        type: "text",
        body: PATCH,
        props: { status: "timed_out", error: "마지막 하트비트 09:12" },
      })
    );
    expect(row.artifactState?.status).toBe("stalled");
    expect(isProvisional(row.artifactState)).toBe(true);
  });

  it("carries state onto a commit/PR card too, not only a diff", () => {
    const row = rowPresentation(
      msg({
        type: "tool_result",
        props: {
          artifact_kind: "pr",
          tool_name: "open_pr",
          status: "error",
          error: "PR을 열지 못했습니다.",
          url: "https://github.com/Dawn-kim-official/momo/pull/803",
        },
      })
    );
    expect(row.artifact?.kind).toBe("pr");
    expect(row.artifactState?.status).toBe("error");
  });

  it("carries state onto an oversized patch card", () => {
    const huge = [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,1 +1,1 @@",
      ...Array.from({ length: 12_000 }, (_, i) => `+${"가".repeat(20)}${i}`),
    ].join("\n");
    const row = rowPresentation(
      msg({ type: "tool_result", body: huge, props: { status: "streaming" } })
    );
    expect(row.artifact?.kind).toBe("oversized");
    expect(isProvisional(row.artifactState)).toBe(true);
  });
});

describe("the row without an artifact is unchanged", () => {
  it("still renders the agent card when no artifact parses", () => {
    const row = rowPresentation(
      msg({
        type: "tool_result",
        body: "테스트 12개 통과했습니다.",
        props: { tool_name: "swift test", status: "succeeded" },
      })
    );
    expect(row.artifact).toBeNull();
    expect(row.card?.kind).toBe("tool");
    expect(row.keepsBody).toBe(false);
  });

  it("leaves ordinary prose completely alone", () => {
    const row = rowPresentation(msg({ body: "오늘 배포는 내일로 미룹니다." }));
    expect(row.card).toBeNull();
    expect(row.artifact).toBeNull();
    expect(row.artifactState).toBeNull();
    expect(row.keepsBody).toBe(true);
  });

  it("keeps the turn sentence above a turn card", () => {
    const row = rowPresentation(
      msg({
        body: "샤딩 반영했습니다.",
        props: { status: "succeeded", usage: { cost_micro_usd: 4_200 } },
      })
    );
    expect(row.card?.kind).toBe("turn");
    expect(row.keepsBody).toBe(true);
  });

  it("a deleted row is a tombstone, never a card", () => {
    const row = rowPresentation(
      msg({ type: "diff", body: PATCH, state: "deleted" })
    );
    expect(row.card).toBeNull();
    expect(row.artifact).toBeNull();
    expect(row.keepsBody).toBe(true);
  });
});

describe("body retention under the chain", () => {
  it("drops the body a sniffed diff already shows", () => {
    expect(rowPresentation(msg({ type: "diff", body: PATCH })).keepsBody).toBe(
      false
    );
  });

  it("keeps the author's sentence beside a patch carried in props", () => {
    const row = rowPresentation(
      msg({
        body: "outbox drain 샤딩 반영했습니다.",
        props: { artifact_kind: "diff", patch: PATCH },
      })
    );
    expect(row.artifact?.kind).toBe("diff");
    expect(row.keepsBody).toBe(true);
  });
});

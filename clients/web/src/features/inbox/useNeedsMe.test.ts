import { describe, expect, it } from "vitest";
import type { FeedItem } from "@momo/core/features/inbox/model";
import type { PaneAttentionEntry } from "@/features/workbench/local/paneAttention";
import { needsMeFrom } from "./useNeedsMe";

const approval = (id: string, over: Partial<FeedItem> = {}): FeedItem => ({
  key: `approval:${id}`,
  kind: "approval",
  tone: "warn",
  actor: "@kim",
  actorIsAgent: true,
  predicate: "허용을 요청했습니다",
  outcome: null,
  outcomeTone: "muted",
  channelId: "c1",
  channelLabel: "일반",
  timeLabel: "방금",
  sortAtMs: 1,
  pending: true,
  reason: "x",
  approvalId: id,
  ...over,
});

const pane = (paneId: string, status: "waiting" | "done"): PaneAttentionEntry => ({
  paneId,
  status,
  signal: null,
  index: 1,
  name: paneId,
  atMs: 1,
});

describe("needsMeFrom (#3337)", () => {
  it("세 원천을 모두 합한다", () => {
    const n = needsMeFrom({
      approvalItems: [approval("a1"), approval("a2")],
      paneEntries: [pane("p1", "waiting")],
      unreadMentions: 2,
      desktop: true,
    });
    expect(n).toMatchObject({ approvals: 2, panes: 1, mentions: 2, total: 5 });
  });

  it("승인을 무시하지 않는다 (멘션만 세던 옛 배지)", () => {
    expect(
      needsMeFrom({ approvalItems: [approval("a1")], paneEntries: [], unreadMentions: 0, desktop: false }).total
    ).toBe(1);
  });

  it("결정할 수 없는 행(승인 id 없음, 승인 아님)은 세지 않는다", () => {
    const n = needsMeFrom({
      approvalItems: [approval("a1", { approvalId: undefined }), approval("a2", { kind: "run" })],
      paneEntries: [],
      unreadMentions: 0,
      desktop: false,
    });
    expect(n.total).toBe(0);
  });

  it("같은 승인이 두 번 와도 한 번만 센다", () => {
    expect(
      needsMeFrom({
        approvalItems: [approval("a1"), approval("a1", { key: "dup" })],
        paneEntries: [],
        unreadMentions: 0,
        desktop: false,
      }).approvals
    ).toBe(1);
  });

  it("데스크탑에서 waiting 칸만 센다 (done은 일어난 일이다)", () => {
    const n = needsMeFrom({
      approvalItems: [],
      paneEntries: [pane("p1", "waiting"), pane("p2", "done")],
      unreadMentions: 0,
      desktop: true,
    });
    expect(n.panes).toBe(1);
  });

  it("웹에서는 칸이 있어도 세지 않는다", () => {
    expect(
      needsMeFrom({ approvalItems: [], paneEntries: [pane("p1", "waiting")], unreadMentions: 0, desktop: false }).panes
    ).toBe(0);
  });
});

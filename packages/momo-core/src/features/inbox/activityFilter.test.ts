import { describe, expect, it } from "vitest";
import type { FeedItem } from "./model";
import {
  ACTIVITY_FILTERS,
  matchesActivityFilter,
  parseActivityFilter,
} from "./activityFilter";

const row = (over: Partial<FeedItem>): FeedItem => ({
  key: "k",
  kind: "approval",
  tone: "agent",
  actor: "@kim",
  actorIsAgent: true,
  predicate: "x",
  outcome: null,
  outcomeTone: "muted",
  channelId: "c",
  channelLabel: "일반",
  timeLabel: "방금",
  sortAtMs: 1,
  pending: false,
  reason: "x",
  ...over,
});

describe("활동 필터 칩 (#3337)", () => {
  it("칩은 전체·내 에이전트·승인·작업 끝남 네 개다", () => {
    expect([...ACTIVITY_FILTERS]).toEqual(["all", "mine", "approvals", "done"]);
  });

  it("승인 칩은 승인 행만 통과시킨다", () => {
    expect(matchesActivityFilter(row({ kind: "approval" }), "approvals")).toBe(true);
    expect(matchesActivityFilter(row({ kind: "run" }), "approvals")).toBe(false);
  });

  it("작업 끝남 칩은 끝난 실행만 통과시킨다 (진행 중·승인은 제외)", () => {
    expect(matchesActivityFilter(row({ kind: "run", pending: false }), "done")).toBe(true);
    expect(matchesActivityFilter(row({ kind: "run", pending: true }), "done")).toBe(false);
    expect(matchesActivityFilter(row({ kind: "approval" }), "done")).toBe(false);
  });

  it("전체는 모두 통과시킨다", () => {
    expect(matchesActivityFilter(row({ kind: "run", pending: true }), "all")).toBe(true);
  });

  it("알 수 없는 값은 전체로 접는다", () => {
    expect(parseActivityFilter("bogus")).toBe("all");
    expect(parseActivityFilter(null)).toBe("all");
    expect(parseActivityFilter("done")).toBe("done");
  });
});

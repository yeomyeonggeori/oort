import { describe, expect, it } from "vitest";
import { ApiError, type RosterMember } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import {
  addChannelMemberFailure,
  channelMemberCandidates,
  hasAddableMembers,
  isChannelMember,
  withChannelMemberAdded,
} from "./memberAdd";

// The demo workspace really holds two members displayed as 김인턴, a human
// (@intern-kim) and an agent (@kim-intern), so the split and the ids below are
// the live roster shape in the case the server sends them.

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-0000000000c1";
const OTHER_CH = "00000000-0000-7000-8000-0000000000c2";

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이름",
    handle: "handle",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const ME = member({
  id: "00000000-0000-7000-8000-000000000101",
  displayName: "데모 사용자",
  handle: "demo",
});
const SEONGJAE = member({
  id: "00000000-0000-7000-8000-0000000005d1",
  displayName: "곽성재",
  handle: "seongjae",
});
const INTERN_HUMAN = member({
  id: "00000000-0000-7000-8000-000000000201",
  displayName: "김인턴",
  handle: "intern-kim",
});
const INTERN_AGENT = member({
  id: "00000000-0000-7000-8000-000000000301",
  kind: "agent",
  displayName: "김인턴",
  handle: "kim-intern",
  ownerHumanId: SEONGJAE.id,
});

describe("isChannelMember", () => {
  it("reads membership off the roster row's channelIds, case-folded", () => {
    // The channel id arrives upper-cased from another response; membership must
    // still be recognised.
    const inChannel = member({ id: SEONGJAE.id, channelIds: [CH.toUpperCase()] });
    expect(isChannelMember(inChannel, CH)).toBe(true);
    expect(isChannelMember(member({ id: SEONGJAE.id }), CH)).toBe(false);
    expect(isChannelMember(member({ id: SEONGJAE.id, channelIds: [OTHER_CH] }), CH)).toBe(
      false
    );
  });
});

describe("channelMemberCandidates", () => {
  const roster = [ME, SEONGJAE, INTERN_HUMAN, INTERN_AGENT];

  it("drops me, splits people and agents, both kinds sorted by name", () => {
    const groups = channelMemberCandidates(roster, ME.id, "");
    expect(groups.people.map((m) => m.id)).toEqual([SEONGJAE.id, INTERN_HUMAN.id]);
    expect(groups.agents.map((m) => m.id)).toEqual([INTERN_AGENT.id]);
    // 곽/김 sort by ko collation; me is not counted.
    expect(groups.total).toBe(3);
    expect(groups.matched).toBe(3);
  });

  it("keeps already-in members in the list so a just-added row can flip in place", () => {
    const already = member({ id: SEONGJAE.id, displayName: "곽성재", handle: "seongjae", channelIds: [CH] });
    const groups = channelMemberCandidates([ME, already, INTERN_HUMAN], ME.id, "");
    expect(groups.people.map((m) => m.id)).toContain(already.id);
  });

  it("narrows by name OR handle", () => {
    // The handle is the only thing that tells the two 김인턴 apart.
    const byHandle = channelMemberCandidates(roster, ME.id, "kim-intern");
    expect(byHandle.matched).toBe(1);
    expect(byHandle.agents.map((m) => m.id)).toEqual([INTERN_AGENT.id]);

    const byName = channelMemberCandidates(roster, ME.id, "김인턴");
    expect(byName.matched).toBe(2);
  });
});

describe("hasAddableMembers", () => {
  it("false when the only other members are already in the channel", () => {
    const seongjaeIn = member({ id: SEONGJAE.id, channelIds: [CH] });
    expect(hasAddableMembers([ME, seongjaeIn], CH, ME.id)).toBe(false);
  });

  it("false when I am the only member of the workspace", () => {
    expect(hasAddableMembers([ME], CH, ME.id)).toBe(false);
  });

  it("true when someone not in the channel could be added", () => {
    expect(hasAddableMembers([ME, SEONGJAE], CH, ME.id)).toBe(true);
  });
});

describe("withChannelMemberAdded (optimistic)", () => {
  it("adds the channel to the member's channelIds and ticks channelCount", () => {
    const next = withChannelMemberAdded([ME, SEONGJAE], CH, SEONGJAE.id);
    const added = next.find((m) => m.id === SEONGJAE.id);
    expect(added?.channelIds).toContain(CH);
    expect(added?.channelCount).toBe(1);
  });

  it("leaves every other row untouched", () => {
    const next = withChannelMemberAdded([ME, SEONGJAE], CH, SEONGJAE.id);
    expect(next.find((m) => m.id === ME.id)).toBe(ME);
  });

  it("is idempotent: re-adding a member already in the channel does not double-count", () => {
    const already = member({ id: SEONGJAE.id, channelCount: 1, channelIds: [CH] });
    const next = withChannelMemberAdded([already], CH, already.id);
    expect(next[0]?.channelCount).toBe(1);
    expect(next[0]?.channelIds).toEqual([CH]);
  });

  it("does not mutate the input, so the pre-add snapshot survives for rollback", () => {
    const before: RosterMember[] = [ME, member({ id: SEONGJAE.id, channelIds: [], channelCount: 0 })];
    const snapshot = before.map((m) => ({ ...m, channelIds: [...m.channelIds] }));
    withChannelMemberAdded(before, CH, SEONGJAE.id);
    // The array the hook held before the optimistic write is unchanged, so
    // restoring it on failure returns the exact prior state.
    expect(before).toEqual(snapshot);
  });
});

describe("addChannelMemberFailure", () => {
  it("403 asks the reader to reach an admin", () => {
    expect(addChannelMemberFailure(new ApiError(403, "forbidden"))).toContain("권한이 없습니다");
  });

  it("404 names an archived or vanished channel", () => {
    expect(addChannelMemberFailure(new ApiError(404, "not found"))).toContain("보관");
  });

  it("429 asks to slow down", () => {
    expect(addChannelMemberFailure(new ApiError(429, "rate"))).toContain("잦습니다");
  });

  it("a network failure reuses the transport's own measured sentence", () => {
    const message = addChannelMemberFailure(new NetworkError("timeout", 15_000));
    expect(message).toContain("멤버를 추가하지 못했습니다");
  });

  it("an unknown error gets a plain retry line, never a stack", () => {
    expect(addChannelMemberFailure(new Error("boom"))).toBe(
      "멤버를 추가하지 못했습니다. 잠시 뒤에 다시 시도하세요."
    );
  });
});

import { describe, expect, it } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { profileEmail } from "@momo/core/features/directory/model";
import { canSearchByEmail, groupMemberList } from "./memberListModel";

// #5782: who sees a member's email in the member tab, and who can find a member
// by it. The search half is the one that leaks: a guest who cannot see the
// address must not get a row back for typing it.

const WS = "00000000-0000-7000-8000-000000000001";

function row(over: Partial<RosterMember> & { id: string; handle: string }): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: over.handle,
    role: "member",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const seoyeon = row({ id: "a1", displayName: "이서연", handle: "seoyeon", email: "lee.s@example.com" });
const dohyeon = row({ id: "a2", displayName: "김도현", handle: "dohyeon", email: "kim.d@example.com" });
const hermes = row({ id: "a3", displayName: "hermes", handle: "hermes", kind: "agent", email: "bot@example.com" });
const roster = [seoyeon, dohyeon, hermes];

describe("profileEmail", () => {
  it("members, admins and owners see a person's trimmed email", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      expect(profileEmail(role, { kind: "human", email: "  kim.d@example.com " })).toBe("kim.d@example.com");
    }
  });

  it("a guest, or a viewer whose role is unknown, sees none", () => {
    expect(profileEmail("guest", seoyeon)).toBeNull();
    expect(profileEmail(undefined, seoyeon)).toBeNull();
  });

  it("an agent has no email to show, and blank or non-string values are absent", () => {
    expect(profileEmail("owner", hermes)).toBeNull();
    expect(profileEmail("owner", { kind: "human", email: "   " })).toBeNull();
    expect(profileEmail("owner", { kind: "human", email: 42 as unknown as string })).toBeNull();
  });

  it("canSearchByEmail follows the same line", () => {
    expect(canSearchByEmail("member")).toBe(true);
    expect(canSearchByEmail("guest")).toBe(false);
    expect(canSearchByEmail(undefined)).toBe(false);
  });
});

describe("groupMemberList", () => {
  it("a member finds a person by an email fragment the name and handle do not carry", () => {
    const groups = groupMemberList(roster, "LEE.S@", "member");
    expect(groups.people.map((m) => m.handle)).toEqual(["seoyeon"]);
    expect(groups.matched).toBe(1);
  });

  it("a guest typing the same email gets nothing back (the hidden address does not leak through search)", () => {
    const groups = groupMemberList(roster, "lee.s@", "guest");
    expect(groups.matched).toBe(0);
    expect(groups.people).toEqual([]);
  });

  it("an agent's email is never a search key", () => {
    expect(groupMemberList(roster, "bot@", "owner").matched).toBe(0);
  });

  it("name and handle search is unchanged, for guests too", () => {
    expect(groupMemberList(roster, "도현", "guest").people.map((m) => m.handle)).toEqual(["dohyeon"]);
    expect(groupMemberList(roster, "herm", "guest").agents.map((m) => m.handle)).toEqual(["hermes"]);
  });

  it("total stays the roster size while the query narrows (the skeleton, empty and count branches read it)", () => {
    expect(groupMemberList(roster, "lee.s@", "member").total).toBe(3);
    expect(groupMemberList(roster, "nobody", "member").total).toBe(3);
    expect(groupMemberList(roster, "", "member")).toEqual(
      expect.objectContaining({ matched: 3, total: 3 })
    );
  });
});

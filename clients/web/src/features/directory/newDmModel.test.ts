import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import {
  existingDmChannelId,
  newDmCandidates,
  peerDot,
} from "./newDmModel";

const ME = "00000000-0000-7000-8000-00000000000A";
const PEER = "00000000-0000-7000-8000-00000000000b";
const OTHER = "00000000-0000-7000-8000-00000000000C";

function dm(id: string, memberIds: string[], extra: Partial<Channel> = {}): Channel {
  return { id, workspaceId: "w", kind: "dm", muted: false, memberIds, ...extra } as Channel;
}
function member(patch: Partial<RosterMember>): RosterMember {
  return {
    id: PEER,
    workspaceId: "w",
    kind: "human",
    status: "active",
    displayName: "상대",
    handle: "peer",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...patch,
  };
}

describe("existingDmChannelId", () => {
  it("나와 상대 둘뿐인 DM을 대소문자 가리지 않고 찾는다", () => {
    const channels = [dm("c1", [ME, PEER.toUpperCase()])];
    expect(existingDmChannelId(channels, ME.toLowerCase(), PEER)).toBe("c1");
  });
  it("없으면 null이다", () => {
    expect(existingDmChannelId([dm("c1", [ME, OTHER])], ME, PEER)).toBeNull();
    expect(existingDmChannelId([], ME, PEER)).toBeNull();
  });
  it("셋 이상의 DM, 보관된 DM, 채널은 그 사람과의 DM이 아니다", () => {
    expect(existingDmChannelId([dm("g", [ME, PEER, OTHER])], ME, PEER)).toBeNull();
    expect(existingDmChannelId([dm("a", [ME, PEER], { archivedAtMs: 1 })], ME, PEER)).toBeNull();
    expect(
      existingDmChannelId([{ ...dm("p", [ME, PEER]), kind: "private" } as Channel], ME, PEER)
    ).toBeNull();
  });
});

describe("newDmCandidates", () => {
  it("나와 활동 중이 아닌 멤버를 뺀다", () => {
    const list = [
      member({ id: ME }),
      member({ id: PEER }),
      member({ id: OTHER, status: "suspended" }),
    ];
    expect(newDmCandidates(list, ME).map((m) => m.id)).toEqual([PEER]);
  });
});

describe("peerDot", () => {
  const now = 1_000;
  it("사람은 스스로 정한 자리 비움·방해 금지만 점이 된다", () => {
    expect(peerDot(member({ presenceStatus: "away" }), now)).toBe("away");
    expect(peerDot(member({ presenceStatus: "dnd" }), now)).toBe("dnd");
    expect(peerDot(member({ presenceStatus: "auto" }), now)).toBeNull();
    expect(peerDot(member({}), now)).toBeNull();
  });
  it("만료된 방해 금지는 점이 아니다", () => {
    expect(peerDot(member({ presenceStatus: "dnd", dndUntilMs: 999 }), now)).toBeNull();
    expect(peerDot(member({ presenceStatus: "dnd", dndUntilMs: 5_000 }), now)).toBe("dnd");
  });
  it("에이전트는 호스트가 닿아 있을 때만 점이다", () => {
    expect(peerDot(member({ kind: "agent", hostOnline: true }), now)).toBe("online");
    expect(peerDot(member({ kind: "agent", hostOnline: false }), now)).toBeNull();
    expect(peerDot(member({ kind: "agent" }), now)).toBeNull();
  });
  it("상대를 모르면 null이다", () => {
    expect(peerDot(null, now)).toBeNull();
  });
});

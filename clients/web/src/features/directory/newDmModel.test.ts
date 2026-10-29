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
  const word = (m: Parameters<typeof peerDot>[0]) => peerDot(m, now)?.label ?? null;

  it("사람: 선언 상태(자리 비움·방해 금지)가 먼저이고 접속 여부와 무관하다", () => {
    expect(word(member({ presenceStatus: "away" }))).toBe("자리 비움");
    expect(word(member({ presenceStatus: "dnd" }))).toBe("방해 금지");
    expect(word(member({ presenceStatus: "away", online: true }))).toBe("자리 비움");
    expect(word(member({ presenceStatus: "dnd", online: false }))).toBe("방해 금지");
  });

  it("사람: 선언이 없으면 접속 여부를 말한다 — 접속 없음이 「방해 금지」로 읽히면 안 된다 (#4692)", () => {
    expect(word(member({ online: true }))).toBe("온라인");
    expect(word(member({ online: false }))).toBe("오프라인");
    expect(word(member({ presenceStatus: "auto", online: false }))).toBe("오프라인");
    // 에이전트의 「연결됨」이 아니라 사람의 「온라인」이다.
    expect(word(member({ online: true }))).not.toBe("연결됨");
  });

  it("사람: 접속 여부를 모르면 아무 말도 하지 않는다 — 모름은 오프라인이 아니다", () => {
    expect(word(member({ presenceStatus: "auto" }))).toBeNull();
    expect(word(member({}))).toBeNull();
  });

  it("만료된 방해 금지는 선언이 아니다: 접속 여부로 내려가고, 모르면 말이 없다", () => {
    expect(word(member({ presenceStatus: "dnd", dndUntilMs: 999 }))).toBeNull();
    expect(word(member({ presenceStatus: "dnd", dndUntilMs: 999, online: true }))).toBe("온라인");
    expect(word(member({ presenceStatus: "dnd", dndUntilMs: 5_000 }))).toBe("방해 금지");
  });

  it("에이전트는 호스트가 닿아 있을 때만 「연결됨」이고 `online` 은 읽지 않는다", () => {
    expect(word(member({ kind: "agent", hostOnline: true }))).toBe("연결됨");
    expect(word(member({ kind: "agent", hostOnline: false, online: true }))).toBeNull();
    expect(word(member({ kind: "agent" }))).toBeNull();
  });

  it("상대를 모르면 null이다", () => {
    expect(peerDot(null, now)).toBeNull();
  });
});

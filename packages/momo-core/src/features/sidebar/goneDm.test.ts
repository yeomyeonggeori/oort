import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "../../lib/api";
import {
  channelLabelParts,
  makeDirectory,
  type ChannelLabelKind,
} from "../workspace/directory";
import {
  dmHiddenAsGone,
  goneDmDisclosureLabel,
  readProjectionPhase,
  ROSTER_PAGE_SIZE,
  rosterIsComplete,
  rosterLoaded,
  type ReadProjectionPhase,
} from "./goneDm";

// #4252: 나간 멤버와의 대화는 안 읽은 것이 없으면 사이드바에서 접힌다. 웹과 폰이 이 한 함수를 읽으므로
// 규칙은 여기서 잰다. 이름 있는 시험이 사보타주(함수를 「절대 숨기지 않는다」로 되돌림)의 과녁이다.

const ME = "00000000-0000-7000-8000-00000000000A";
const PEER = "00000000-0000-7000-8000-00000000000B";
const GONE = "00000000-0000-7000-8000-00000000000C";

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
const self = member({ id: ME, displayName: "곽성재", handle: "kwak" });

function dm(memberIds: string[]): Channel {
  return { id: "c", workspaceId: "w", kind: "dm", muted: false, memberIds } as Channel;
}

const QUIET = {
  rosterComplete: true,
  unreadCount: 0,
  mentionCount: 0,
  isOpen: false,
  phase: "ready" as const,
};

describe("dmHiddenAsGone: 나간 멤버 DM 은 안 읽음이 없으면 숨는다", () => {
  it("나간 멤버 DM 은 안 읽은 것이 없으면 숨는다", () => {
    expect(dmHiddenAsGone({ labelKind: "gone", ...QUIET })).toBe(true);
  });

  it("안 읽은 메시지가 있으면 보인다", () => {
    expect(dmHiddenAsGone({ labelKind: "gone", ...QUIET, unreadCount: 3 })).toBe(false);
  });

  it("멘션이 있으면 보인다 (안 읽은 수가 0 이어도)", () => {
    expect(dmHiddenAsGone({ labelKind: "gone", ...QUIET, mentionCount: 1 })).toBe(false);
  });

  it("지금 열려 있는 DM 은 숨기지 않는다 (보던 대화가 목록에서 사라지지 않는다)", () => {
    expect(dmHiddenAsGone({ labelKind: "gone", ...QUIET, isOpen: true })).toBe(false);
  });

  it("후보는 gone 뿐이다: 상대 · 나 · 명부 대기 · 채널은 절대 숨기지 않는다", () => {
    const others: ChannelLabelKind[] = ["peer", "self", "pending", "channel"];
    for (const labelKind of others) {
      expect(dmHiddenAsGone({ labelKind, ...QUIET }), labelKind).toBe(false);
    }
  });

  it("명부가 한도에서 잘렸을 수 있으면 접지 않는다 (「없다」가 「나갔다」가 아니다)", () => {
    expect(dmHiddenAsGone({ labelKind: "gone", ...QUIET, rosterComplete: false })).toBe(false);
  });

  it("투영이 오는 중이면 접힌 채로 둔다 (도착 전에 나타났다 사라지는 깜빡임이 없다)", () => {
    expect(dmHiddenAsGone({ labelKind: "gone", ...QUIET, phase: "loading" })).toBe(true);
  });

  it("투영을 못 읽었으면 보인다 (안 읽은 것이 있는지 모를 때 숨기는 쪽이 최악이다)", () => {
    expect(dmHiddenAsGone({ labelKind: "gone", ...QUIET, phase: "error" })).toBe(false);
  });

  it("세 국면 × 안 읽음 유무의 전체 표", () => {
    const phases: ReadProjectionPhase[] = ["loading", "error", "ready"];
    const table = phases.map((phase) => [
      phase,
      dmHiddenAsGone({ labelKind: "gone", ...QUIET, phase }),
      dmHiddenAsGone({ labelKind: "gone", ...QUIET, phase, unreadCount: 2 }),
    ]);
    expect(table).toEqual([
      ["loading", true, true],
      ["error", false, false],
      ["ready", true, false],
    ]);
  });

  it("실제 라벨 판정과 이어 본다: 명부에 없는 상대의 DM 은 gone 이라 숨고, 명부에 있는 상대의 DM 은 안 숨는다", () => {
    const directory = makeDirectory([self, member({ displayName: "이도현" })]);
    const gone = channelLabelParts(dm([ME, GONE]), directory, ME);
    const live = channelLabelParts(dm([ME, PEER]), directory, ME);
    expect(gone.kind).toBe("gone");
    expect(live.kind).toBe("peer");
    expect(dmHiddenAsGone({ labelKind: gone.kind, ...QUIET })).toBe(true);
    expect(dmHiddenAsGone({ labelKind: live.kind, ...QUIET })).toBe(false);
  });

  it("명부를 아직 못 받았을 때의 DM 은 gone 이 아니라 pending 이라 숨지 않는다", () => {
    const parts = channelLabelParts(dm([ME, GONE]), makeDirectory([]), ME);
    expect(parts.kind).toBe("pending");
    expect(dmHiddenAsGone({ labelKind: parts.kind, ...QUIET })).toBe(false);
  });
});

describe("명부를 믿을 수 있는가", () => {
  it("한도(200)에 닿으면 잘렸을 수 있다 — 한 명 모자라면 아직 다 받았다", () => {
    expect(ROSTER_PAGE_SIZE).toBe(200);
    expect(rosterIsComplete(0)).toBe(true);
    expect(rosterIsComplete(199)).toBe(true);
    expect(rosterIsComplete(200)).toBe(false);
    expect(rosterIsComplete(240)).toBe(false);
  });

  it("rosterLoaded: 오는 중이거나 한 번도 못 받은 채 실패했으면 아니다 (받은 뒤의 배경 실패는 받은 것이다)", () => {
    expect(rosterLoaded({ isPending: true })).toBe(false);
    expect(rosterLoaded({ isPending: false, isError: true, data: undefined })).toBe(false);
    expect(rosterLoaded({ isPending: false, isError: true, data: [] })).toBe(true);
    expect(rosterLoaded({ isPending: false, isError: false, data: [] })).toBe(true);
    // 시험 대역처럼 플래그가 없는 쿼리는 받은 것으로 읽는다.
    expect(rosterLoaded({ isPending: false })).toBe(true);
  });
});

describe("readProjectionPhase", () => {
  it("한 번도 못 읽은 것만 error 다 (읽은 뒤의 배경 실패는 손에 든 투영이 있어 ready 다)", () => {
    expect(readProjectionPhase({ isPending: true })).toBe("loading");
    expect(readProjectionPhase({ isPending: false, isError: true, data: undefined })).toBe("error");
    expect(readProjectionPhase({ isPending: false, isError: true, data: [] })).toBe("ready");
    expect(readProjectionPhase({ isPending: false, isError: false, data: [] })).toBe("ready");
    expect(readProjectionPhase({ isPending: false })).toBe("ready");
  });
});

describe("goneDmDisclosureLabel", () => {
  it("접힌 대화의 수를 센다", () => {
    expect(goneDmDisclosureLabel(1)).toBe("나간 멤버와의 대화 1개");
    expect(goneDmDisclosureLabel(12)).toBe("나간 멤버와의 대화 12개");
  });
});

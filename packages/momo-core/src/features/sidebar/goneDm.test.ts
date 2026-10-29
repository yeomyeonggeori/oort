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
  goneUnreadProbeAfterSeq,
  goneUnreadSignature,
  goneUnreadVerdict,
  readProjectionPhase,
  resolveGoneUnreadVerdicts,
  ROSTER_PAGE_SIZE,
  rosterIsComplete,
  rosterLoaded,
  type GoneUnreadVerdict,
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
const self = member({ id: ME, displayName: "구민수", handle: "gu" });

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

describe("dmHiddenAsGone: 안 읽음이 기계 메시지뿐이면 사람이 읽을 것이 없다 (이슈 AC 「안 읽은 사람 메시지」)", () => {
  const unread = { labelKind: "gone" as const, ...QUIET, unreadCount: 6 };

  it("안 읽음이 기계 메시지뿐이면(ambient) 숨는다: 끈 에이전트의 DM 이 작업 상태 줄 때문에 남지 않는다", () => {
    expect(dmHiddenAsGone({ ...unread, unreadVerdict: "ambient" })).toBe(true);
  });

  it("사람이 읽을 메시지가 있으면(human) 보인다", () => {
    expect(dmHiddenAsGone({ ...unread, unreadVerdict: "human" })).toBe(false);
  });

  it("판정을 못 읽었으면(error) 보이고, 판정을 안 받았으면(생략) 보인다 (모를 때 숨기는 쪽이 최악이다)", () => {
    expect(dmHiddenAsGone({ ...unread, unreadVerdict: "error" })).toBe(false);
    expect(dmHiddenAsGone({ ...unread })).toBe(false);
  });

  it("판정이 오는 중이면(pending) 접힌 채 둔다 (읽는 중에 깜빡이며 나타나지 않는다)", () => {
    expect(dmHiddenAsGone({ ...unread, unreadVerdict: "pending" })).toBe(true);
  });

  it("멘션이 있으면 기계 메시지뿐이라는 판정도 이긴다 (사람이 부른 것이다)", () => {
    expect(dmHiddenAsGone({ ...unread, mentionCount: 1, unreadVerdict: "ambient" })).toBe(false);
    expect(dmHiddenAsGone({ ...unread, unreadCount: 0, mentionCount: 1, unreadVerdict: "ambient" })).toBe(false);
  });

  it("안 읽음이 없으면 판정과 상관없이 숨는다", () => {
    const verdicts: Array<GoneUnreadVerdict | undefined> = ["human", "ambient", "pending", "error", undefined];
    for (const unreadVerdict of verdicts) {
      expect(dmHiddenAsGone({ labelKind: "gone", ...QUIET, unreadVerdict }), String(unreadVerdict)).toBe(true);
    }
  });

  it("판정은 후보가 아닌 DM 을 접지 못한다: 상대가 있는 DM · 열린 DM · 명부 못 믿음 · 투영 못 읽음은 ambient 여도 그대로다", () => {
    expect(dmHiddenAsGone({ ...unread, labelKind: "peer", unreadVerdict: "ambient" })).toBe(false);
    expect(dmHiddenAsGone({ ...unread, labelKind: "pending", unreadVerdict: "ambient" })).toBe(false);
    expect(dmHiddenAsGone({ ...unread, isOpen: true, unreadVerdict: "ambient" })).toBe(false);
    expect(dmHiddenAsGone({ ...unread, rosterComplete: false, unreadVerdict: "ambient" })).toBe(false);
    expect(dmHiddenAsGone({ ...unread, phase: "error", unreadVerdict: "ambient" })).toBe(false);
  });
});

describe("goneUnreadProbeAfterSeq: 안 읽음이 사람이 읽을 것인지 메시지를 읽어 가려야 하는 DM", () => {
  const READY = { labelKind: "gone" as const, rosterComplete: true, isOpen: false, phase: "ready" as const };
  const unreadRead = { lastReadSeq: 5, latestSeq: 9, mentionCount: 0, markedUnreadBeforeSeq: null };

  it("안 읽음이 있는 나간 멤버 DM 은 마지막으로 읽은 seq 뒤를 읽는다", () => {
    expect(goneUnreadProbeAfterSeq({ ...READY, read: unreadRead })).toBe(5);
  });

  it("안 읽음이 없으면 읽을 것이 없다 (그냥 접힌다)", () => {
    expect(goneUnreadProbeAfterSeq({ ...READY, read: { ...unreadRead, latestSeq: 5 } })).toBeNull();
    expect(goneUnreadProbeAfterSeq({ ...READY, read: undefined })).toBeNull();
    expect(goneUnreadProbeAfterSeq({ ...READY, read: null })).toBeNull();
  });

  it("멘션이 있으면 읽지 않는다 (사람이 부른 것이라 항상 보인다)", () => {
    expect(goneUnreadProbeAfterSeq({ ...READY, read: { ...unreadRead, mentionCount: 2 } })).toBeNull();
  });

  it("사람이 직접 한 「여기부터 안 읽음」 표시는 읽지 않는다 (사람의 뜻이라 항상 보인다)", () => {
    expect(goneUnreadProbeAfterSeq({ ...READY, read: { ...unreadRead, latestSeq: 5, markedUnreadBeforeSeq: 4 } })).toBeNull();
    expect(goneUnreadProbeAfterSeq({ ...READY, read: { ...unreadRead, markedUnreadBeforeSeq: 4 } })).toBeNull();
  });

  it("후보가 아니면 읽지 않는다: 상대가 있는 DM · 명부 못 믿음 · 열린 DM · 투영이 오는 중/못 읽음", () => {
    expect(goneUnreadProbeAfterSeq({ ...READY, labelKind: "peer", read: unreadRead })).toBeNull();
    expect(goneUnreadProbeAfterSeq({ ...READY, labelKind: "pending", read: unreadRead })).toBeNull();
    expect(goneUnreadProbeAfterSeq({ ...READY, rosterComplete: false, read: unreadRead })).toBeNull();
    expect(goneUnreadProbeAfterSeq({ ...READY, isOpen: true, read: unreadRead })).toBeNull();
    expect(goneUnreadProbeAfterSeq({ ...READY, phase: "loading", read: unreadRead })).toBeNull();
    expect(goneUnreadProbeAfterSeq({ ...READY, phase: "error", read: unreadRead })).toBeNull();
  });
});

describe("goneUnreadVerdict: 쿼리 상태에서 판정을 가른다", () => {
  it("오는 중 · 실패 · 사람이 읽을 것 · 기계 메시지뿐", () => {
    expect(goneUnreadVerdict({ isPending: true })).toBe("pending");
    expect(goneUnreadVerdict({ isPending: false, isError: true })).toBe("error");
    expect(goneUnreadVerdict({ isPending: false, isError: false, data: undefined })).toBe("error");
    expect(goneUnreadVerdict({ isPending: false, isError: false, data: true })).toBe("human");
    expect(goneUnreadVerdict({ isPending: false, isError: false, data: false })).toBe("ambient");
  });
});

describe("resolveGoneUnreadVerdicts: 판정 문자열을 맵으로 풀고, 이미 가른 DM 은 새 쪽이 오는 동안 이전 판정을 유지한다", () => {
  const A = "00000000-0000-7000-8000-0000000003a1";
  const B = "00000000-0000-7000-8000-0000000003b2";
  const sig = (...parts: Array<[string, GoneUnreadVerdict]>) =>
    goneUnreadSignature(parts.map(([id, verdict]) => ({ id, verdict })));

  it("신호 문자열은 id:판정 을 | 로 잇는다 (후보가 없으면 빈 문자열)", () => {
    expect(sig()).toBe("");
    expect(sig([A, "human"], [B, "ambient"])).toBe(`${A}:human|${B}:ambient`);
  });

  it("풀면 소문자 id -> 판정이다", () => {
    const settled = new Map<string, "human" | "ambient">();
    const verdicts = resolveGoneUnreadVerdicts(sig([A, "human"], [B, "error"]), settled);
    expect([...verdicts]).toEqual([[A, "human"], [B, "error"]]);
    expect([...resolveGoneUnreadVerdicts("", settled)]).toEqual([]);
  });

  it("한 번 가른 DM 이 다시 오는 중(새 메시지로 키가 바뀌었다)이면 이전 판정을 유지한다", () => {
    const settled = new Map<string, "human" | "ambient">();
    resolveGoneUnreadVerdicts(sig([A, "human"], [B, "ambient"]), settled);
    const verdicts = resolveGoneUnreadVerdicts(sig([A, "pending"], [B, "pending"]), settled);
    expect(verdicts.get(A)).toBe("human");
    expect(verdicts.get(B)).toBe("ambient");
  });

  it("처음부터 오는 중이면 그냥 오는 중이다 (유지할 판정이 없다)", () => {
    const verdicts = resolveGoneUnreadVerdicts(sig([A, "pending"]), new Map());
    expect(verdicts.get(A)).toBe("pending");
  });

  it("못 읽은 판정(error)은 유지하지 않는다: 새로 오는 중이면 오는 중이다", () => {
    const settled = new Map<string, "human" | "ambient">();
    resolveGoneUnreadVerdicts(sig([A, "error"]), settled);
    expect(resolveGoneUnreadVerdicts(sig([A, "pending"]), settled).get(A)).toBe("pending");
  });

  it("후보에서 빠진 DM(다 읽었다)은 잊는다: 나중에 온 새 안 읽음은 옛 판정이 아니라 오는 중이다", () => {
    const settled = new Map<string, "human" | "ambient">();
    resolveGoneUnreadVerdicts(sig([A, "human"]), settled);
    resolveGoneUnreadVerdicts("", settled);
    expect(settled.size).toBe(0);
    expect(resolveGoneUnreadVerdicts(sig([A, "pending"]), settled).get(A)).toBe("pending");
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

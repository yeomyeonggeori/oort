import { describe, expect, it } from "vitest";
import type { Channel, ReadState, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { goneDmIds } from "./goneDmHiding";
import { indexFallbackChannelId } from "./sidebarDmClosure";

// #4252: 사이드바와 인덱스 라우트가 읽는 「나간 멤버와의 대화로 접히는 DM」의 집합. 판정 자체는 코어
// `dmHiddenAsGone` 의 시험이 잰다. 여기서는 웹이 그 입력(이름 갈래·행이 그리는 안 읽음·열림)을 제대로 모아 주는지 잰다.

const ME = "00000000-0000-7000-8000-00000000000A";
const LIVE_PEER = "00000000-0000-7000-8000-00000000000B";
const GONE_A = "00000000-0000-7000-8000-0000000000C1";
const GONE_B = "00000000-0000-7000-8000-0000000000C2";
const DM_LIVE = "00000000-0000-7000-8000-000000000301";
const DM_GONE_A = "00000000-0000-7000-8000-0000000003A1";
const DM_GONE_B = "00000000-0000-7000-8000-0000000003B2";

function member(id: string, patch: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: "w",
    kind: "human",
    status: "active",
    displayName: "이름",
    handle: id.slice(-4),
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...patch,
  };
}
const directory = makeDirectory([
  member(ME, { displayName: "곽성재" }),
  member(LIVE_PEER, { displayName: "이도현" }),
]);

function dm(id: string, other: string): Channel {
  return { id, workspaceId: "w", kind: "dm", muted: false, memberIds: [ME, other] } as Channel;
}
const dms = [dm(DM_LIVE, LIVE_PEER), dm(DM_GONE_A, GONE_A), dm(DM_GONE_B, GONE_B)];

function read(channelId: string, patch: Partial<ReadState> = {}): ReadState {
  return {
    channelId,
    lastReadSeq: 5,
    latestSeq: 5,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    ...patch,
  };
}
const projection = (...rows: ReadState[]) => new Map(rows.map((row) => [row.channelId.toLowerCase(), row]));

const base = {
  dms,
  directory,
  selfMemberId: ME,
  rosterReady: true,
  byChannel: projection(read(DM_LIVE), read(DM_GONE_A), read(DM_GONE_B)),
  openId: null as string | null,
  phase: "ready" as const,
};

describe("goneDmIds: 나간 멤버 DM 은 안 읽음이 없으면 접힌다", () => {
  it("명부에 없는 상대의 DM 만, 소문자 id 로 모은다 (명부에 있는 상대의 DM 은 안 접힌다)", () => {
    expect([...goneDmIds(base)].sort()).toEqual([DM_GONE_A, DM_GONE_B].map((id) => id.toLowerCase()).sort());
  });

  it("안 읽은 메시지가 있는 나간 멤버 DM 은 접히지 않는다 (합성 안 읽음: 서버 수가 0 이어도 「여기부터 안 읽음」 표시는 센다)", () => {
    const byChannel = projection(
      read(DM_LIVE),
      read(DM_GONE_A, { latestSeq: 8 }),
      // 서버 수는 0 이지만 표시가 있다: 행의 알약이 그리는 값(D3)과 같은 사실이어야 한다.
      read(DM_GONE_B, { markedUnreadBeforeSeq: 4 })
    );
    expect([...goneDmIds({ ...base, byChannel })]).toEqual([]);
  });

  it("멘션이 있으면 접히지 않는다", () => {
    const byChannel = projection(read(DM_GONE_A, { mentionCount: 1 }), read(DM_GONE_B));
    expect([...goneDmIds({ ...base, byChannel })]).toEqual([DM_GONE_B.toLowerCase()]);
  });

  it("지금 열려 있는 DM 은 안 접힌다 (대소문자가 달라도 같은 DM 이다)", () => {
    const folded = goneDmIds({ ...base, openId: DM_GONE_A.toLowerCase() });
    expect([...folded]).toEqual([DM_GONE_B.toLowerCase()]);
  });

  it("줄을 펼쳐 둔 동안(foldOpen)에는 열려 있는 나간 멤버 DM 도 접힌 목록에 머문다 (열면 행이 다른 목록으로 옮겨 가 키보드 캐럿을 잃는다, H1)", () => {
    const open = DM_GONE_A.toLowerCase();
    // 접힌 채(예전 그대로): 열린 DM 은 위 목록으로 올라온다.
    expect(goneDmIds({ ...base, openId: open, foldOpen: false }).has(open)).toBe(false);
    // 펼친 동안: 열린 DM 도 접힌 목록에 있다. 다른 행의 판정은 그대로다.
    const kept = goneDmIds({ ...base, openId: open, foldOpen: true });
    expect([...kept].sort()).toEqual([DM_GONE_A, DM_GONE_B].map((id) => id.toLowerCase()).sort());
    // 안 읽음이 있는 DM 은 펼쳐 둬도 접히지 않는다(펼침은 「열림」만 바꾼다).
    const byChannel = projection(read(DM_GONE_A, { latestSeq: 9 }), read(DM_GONE_B));
    expect(goneDmIds({ ...base, byChannel, openId: DM_GONE_B, foldOpen: true }).has(DM_GONE_A.toLowerCase())).toBe(false);
  });

  it("열려 있는 DM 의 안 읽음은 0 으로 접힌 값이라, 읽는 동안 서버 투영이 늦어도 접히지 않는다", () => {
    const byChannel = projection(read(DM_GONE_A, { latestSeq: 9 }), read(DM_GONE_B));
    const folded = goneDmIds({ ...base, byChannel, openId: DM_GONE_A });
    expect(folded.has(DM_GONE_A.toLowerCase())).toBe(false);
  });

  it("명부가 한도(200)에 닿아 잘렸을 수 있으면 아무것도 접히지 않는다 (「없다」가 「나갔다」가 아니다)", () => {
    const filler = Array.from({ length: 200 }, (_, n) =>
      member(`00000000-0000-7000-8000-${String(n + 1000).padStart(12, "0")}`, { displayName: `멤버${n}` })
    );
    const truncated = makeDirectory([member(ME, { displayName: "곽성재" }), member(LIVE_PEER), ...filler]);
    expect(goneDmIds({ ...base, directory: truncated }).size).toBe(0);
  });

  it("명부를 아직 못 받았으면 아무것도 접히지 않는다 (「불러오는 중」은 나간 멤버가 아니다)", () => {
    expect([...goneDmIds({ ...base, rosterReady: false })]).toEqual([]);
  });

  it("읽음 투영: 오는 중이면 접힌 채, 못 읽었으면 안 접힌다", () => {
    expect(goneDmIds({ ...base, byChannel: new Map(), phase: "loading" }).size).toBe(2);
    expect(goneDmIds({ ...base, byChannel: new Map(), phase: "error" }).size).toBe(0);
  });

  it("투영에 행이 없는 DM(메시지가 한 번도 없는 DM)은 안 읽음이 0 이라 접힌다", () => {
    expect(goneDmIds({ ...base, byChannel: new Map() }).size).toBe(2);
  });
});

describe("indexFallbackChannelId: 접힌 나간 멤버 DM 은 `/` 가 열어 주는 대화의 후보가 아니다", () => {
  const input = {
    channels: [] as { id: string }[],
    dms: [{ id: DM_GONE_A }, { id: DM_LIVE }, { id: DM_GONE_B }],
    closed: {},
    latestSeqOf: () => undefined,
    phase: "ready" as const,
  };

  it("접힌 집합이 없으면 첫 DM 이다 (예전 그대로)", () => {
    expect(indexFallbackChannelId(input)).toBe(DM_GONE_A);
  });

  it("접힌 집합이 있으면 첫 DM 이 접혔을 때 다음 DM 을 연다", () => {
    const foldedGone = goneDmIds(base);
    expect(indexFallbackChannelId({ ...input, foldedGone })).toBe(DM_LIVE);
  });

  it("남은 DM 이 전부 접혔으면 아무것도 열지 않는다 (빈 상태)", () => {
    expect(
      indexFallbackChannelId({
        ...input,
        dms: [{ id: DM_GONE_A }, { id: DM_GONE_B }],
        foldedGone: goneDmIds(base),
      })
    ).toBeNull();
  });

  it("채널이 있으면 채널이 먼저다 (접힌 집합은 보지 않는다)", () => {
    expect(
      indexFallbackChannelId({ ...input, channels: [{ id: "ch" }], foldedGone: goneDmIds(base) })
    ).toBe("ch");
  });
});

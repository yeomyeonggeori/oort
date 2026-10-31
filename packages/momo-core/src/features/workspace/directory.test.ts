import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "../../lib/api";
import {
  channelLabel,
  channelLabelParts,
  dmGroupFacts,
  makeDirectory,
  missingMemberLabel,
} from "./directory";

// #3675 / #3676: 한 DM은 어느 표면에서도 같은 이름이어야 하고, 그 이름이 섹션 제목 「다이렉트 메시지」일
// 수는 없다. 이 시험은 명부에서 빠진 상대(은퇴·정지된 에이전트)와의 DM을 픽스처로 쓴다.
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
function dm(memberIds: string[]): Channel {
  return { id: "c", workspaceId: "w", kind: "dm", muted: false, memberIds } as Channel;
}

const self = member({ id: ME, displayName: "구민수", handle: "gu" });

describe("channelLabelParts · DM 이름 해석", () => {
  it("상대가 명부에 있으면 그 이름이다. 에이전트면 isAgent", () => {
    const dir = makeDirectory([self, member({ kind: "agent", displayName: "김인턴" })]);
    expect(channelLabelParts(dm([ME, PEER]), dir, ME)).toMatchObject({
      text: "김인턴",
      isAgent: true,
    });
  });

  it("상대가 명부에서 빠졌으면(은퇴·정지) 「나간 멤버」다", () => {
    const dir = makeDirectory([self]);
    const parts = channelLabelParts(dm([ME, GONE]), dir, ME);
    expect(parts.text).toBe("나간 멤버");
    expect(parts.handle).toBeNull();
  });

  it("명부에 없는 상대가 에이전트라고 **알 때만** 「꺼진 에이전트」다 - 모르면 「나간 멤버」 (ADR-0177 D11)", () => {
    const dir = makeDirectory([self]);
    expect(channelLabelParts(dm([ME, GONE]), dir, ME, { goneKind: "agent" })).toMatchObject({
      text: "꺼진 에이전트",
      kind: "gone",
      isAgent: true,
    });
    expect(channelLabelParts(dm([ME, GONE]), dir, ME, { goneKind: "human" }).text).toBe("나간 멤버");
    expect(channelLabelParts(dm([ME, GONE]), dir, ME).text).toBe("나간 멤버");
    // 명부를 못 받았으면 종류와 무관하게 「불러오는 중」이다.
    expect(
      channelLabelParts(dm([ME, GONE]), makeDirectory([]), ME, { goneKind: "agent" })
    ).toMatchObject({ text: "불러오는 중", kind: "pending", isAgent: false });
  });

  it("명부를 아직 못 받았으면 「불러오는 중」이고, 받은 뒤에는 「나간 멤버」다", () => {
    expect(channelLabelParts(dm([ME, GONE]), makeDirectory([]), ME).text).toBe("불러오는 중");
    expect(
      channelLabelParts(dm([ME, GONE]), makeDirectory([self]), ME, { rosterReady: false }).text
    ).toBe("불러오는 중");
    expect(
      channelLabelParts(dm([ME, GONE]), makeDirectory([]), ME, { rosterReady: true }).text
    ).toBe("나간 멤버");
  });

  it("나 혼자뿐인 DM은 「이름 (나)」다", () => {
    const dir = makeDirectory([self]);
    expect(channelLabelParts(dm([ME]), dir, ME).text).toBe("구민수 (나)");
    expect(channelLabelParts(dm([ME]), makeDirectory([]), ME, { selfName: "구민수" }).text).toBe(
      "구민수 (나)"
    );
  });

  it("어떤 경우에도 섹션 제목 「다이렉트 메시지」를 대화 이름으로 쓰지 않는다", () => {
    const dirs = [makeDirectory([]), makeDirectory([self])];
    for (const dir of dirs) {
      for (const ids of [[ME, GONE], [ME], []]) {
        for (const ready of [undefined, true, false]) {
          const opts = ready === undefined ? undefined : { rosterReady: ready };
          expect(channelLabelParts(dm(ids), dir, ME, opts).text).not.toBe("다이렉트 메시지");
          expect(channelLabel(dm(ids), dir, ME, opts)).not.toContain("다이렉트 메시지");
        }
      }
    }
  });
});

describe("missingMemberLabel · 글쓴이 이름", () => {
  it("명부를 받은 뒤 없는 멤버는 「나간 멤버」, 받기 전에는 「불러오는 중」이며 id 조각이 아니다", () => {
    expect(missingMemberLabel(makeDirectory([self]))).toBe("나간 멤버");
    expect(missingMemberLabel(makeDirectory([]))).toBe("불러오는 중");
  });
});

// #4912 (S3 묶음 검증 R3). `dmPeer`가 null이라는 사실만으로는 「셋 이상 DM」과 「명부를 아직 못 받음」을 가를 수 없다.
// 그룹 판정은 머리 이름(`channelLabelParts`의 「… · N명」)이 쓰는 것과 **같은 판정**이어야, 머리가 3명이라 말하는데
// 소개 문구가 둘이라 말하는 일이 구조적으로 없다.
describe("dmGroupFacts · 3명 이상 DM의 참여자 사실", () => {
  const AGENT = "00000000-0000-7000-8000-00000000000D";
  const THIRD = "00000000-0000-7000-8000-00000000000E";
  const dir = makeDirectory([
    self,
    member({ id: PEER, displayName: "정하윤", handle: "hayun" }),
    member({ id: AGENT, kind: "agent", displayName: "코메토", handle: "cometo" }),
  ]);

  it("셋 이상이면 활성 참여자 전체와 그중 에이전트 수를 센다", () => {
    expect(dmGroupFacts(dm([ME, PEER, AGENT]), dir)).toEqual({ count: 3, agentCount: 1 });
    expect(dmGroupFacts(dm([ME, PEER, THIRD, AGENT]), dir)).toEqual({ count: 4, agentCount: 1 });
  });

  it("실제 1:1(둘 이하)과 DM이 아닌 방은 null이다 - 그쪽은 dmPeer가 말한다", () => {
    expect(dmGroupFacts(dm([ME, PEER]), dir)).toBeNull();
    expect(dmGroupFacts(dm([ME]), dir)).toBeNull();
    expect(dmGroupFacts(dm([]), dir)).toBeNull();
    const channel = { ...dm([ME, PEER, AGENT]), kind: "public" } as Channel;
    expect(dmGroupFacts(channel, dir)).toBeNull();
    expect(dmGroupFacts({ ...dm([ME, PEER, AGENT]), memberIds: undefined } as Channel, dir)).toBeNull();
  });

  it("명부에 없는 멤버는 에이전트로 세지 않는다 - 모르는 것을 에이전트라 부르지 않는다", () => {
    expect(dmGroupFacts(dm([ME, PEER, GONE]), dir)).toEqual({ count: 3, agentCount: 0 });
    expect(dmGroupFacts(dm([ME, PEER, AGENT]), makeDirectory([]))).toEqual({ count: 3, agentCount: 0 });
  });

  it("머리 이름과 같은 판정·같은 수다: 그룹이라 부르는 때와 「· N명」이 정확히 겹친다", () => {
    const everyone = [ME, PEER, AGENT, THIRD, GONE];
    for (let n = 0; n <= everyone.length; n += 1) {
      const channel = dm(everyone.slice(0, n));
      const facts = dmGroupFacts(channel, dir);
      const label = channelLabelParts(channel, dir, ME);
      expect(facts !== null, `n=${n}`).toBe(label.kind === "group");
      if (facts) expect(label.text.endsWith(` · ${facts.count}명`), `n=${n}`).toBe(true);
    }
  });
});

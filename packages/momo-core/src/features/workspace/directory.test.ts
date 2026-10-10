import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "../../lib/api";
import {
  channelLabel,
  channelLabelParts,
  makeDirectory,
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

const self = member({ id: ME, displayName: "곽성재", handle: "kwak" });

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
    expect(channelLabelParts(dm([ME]), dir, ME).text).toBe("곽성재 (나)");
    expect(channelLabelParts(dm([ME]), makeDirectory([]), ME, { selfName: "곽성재" }).text).toBe(
      "곽성재 (나)"
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

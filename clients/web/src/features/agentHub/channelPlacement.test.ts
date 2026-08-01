import { describe, expect, it } from "vitest";
import { ApiError, type Channel, type RosterMember } from "@/lib/api";
import {
  channelPlacement,
  placementFailure,
  placementReceipt,
} from "./channelPlacement";

const WS = "00000000-0000-7000-8000-000000000001";

function channel(id: string, name: string, kind: Channel["kind"] = "public"): Channel {
  return { id, workspaceId: WS, kind, name, muted: false } as Channel;
}

function agent(channelIds: string[]): RosterMember {
  return {
    id: "00000000-0000-7000-8000-0000000000a1",
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: channelIds.length,
    channelIds,
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const GENERAL = "00000000-0000-7000-8000-000000000201";
const ENGINE = "00000000-0000-7000-8000-000000000202";
const DM = "00000000-0000-7000-8000-0000000002d1";

describe("채널 배치", () => {
  it("들어가 있는 채널과 아직 아닌 채널을 가른다", () => {
    const placement = channelPlacement(agent([GENERAL]), [
      channel(GENERAL, "general"),
      channel(ENGINE, "엔진"),
    ]);
    expect(placement.present.map((c) => c.name)).toEqual(["general"]);
    expect(placement.available.map((c) => c.name)).toEqual(["엔진"]);
    expect(placement.unresolved).toBe(0);
  });

  it("uuid 대소문자가 달라도 같은 채널로 읽는다", () => {
    const placement = channelPlacement(agent([GENERAL.toUpperCase()]), [
      channel(GENERAL, "general"),
    ]);
    expect(placement.present).toHaveLength(1);
    expect(placement.available).toHaveLength(0);
  });

  it("DM은 배치 대상이 아니라 이름 없는 대화로 세지 않는다", () => {
    // 서버가 `c.kind IN ('public','private')`만 받으므로 DM은 후보가 아니고,
    // 볼 수 없는 채널과 한 칸에 담아 세면 "어딘가 더 있다"가 거짓말이 된다.
    const placement = channelPlacement(
      agent([GENERAL, DM]),
      [channel(GENERAL, "general")],
      [channel(DM, "", "dm")]
    );
    expect(placement.present.map((c) => c.name)).toEqual(["general"]);
    expect(placement.available).toHaveLength(0);
    expect(placement.unresolved).toBe(0);
  });

  it("볼 수 없는 채널의 멤버십은 세되 이름을 지어내지 않는다", () => {
    const hidden = "00000000-0000-7000-8000-0000000009ff";
    const placement = channelPlacement(agent([GENERAL, hidden]), [
      channel(GENERAL, "general"),
    ]);
    expect(placement.present).toHaveLength(1);
    expect(placement.unresolved).toBe(1);
  });
});

describe("배치 거절", () => {
  it("404는 두 가지 뜻을 모두 말하고 재시도를 시키지 않는다", () => {
    const message = placementFailure("add", new ApiError(404, "channel or member not found"));
    expect(message).toContain("지원하지 않거나");
    expect(message).not.toContain("다시 시도");
  });

  it("권한과 과다 요청은 서로 다른 다음 행동을 말한다", () => {
    expect(placementFailure("remove", new ApiError(403, "x"))).toContain("관리자");
    expect(placementFailure("add", new ApiError(429, "x"))).toContain("잠시 뒤");
  });

  it("동사가 행동에 맞는다", () => {
    expect(placementFailure("add", new ApiError(500, "x"))).toContain("채널에 추가하지");
    expect(placementFailure("remove", new ApiError(500, "x"))).toContain(
      "채널에서 내보내지"
    );
  });
});

describe("배치 영수증", () => {
  it("무엇이 가능해졌는지 말하고 조사를 결정한다", () => {
    expect(placementReceipt("add", "김인턴", "엔진")).toBe(
      "김인턴을 #엔진에 추가했습니다. 이제 그 채널에서 멘션할 수 있습니다."
    );
    expect(placementReceipt("remove", "hermes", "general")).toBe(
      "hermes를 #general에서 내보냈습니다. 그 채널의 멘션은 더 이상 전달되지 않습니다."
    );
  });
});

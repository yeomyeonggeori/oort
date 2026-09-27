import { describe, expect, it } from "vitest";
import type { RosterMember } from "../../lib/api";
import {
  teamLinkAffectedAgents,
  teamUnlinkBody,
  teamUnlinkTitle,
} from "./teamLinkImpact";

const member = (over: Partial<RosterMember>): RosterMember => ({
  id: "m",
  workspaceId: "w",
  kind: "agent",
  status: "active",
  displayName: "x",
  handle: "x",
  channelCount: 0,
  channelIds: [],
  capabilities: [],
  ...over,
});

const roster: RosterMember[] = [
  member({ id: "A1", displayName: "hermes", channelIds: ["c1"] }),
  member({ id: "a2", displayName: "김인턴", channelIds: ["c2", "c1", "c3"], paused: true }),
  member({ id: "a3", displayName: "내 Claude", channelIds: ["c1"] }),
  member({ id: "h1", kind: "human", displayName: "성재" }),
  member({ id: "a4", displayName: "지운 봇", status: "deleted" }),
];

describe("teamLinkAffectedAgents (#2880)", () => {
  it("활성 에이전트 가운데 호스티드 연결이 없는 것만, 이름과 채널로", () => {
    const affected = teamLinkAffectedAgents({
      roster,
      hostedAgentIds: ["A3"],
      channels: [
        { id: "c1", name: "리서치" },
        { id: "c2", name: "전체" },
      ],
    });
    expect(affected).toEqual([
      { id: "a2", name: "김인턴", where: "전체 외 2개 채널", paused: true },
      { id: "A1", name: "hermes", where: "리서치 채널", paused: false },
    ]);
  });

  it("호스티드 목록을 못 읽으면 숫자를 지어내지 않는다", () => {
    expect(teamLinkAffectedAgents({ roster, hostedAgentIds: null })).toBeNull();
    expect(teamLinkAffectedAgents({ roster: undefined, hostedAgentIds: [] })).toBeNull();
  });

  it("본문은 읽은 수만 말한다", () => {
    expect(teamUnlinkTitle("OpenAI · 팀 기본")).toBe("OpenAI · 팀 기본 연결을 끊을까요?");
    expect(teamUnlinkBody([{ id: "a", name: "a", where: null, paused: false }])).toMatch(/^이 키를 쓰는 팀 에이전트 1개가/);
    expect(teamUnlinkBody([])).toMatch(/^지금 이 키를 쓰는 팀 에이전트는 없어요/);
    expect(teamUnlinkBody(null)).not.toMatch(/\d/);
  });
});

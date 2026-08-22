import { describe, expect, it } from "vitest";
import type { RosterMember } from "../../lib/api";
import type { HostedAgentConnection } from "./model";
import {
  GROK_HOSTED_AGENT_ID,
  HOSTED_AGENT_SIGNATURES,
  hostedAgentDetected,
  hostedAgentSignature,
  matchHostedAgentMember,
  planHostedInvite,
  type HostedAgentProbe,
} from "./detect";

const CONNECTION = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const WS = "00000000-0000-7000-8000-000000000001";

function probe(
  overrides: Partial<HostedAgentProbe> = {}
): HostedAgentProbe {
  return {
    id: GROK_HOSTED_AGENT_ID,
    bundlePresent: true,
    processRunning: false,
    ...overrides,
  };
}

function connection(
  overrides: Partial<HostedAgentConnection> = {}
): HostedAgentConnection {
  return {
    id: CONNECTION,
    agentMemberId: AGENT,
    status: "pairing_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function member(overrides: Partial<RosterMember> = {}): RosterMember {
  return {
    id: AGENT,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "그록봇",
    handle: "grokbot",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("레지스트리 v1 은 Grok Bot 하나다", () => {
  it("시그니처 id 는 grok 하나이고 핸들은 서버 알파벳을 지킨다", () => {
    expect(HOSTED_AGENT_SIGNATURES.map((row) => row.id)).toEqual(["grok"]);
    const grok = hostedAgentSignature(GROK_HOSTED_AGENT_ID);
    expect(grok?.identity).toEqual({ displayName: "그록봇", handle: "grokbot" });
    expect(grok?.identity.handle).toMatch(/^[a-z0-9_-]+$/);
    expect(grok?.bundlePaths).toEqual(["/Applications/Grok Bot.app"]);
    expect(grok?.bundleIds).toEqual(["com.anysphere.sand"]);
    expect(grok?.processNames).toEqual(["Grok Bot"]);
  });

  it("초대 문장은 패킷의 원클릭 질문이고 엠대시·과장어가 없다", () => {
    const grok = hostedAgentSignature(GROK_HOSTED_AGENT_ID);
    expect(grok?.invitePrompt).toBe("그록봇을 팀에 초대할까요?");
    expect(grok?.inviteActionLabel).toBe("팀에 초대하기");
    const copy = HOSTED_AGENT_SIGNATURES.flatMap((row) => [
      row.invitePrompt,
      row.inviteActionLabel,
      row.recoverPrompt,
      row.recoverActionLabel,
      row.identity.displayName,
    ]).join("\n");
    expect(copy).not.toMatch(/[—–]/);
    expect(copy).not.toMatch(/seamless|effortless|unleash|elevate|원활한|손쉽게|매끄러운/);
  });
});

describe("감지는 수동적 시그니처만 본다", () => {
  it("번들 또는 프로세스 중 하나면 감지다", () => {
    expect(
      hostedAgentDetected(probe({ bundlePresent: true, processRunning: false }))
    ).toBe(true);
    expect(
      hostedAgentDetected(probe({ bundlePresent: false, processRunning: true }))
    ).toBe(true);
    expect(
      hostedAgentDetected(probe({ bundlePresent: false, processRunning: false }))
    ).toBe(false);
  });

  it("시그니처 표는 경로·번들 id·프로세스 이름만 들고 포트를 들지 않는다", () => {
    for (const row of HOSTED_AGENT_SIGNATURES) {
      const blob = JSON.stringify(row);
      expect(blob).not.toMatch(/9222|chrome-debugging|\/json\/version/i);
      expect(row.bundlePaths.join("\n")).not.toMatch(/localhost/);
    }
  });
});

describe("명부 매칭", () => {
  it("핸들이 이름보다 앞선다", () => {
    const rows = [
      member({ id: "a1", displayName: "그록봇", handle: "other" }),
      member({ id: "a2", displayName: "다른 이름", handle: "grokbot" }),
    ];
    expect(matchHostedAgentMember(rows, { displayName: "그록봇", handle: "grokbot" })?.id).toBe(
      "a2"
    );
  });

  it("삭제·정지 멤버와 사람은 고르지 않는다", () => {
    expect(
      matchHostedAgentMember(
        [member({ status: "deleted" })],
        { displayName: "그록봇", handle: "grokbot" }
      )
    ).toBeNull();
    expect(
      matchHostedAgentMember(
        [member({ kind: "human" })],
        { displayName: "그록봇", handle: "grokbot" }
      )
    ).toBeNull();
  });
});

describe("초대 계획은 미설치에서 침묵하고 활성 연결을 다시 만들지 않는다", () => {
  it("프로브가 없거나 둘 다 거짓이면 그리지 않는다", () => {
    expect(
      planHostedInvite({ probes: [], members: [], connections: [] })
    ).toBeNull();
    expect(
      planHostedInvite({
        probes: [probe({ bundlePresent: false, processRunning: false })],
        members: [],
        connections: [],
      })
    ).toBeNull();
  });

  it("감지됐고 연결이 없으면 원클릭 초대다", () => {
    const plan = planHostedInvite({
      probes: [probe()],
      members: [],
      connections: [],
    });
    expect(plan).toMatchObject({
      kind: "invite",
      autoAdvance: "create",
      handle: "grokbot",
      prompt: "그록봇을 팀에 초대할까요?",
    });
    expect(plan?.connectionId).toBeUndefined();
  });

  it("핸들이 이미 쓰이면 만들기를 자동으로 밟지 않는다", () => {
    const asExistingAgent = planHostedInvite({
      probes: [probe()],
      members: [member()],
      connections: [],
    });
    expect(asExistingAgent).toMatchObject({ kind: "invite" });
    expect(asExistingAgent?.autoAdvance).toBeUndefined();

    const asHumanHandle = planHostedInvite({
      probes: [probe()],
      members: [
        member({
          id: "human-1",
          kind: "human",
          displayName: "사람",
          handle: "grokbot",
        }),
      ],
      connections: [],
    });
    expect(asHumanHandle).toMatchObject({ kind: "invite" });
    expect(asHumanHandle?.autoAdvance).toBeUndefined();
  });

  it("재발급 가능한 연결이면 복구 경로다", () => {
    for (const status of ["pairing_pending", "detected", "expired"] as const) {
      const plan = planHostedInvite({
        probes: [probe()],
        members: [member()],
        connections: [connection({ status })],
      });
      expect(plan).toMatchObject({
        kind: "recover",
        autoAdvance: "regenerate",
        connectionId: CONNECTION,
        actionLabel: "연결 값 다시 발급",
      });
    }
  });

  it("활성·해제 계열은 초대 UI 를 그리지 않는다", () => {
    for (const status of ["active", "cleanup_pending", "disconnected"] as const) {
      expect(
        planHostedInvite({
          probes: [probe()],
          members: [member()],
          connections: [connection({ status })],
        })
      ).toBeNull();
    }
  });
});

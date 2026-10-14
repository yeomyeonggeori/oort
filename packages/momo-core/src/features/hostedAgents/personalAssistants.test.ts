import { describe, expect, it } from "vitest";
import type { RosterMember } from "../../lib/api";
import type { HostedAgentConnection } from "./model";
import {
  PERSONAL_ASSISTANTS,
  PERSONAL_ASSISTANTS_COPY,
  personalAssistantRows,
  soonPersonalAssistants,
} from "./personalAssistants";

const AGENT = "00000000-0000-7000-8000-0000000000a1";
const WS = "00000000-0000-7000-8000-000000000001";

function connection(over: Partial<HostedAgentConnection> = {}): HostedAgentConnection {
  return {
    id: "00000000-0000-7000-8000-0000000000c1",
    agentMemberId: AGENT,
    status: "pairing_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  };
}

function grok(over: Partial<RosterMember> = {}): RosterMember {
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
    createdAtMs: 1,
    ...over,
  } as RosterMember;
}

const row = (id: string, rows: ReturnType<typeof personalAssistantRows>) => {
  const found = rows.find((item) => item.entry.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

describe("개인 비서 목록 행 모델", () => {
  it("카탈로그 순서는 그록봇, dots, Muse이고 이름은 이니셜 마크만 쓴다", () => {
    expect(PERSONAL_ASSISTANTS.map((entry) => entry.id)).toEqual(["grok", "dots", "muse"]);
    for (const entry of PERSONAL_ASSISTANTS) {
      expect(entry.mark.length).toBe(1);
    }
  });

  it("제공사는 레포에 근거가 있는 줄에만 채운다 (Muse만, 그록봇·dots는 비움)", () => {
    const provider = Object.fromEntries(
      PERSONAL_ASSISTANTS.map((entry) => [entry.id, entry.provider ?? null])
    );
    expect(provider).toEqual({ grok: null, dots: null, muse: "Meta" });
  });

  it("연결이 없으면 「연결 안 됨」과 주 행동 「연결」 하나, 이름이 비어 있으면 자동 발급", () => {
    const rows = personalAssistantRows({ members: [], connections: [] });
    const grokRow = row("grok", rows);
    expect(grokRow.badge.text).toBe(PERSONAL_ASSISTANTS_COPY.notConnectedBadge);
    expect(grokRow.action?.kind).toBe("connect");
    expect(grokRow.action?.launch).toMatchObject({
      presetId: "grok",
      handle: "grokbot",
      autoAdvance: "create",
    });
  });

  it("핸들이 이미 쓰이면 자동 발급하지 않고 이름 단계로 떨어진다", () => {
    const other = grok({ id: "00000000-0000-7000-8000-0000000000b9", displayName: "다른 이름" });
    const rows = personalAssistantRows({ members: [other], connections: [] });
    // 핸들 grokbot 이 쓰이는 멤버가 있으면 그 멤버가 그록봇 줄의 주인이다.
    expect(row("grok", rows).action?.launch?.autoAdvance).toBeUndefined();
  });

  it("상태마다 행동이 정확히 하나이거나 없다", () => {
    const cases: Array<[Partial<HostedAgentConnection>, string | null]> = [
      [{ status: "pairing_pending" }, "regenerate"],
      [{ status: "expired" }, "regenerate"],
      [{ status: "detected" }, "approve"],
      [{ status: "detected", activeCredentialId: "cred" }, "resume"],
      [{ status: "active" }, "manage"],
      [{ status: "cleanup_pending" }, null],
    ];
    for (const [over, kind] of cases) {
      const rows = personalAssistantRows({
        members: [grok()],
        connections: [connection(over)],
      });
      const action = row("grok", rows).action;
      expect(action?.kind ?? null).toBe(kind);
      if (action && action.kind !== "manage") {
        expect(action.launch?.connectionId).toBe("00000000-0000-7000-8000-0000000000c1");
      }
    }
  });

  it("활성 행의 배지는 생존 라벨을 그리라는 표지이고 연결 상태 낱말로 말하지 않는다", () => {
    const rows = personalAssistantRows({
      members: [grok()],
      connections: [connection({ status: "active" })],
    });
    expect(row("grok", rows).badge).toMatchObject({ kind: "liveness", agentMemberId: AGENT });
  });

  it("해제 완료된 연결은 새 연결을 권한다", () => {
    const rows = personalAssistantRows({
      members: [grok()],
      connections: [connection({ status: "disconnected" })],
    });
    expect(row("grok", rows).action?.kind).toBe("connect");
  });

  it("dots와 Muse는 「곧」이고 행동이 없다", () => {
    const rows = personalAssistantRows({ members: [], connections: [] });
    for (const id of ["dots", "muse"]) {
      expect(row(id, rows).badge.text).toBe("곧");
      expect(row(id, rows).action).toBeNull();
    }
    expect(soonPersonalAssistants().map((entry) => entry.id)).toEqual(["dots", "muse"]);
  });

  it("연결 목록을 못 읽었으면 연결 안 됨으로 단정하지 않고 행동도 세우지 않는다", () => {
    const rows = personalAssistantRows({ members: [], connections: null });
    expect(row("grok", rows).action).toBeNull();
    expect(row("grok", rows).badge.text).toBe("");
  });
});

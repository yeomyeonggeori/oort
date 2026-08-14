import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { WireShapeError } from "../../lib/wire";
import type { HostedCleanupArtifact, HostedCleanupKind } from "./cleanup";
import { HOSTED_CLEANUP_KINDS, cleanupExpectedAction } from "./cleanup";
import {
  cleanupProgress,
  cleanupProgressSentence,
  disconnectLiveMessage,
  disconnectStartGate,
  manifestRepairGate,
  parseArtifactAcknowledgement,
  parseDisconnectCompletion,
  parseDisconnectStart,
  parseHostedConnectionDetail,
  revokeFacts,
  terminalGate,
  unresolvedRequired,
  DISCONNECT_IMMEDIATE_ITEMS,
  DISCONNECT_NOT_DONE_ITEMS,
  DISCONNECT_HISTORY_NOTE,
  CLEANUP_INDEPENDENCE_NOTE,
} from "./disconnect";
import {
  hostedFailureMessage,
  type HostedAgentConnection,
  type HostedConnectionStatus,
} from "./model";

const CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c1";
const AGENT_ID = "019f9a01-0000-7000-8000-000000000404";
const ARTIFACT_ID = "019f9a01-0000-7000-8000-0000000000a1";

function connection(
  status: HostedConnectionStatus,
  overrides: Partial<HostedAgentConnection> = {}
): HostedAgentConnection {
  return {
    id: CONNECTION_ID,
    agentMemberId: AGENT_ID,
    status,
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: ["agent:port:connect"],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function wireConnection(status: string) {
  return {
    id: CONNECTION_ID,
    agentMemberId: AGENT_ID,
    status,
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: ["agent:port:connect"],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  };
}

function artifact(
  kind: HostedCleanupKind,
  overrides: Partial<HostedCleanupArtifact> = {}
): HostedCleanupArtifact {
  return {
    id: `${ARTIFACT_ID}-${kind}`,
    kind,
    expectedAction: cleanupExpectedAction(kind),
    currentStatus: "unknown",
    disposition: "pending",
    resolved: false,
    required: true,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function seededManifest(): HostedCleanupArtifact[] {
  return HOSTED_CLEANUP_KINDS.map((kind) => artifact(kind));
}

function resolvedManifest(): HostedCleanupArtifact[] {
  return HOSTED_CLEANUP_KINDS.map((kind) =>
    artifact(kind, {
      currentStatus: "absent",
      disposition:
        kind === "bot" ? "preserved" : kind === "secret" ? "revoked" : "removed",
      resolved: true,
      source: kind === "secret" ? "server_verified" : "manual",
    })
  );
}

function wireArtifact(kind: HostedCleanupKind, extra: Record<string, unknown> = {}) {
  return {
    id: `${ARTIFACT_ID}-${kind}`,
    kind,
    expectedAction: cleanupExpectedAction(kind),
    currentStatus: "unknown",
    disposition: "pending",
    resolved: false,
    required: true,
    updatedAtMs: 1_700_000_000_000,
    ...extra,
  };
}

describe("RED PROOF ① 서버 상태가 화면을 정한다 (클라이언트 체크가 아니라)", () => {
  it("단건 조회는 커넥션과 목록을 함께 돌려준다", () => {
    const detail = parseHostedConnectionDetail({
      connection: wireConnection("cleanup_pending"),
      cleanupArtifacts: [wireArtifact("connector"), wireArtifact("bot")],
    });
    expect(detail.connection.status).toBe("cleanup_pending");
    expect(detail.artifacts.map((row) => row.kind)).toEqual(["connector", "bot"]);
  });

  it("해제 전 연결도 같은 형상으로 읽힌다", () => {
    const detail = parseHostedConnectionDetail({
      connection: wireConnection("active"),
      cleanupArtifacts: [],
    });
    expect(detail.artifacts).toEqual([]);
    expect(disconnectLiveMessage(detail.connection, detail.artifacts)).toContain(
      "아직 살아 있습니다"
    );
  });

  it("커넥션을 읽지 못하면 반쯤 그리지 않고 던진다", () => {
    expect(() => parseHostedConnectionDetail({ cleanupArtifacts: [] })).toThrow(
      WireShapeError
    );
  });
});

describe("RED PROOF ② 해제 시작 응답은 cleanup_pending 이어야 한다", () => {
  const body = {
    connection: wireConnection("cleanup_pending"),
    cleanupArtifacts: HOSTED_CLEANUP_KINDS.map((kind) => wireArtifact(kind)),
    remainingRequired: 6,
    startedNow: true,
  };

  it("정상 응답에서 목록과 남은 수와 시작 여부를 읽는다", () => {
    const started = parseDisconnectStart(body, { connectionId: CONNECTION_ID });
    expect(started.startedNow).toBe(true);
    expect(started.remainingRequired).toBe(6);
    expect(started.artifacts).toHaveLength(6);
  });

  it("재시도는 같은 형상에 startedNow=false 다", () => {
    const retried = parseDisconnectStart(
      { ...body, startedNow: false, remainingRequired: 4 },
      { connectionId: CONNECTION_ID }
    );
    expect(retried.startedNow).toBe(false);
    expect(retried.remainingRequired).toBe(4);
  });

  it("다른 커넥션이나 다른 상태를 실은 응답은 형상 오류다", () => {
    expect(() =>
      parseDisconnectStart(body, { connectionId: "019f9a01-0000-7000-8000-0000000005c2" })
    ).toThrow(WireShapeError);
    expect(() =>
      parseDisconnectStart(
        { ...body, connection: wireConnection("active") },
        { connectionId: CONNECTION_ID }
      )
    ).toThrow(WireShapeError);
  });
});

describe("RED PROOF ③ 확인 응답은 방금 손댄 줄의 것이어야 한다", () => {
  const body = {
    artifact: wireArtifact("connector", {
      currentStatus: "absent",
      disposition: "removed",
      resolved: true,
      source: "manual",
      evidence: "목록에서 사라진 것을 확인",
    }),
    remainingRequired: 5,
    changed: true,
  };

  it("id 가 같으면 읽고, 다르면 던진다", () => {
    const ack = parseArtifactAcknowledgement(body, {
      artifactId: `${ARTIFACT_ID}-connector`,
    });
    expect(ack.artifact.resolved).toBe(true);
    expect(ack.remainingRequired).toBe(5);
    expect(ack.changed).toBe(true);
    expect(() =>
      parseArtifactAcknowledgement(body, { artifactId: `${ARTIFACT_ID}-bot` })
    ).toThrow(WireShapeError);
  });

  it("바이트가 같은 반복은 changed=false 로 읽힌다", () => {
    const repeat = parseArtifactAcknowledgement(
      { ...body, changed: false },
      { artifactId: `${ARTIFACT_ID}-connector` }
    );
    expect(repeat.changed).toBe(false);
  });
});

describe("RED PROOF ④ 확정 응답은 disconnected 하나뿐이다", () => {
  it("정상 확정과 재생을 같은 형상으로 읽는다", () => {
    const body = {
      connection: wireConnection("disconnected"),
      cleanupArtifacts: [wireArtifact("bot")],
      disconnectedNow: true,
    };
    expect(
      parseDisconnectCompletion(body, { connectionId: CONNECTION_ID }).disconnectedNow
    ).toBe(true);
    expect(
      parseDisconnectCompletion(
        { ...body, disconnectedNow: false },
        { connectionId: CONNECTION_ID }
      ).disconnectedNow
    ).toBe(false);
  });

  it("아직 정리 중인 커넥션을 실은 200 은 형상 오류다", () => {
    expect(() =>
      parseDisconnectCompletion(
        {
          connection: wireConnection("cleanup_pending"),
          cleanupArtifacts: [],
          disconnectedNow: true,
        },
        { connectionId: CONNECTION_ID }
      )
    ).toThrow(WireShapeError);
  });
});

describe("RED PROOF ⑤ 미해결이 남은 동안 확정은 막히고, 막힌 이유가 보인다", () => {
  it("씨앗 목록은 여섯 줄 전부 미해결이다", () => {
    const gate = terminalGate(connection("cleanup_pending"), seededManifest());
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCopy).toContain("6개");
    // 다음에 무엇을 할지까지 말한다. 숫자만 있는 거절은 다음 수를 알려주지 않는다.
    expect(gate.blockedCopy).toContain("다음은");
  });

  it("커넥터 하나를 닫아도 로컬 파일 줄은 확정을 계속 막는다", () => {
    const manifest = seededManifest().map((row) =>
      row.kind === "connector"
        ? { ...row, disposition: "removed" as const, resolved: true, source: "manual" as const }
        : row
    );
    const gate = terminalGate(connection("cleanup_pending"), manifest);
    expect(gate.allowed).toBe(false);
    expect(unresolvedRequired(manifest).map((row) => row.kind)).toContain(
      "local_plugin_files"
    );
  });

  it("routine 을 꺼 두기만 한 것은 확정을 열지 않는다", () => {
    const manifest = resolvedManifest().map((row) =>
      row.kind === "routine"
        ? artifact("routine", { currentStatus: "inactive" })
        : row
    );
    const gate = terminalGate(connection("cleanup_pending"), manifest);
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCopy).toContain("1개");
  });

  it("전부 닫히면 열린다", () => {
    expect(terminalGate(connection("cleanup_pending"), resolvedManifest())).toEqual({
      allowed: true,
    });
  });

  it("빈 목록은 통과가 아니라 거절이고, 나가는 길을 말한다", () => {
    const gate = terminalGate(connection("cleanup_pending"), []);
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCopy).toContain("복원");
  });

  it("시작하지 않은 연결과 이미 끝난 연결은 서로 다른 문장으로 막힌다", () => {
    const notStarted = terminalGate(connection("active"), []);
    const done = terminalGate(connection("disconnected"), resolvedManifest());
    expect(notStarted.allowed).toBe(false);
    expect(done.allowed).toBe(false);
    expect(notStarted.blockedCopy).not.toBe(done.blockedCopy);
  });
});

describe("RED PROOF ⑥ 해제를 시작할 수 있는 상태는 서버의 그 둘뿐이다", () => {
  it("detected 와 active 에서만 열린다", () => {
    expect(disconnectStartGate(connection("detected")).allowed).toBe(true);
    expect(disconnectStartGate(connection("active")).allowed).toBe(true);
  });

  it("나머지 상태는 각자 다른 이유로 막힌다", () => {
    const blocked = (["pairing_pending", "expired", "cleanup_pending", "disconnected"] as const).map(
      (status) => disconnectStartGate(connection(status)).blockedCopy
    );
    expect(blocked.every((copy) => typeof copy === "string" && copy.length > 0)).toBe(true);
    expect(new Set(blocked).size).toBe(blocked.length);
    expect(disconnectStartGate(null).allowed).toBe(false);
  });

  it("목록 복원은 정리 중일 때만 열린다", () => {
    expect(manifestRepairGate(connection("cleanup_pending")).allowed).toBe(true);
    expect(manifestRepairGate(connection("active")).allowed).toBe(false);
    expect(manifestRepairGate(connection("disconnected")).allowed).toBe(false);
    expect(manifestRepairGate(null).allowed).toBe(false);
  });
});

describe("RED PROOF ⑦ 즉시 끊긴 것과 아직 남은 것을 나눠 말한다", () => {
  it("확인 화면이 두 문단을 갖고, 그 둘이 겹치지 않는다", () => {
    expect(DISCONNECT_IMMEDIATE_ITEMS.length).toBeGreaterThan(0);
    expect(DISCONNECT_NOT_DONE_ITEMS.length).toBeGreaterThan(0);
    for (const item of DISCONNECT_IMMEDIATE_ITEMS) {
      expect(DISCONNECT_NOT_DONE_ITEMS).not.toContain(item);
    }
  });

  it("기록이 지워지지 않는다는 사실을 명시한다", () => {
    expect(DISCONNECT_HISTORY_NOTE).toContain("지우는 일이 아닙니다");
    expect(DISCONNECT_NOT_DONE_ITEMS.join(" ")).toContain("지워지지 않습니다");
  });

  it("한 줄이 다른 줄을 대신하지 않는다는 사실이 목록 머리에 있다", () => {
    expect(CLEANUP_INDEPENDENCE_NOTE).toContain("커넥터");
    expect(CLEANUP_INDEPENDENCE_NOTE).toContain("routine");
  });

  it("해제 뒤 상태 화면이 폐기·일시정지·작업 정리를 함께 말한다", () => {
    const facts = revokeFacts(connection("cleanup_pending"));
    expect(facts.map((fact) => fact.key)).toEqual([
      "자격증명",
      "전용 에이전트",
      "진행 중이던 작업",
    ]);
    expect(facts[0]?.value).toContain("통과하지 못하고");
    expect(revokeFacts(connection("disconnected"))).toHaveLength(3);
  });

  it("아직 살아 있는 연결에는 그 세 줄이 없다", () => {
    for (const status of ["pairing_pending", "detected", "active", "expired"] as const) {
      expect(revokeFacts(connection(status))).toEqual([]);
    }
  });
});

describe("진행 표시", () => {
  it("남은 수와 다음 항목을 함께 센다", () => {
    const progress = cleanupProgress(seededManifest());
    expect(progress.total).toBe(6);
    expect(progress.resolved).toBe(0);
    expect(progress.remainingRequired).toBe(6);
    expect(progress.nextTitle).toBe("커넥터 설치");
  });

  it("필수가 아닌 줄은 확정을 막지 않는다", () => {
    const manifest = [
      ...resolvedManifest(),
      artifact("plugin", { id: "optional", required: false, externalRef: "실험용" }),
    ];
    expect(cleanupProgress(manifest).remainingRequired).toBe(0);
    expect(terminalGate(connection("cleanup_pending"), manifest).allowed).toBe(true);
  });

  it("빈 목록과 다 끝난 목록은 서로 다른 문장이다", () => {
    const empty = cleanupProgressSentence(cleanupProgress([]));
    const done = cleanupProgressSentence(cleanupProgress(resolvedManifest()));
    expect(empty).toContain("아직 없습니다");
    expect(done).toContain("모두 확인했습니다");
  });
});

describe("live region", () => {
  it("정리 중에는 끊긴 사실과 남은 수를 함께 읽는다", () => {
    const message = disconnectLiveMessage(
      connection("cleanup_pending"),
      seededManifest()
    );
    expect(message).toContain("권한은 끊겼습니다");
    expect(message).toContain("6개");
  });

  it("연결이 없으면 그 사실만 말한다", () => {
    expect(disconnectLiveMessage(null, [])).toContain("호스티드 연결이 없습니다");
  });
});

describe("거절 문구는 상태로만 갈린다", () => {
  it("세 동작이 각자 다른 머리말을 쓴다", () => {
    const prefixes = (["disconnect", "acknowledge", "complete"] as const).map((action) =>
      hostedFailureMessage(action, new ApiError(500, "boom"))
    );
    expect(new Set(prefixes).size).toBe(3);
    for (const message of prefixes) {
      expect(message).not.toContain("boom");
    }
  });

  it("409 셋이 서로 다른 다음 행동을 말한다", () => {
    const conflicts = (["disconnect", "acknowledge", "complete"] as const).map((action) =>
      hostedFailureMessage(action, new ApiError(409, "conflict"))
    );
    expect(new Set(conflicts).size).toBe(3);
    expect(conflicts[2]).toContain("남은 항목");
  });

  it("확인의 404 는 연결이 아니라 항목을 가리킨다", () => {
    expect(hostedFailureMessage("acknowledge", new ApiError(404, "x"))).toContain(
      "정리 항목"
    );
    expect(hostedFailureMessage("complete", new ApiError(404, "x"))).toContain(
      "이 연결"
    );
  });
});

import { describe, expect, it } from "vitest";
import { WireShapeError } from "../../lib/wire";
import type { HostedAgentConnection } from "./model";
// A/B 어휘의 정본은 #1362 의 ./cleanup·./disconnect 다(73ac11d4 랜딩). 이 테스트는
// 그 정본을 **읽어서** UX3 의 관전 뷰(Section C)가 정직하게 조립하는지를 본다.
import {
  cleanupEvidenceText,
  cleanupRowDetail,
  cleanupRowState,
  cleanupRowStateLabel,
  cleanupRowTone,
  toCleanupArtifact,
  type HostedCleanupArtifact,
} from "./cleanup";
import {
  cleanupProgress,
  cleanupProgressSentence,
  parseHostedConnectionDetail,
  unresolvedRequired,
} from "./disconnect";
import {
  HOSTED_LIVENESS_NOTE,
  HOSTED_OFFLINE_NOTE,
  HOSTED_READONLY_NOTE,
  HOSTED_STALE_LABEL,
  hostedArtifactRow,
  hostedConnectionTimes,
  hostedDetailView,
  hostedListRow,
} from "./status";

// =============================================================================
// #1359 HAP-UX3 — 읽기 전용 관전 표면의 코어.
//
// RED PROOF 넷 (이슈 acceptance):
//   ① status decoding — 상태·kind·source 를 어휘로만 해독한다.
//   ② unknown forward-compatible value — 모르는 어휘가 와도 화면이 죽지 않고,
//      모르는 줄은 조용히 빠진다(반쯤 그린 줄을 만들지 않는다).
//   ③ secret redaction — 파서가 필드를 이름으로 다시 지어 서버가 더 실은 것이
//      뷰모델에 닿지 못하고, server_verified 의 영어 evidence 는 화면 문자열이
//      되지 않는다.
//   ④ offline/stale rendering — 그 상태들이 active 와 다른 자기 문구를 갖는다.
// =============================================================================

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function connectionWire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONNECTION_ID,
    agentMemberId: AGENT_ID,
    status: "active",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: ["agent:port:connect"],
    activeCredentialId: "33333333-3333-4333-8333-333333333333",
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    ...over,
  };
}

function artifactWire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    kind: "connector",
    expectedAction: "remove",
    currentStatus: "unknown",
    disposition: "pending",
    resolved: false,
    required: true,
    updatedAtMs: 5_000,
    ...over,
  };
}

function artifact(over: Partial<HostedCleanupArtifact> = {}): HostedCleanupArtifact {
  return {
    id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    kind: "connector",
    expectedAction: "remove",
    currentStatus: "unknown",
    disposition: "pending",
    resolved: false,
    required: true,
    updatedAtMs: 5_000,
    ...over,
  };
}

describe("① status decoding", () => {
  it("reads a connection detail plus its cleanup manifest from one response", () => {
    const detail = parseHostedConnectionDetail({
      connection: connectionWire({ status: "cleanup_pending" }),
      cleanupArtifacts: [artifactWire()],
    });
    expect(detail.connection.status).toBe("cleanup_pending");
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.artifacts[0]?.kind).toBe("connector");
  });

  it("throws a shape error rather than half-drawing a connection with no id", () => {
    expect(() =>
      parseHostedConnectionDetail({ connection: connectionWire({ id: undefined }) })
    ).toThrow(WireShapeError);
  });

  it("treats an absent manifest as an empty list, not a different shape", () => {
    const detail = parseHostedConnectionDetail({ connection: connectionWire() });
    expect(detail.artifacts).toEqual([]);
  });

  it("separates the four row states — server_confirmed, resolved, observed, pending", () => {
    expect(
      cleanupRowState(artifact({ resolved: true, source: "server_verified" }))
    ).toBe("server_confirmed");
    expect(cleanupRowState(artifact({ resolved: true, source: "manual" }))).toBe(
      "resolved"
    );
    expect(cleanupRowState(artifact({ currentStatus: "inactive" }))).toBe(
      "observed"
    );
    expect(cleanupRowState(artifact({ currentStatus: "unknown" }))).toBe(
      "pending"
    );
  });

  it("does not let an observed-but-open routine read as confirmed", () => {
    // #1344: turning a routine's Active off is an observation, not a disposal.
    const off = artifact({ kind: "routine", currentStatus: "inactive", resolved: false });
    expect(cleanupRowState(off)).toBe("observed");
    expect(cleanupRowTone(cleanupRowState(off))).toBe("warn");
    expect(cleanupRowDetail(off)).toContain("아직 확인으로 넘어가지 않았습니다");
  });
});

describe("② unknown forward-compatible value", () => {
  it("drops an artifact whose kind this build does not know", () => {
    expect(toCleanupArtifact(artifactWire({ kind: "webhook_thing" }))).toBeNull();
  });

  it("drops an unknown disposition and currentStatus rather than guessing", () => {
    expect(toCleanupArtifact(artifactWire({ disposition: "quarantined" }))).toBeNull();
    expect(toCleanupArtifact(artifactWire({ currentStatus: "haunted" }))).toBeNull();
  });

  it("forgets an unknown source instead of drawing 「출처 미상」", () => {
    const row = toCleanupArtifact(artifactWire({ source: "provider_claimed" }));
    expect(row).not.toBeNull();
    expect(row?.source).toBeUndefined();
  });

  it("keeps the known rows when one unknown row is mixed in", () => {
    const detail = parseHostedConnectionDetail({
      connection: connectionWire({ status: "cleanup_pending" }),
      cleanupArtifacts: [
        artifactWire({ id: "known", kind: "secret", expectedAction: "revoke" }),
        artifactWire({ id: "alien", kind: "poltergeist" }),
      ],
    });
    expect(detail.artifacts.map((row) => row.id)).toEqual(["known"]);
  });
});

describe("③ secret redaction", () => {
  it("rebuilds the connection by named fields, so an injected secret cannot ride through", () => {
    const detail = parseHostedConnectionDetail({
      connection: connectionWire({
        pairingCredential: "SECRET-PAIRING",
        credential: "SECRET-ACTIVE",
        challenge: "SECRET-CHALLENGE",
      }),
    });
    const seen = JSON.stringify(detail.connection);
    expect(seen).not.toContain("SECRET");
    expect(Object.keys(detail.connection)).not.toContain("pairingCredential");
    expect(Object.keys(detail.connection)).not.toContain("credential");
  });

  it("rebuilds an artifact by named fields, dropping anything extra the server sent", () => {
    const row = toCleanupArtifact(
      artifactWire({ providerToken: "SECRET-TOKEN", fingerprint: "ab:cd:ef" })
    );
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain("SECRET-TOKEN");
    expect(Object.keys(row as object)).not.toContain("providerToken");
    expect(Object.keys(row as object)).not.toContain("fingerprint");
  });

  it("never renders the server_verified evidence (English operator text)", () => {
    const row = artifact({
      kind: "secret",
      expectedAction: "revoke",
      resolved: true,
      disposition: "revoked",
      source: "server_verified",
      evidence: "oort revoked 1 hosted credential(s) at 2026-08-15",
    });
    expect(cleanupEvidenceText(row)).toBeNull();
    // The Korean detail sentence stands in for it.
    expect(cleanupRowDetail(row)).toContain("oort가 직접 폐기");
    expect(cleanupRowStateLabel(row)).toBe("서버 확인");
  });

  it("does render a manual acknowledgement's own evidence", () => {
    const row = artifact({
      resolved: true,
      disposition: "removed",
      source: "manual",
      evidence: "커넥터 목록에서 제거를 눌렀고 목록에서 사라졌습니다",
    });
    expect(cleanupEvidenceText(row)).toBe(
      "커넥터 목록에서 제거를 눌렀고 목록에서 사라졌습니다"
    );
  });
});

describe("④ offline/stale/liveness copy is distinct from active", () => {
  it("keeps an offline sentence that names cached data, not a live state", () => {
    expect(HOSTED_OFFLINE_NOTE).toContain("마지막으로 받아 둔 상태");
    expect(HOSTED_STALE_LABEL).toContain("마지막으로 확인한 때");
  });

  it("refuses to sell updatedAtMs as a liveness heartbeat", () => {
    expect(HOSTED_LIVENESS_NOTE).toContain("상태가 마지막으로 바뀐 때");
    expect(HOSTED_LIVENESS_NOTE).toContain("실시간");
    expect(HOSTED_READONLY_NOTE).toContain("데스크톱");
  });

  it("names the two timestamps the read model actually carries", () => {
    const times = hostedConnectionTimes(
      // minimal typed connection
      {
        id: CONNECTION_ID,
        agentMemberId: AGENT_ID,
        status: "active",
        authMode: "static_bearer",
        audience: "/v1/mcp/agent-port",
        approvedChannelIds: [],
        approvedScopes: ["agent:port:connect"],
        createdAtMs: 1_000,
        updatedAtMs: 2_000,
      } satisfies HostedAgentConnection
    );
    expect(times).toEqual([
      { label: "연결 만든 때", atMs: 1_000 },
      { label: "마지막 상태 변화", atMs: 2_000 },
    ]);
  });
});

describe("progress and the assembled views", () => {
  it("counts only required-and-unresolved rows toward remaining, in screen order", () => {
    const rows: HostedCleanupArtifact[] = [
      artifact({ id: "r-routine", kind: "routine", required: true, resolved: false }),
      artifact({ id: "r-connector", kind: "connector", required: true, resolved: false }),
      artifact({ id: "done", kind: "plugin", required: true, resolved: true, source: "manual" }),
      artifact({ id: "optional", kind: "bot", expectedAction: "decide", required: false, resolved: false }),
    ];
    const remaining = unresolvedRequired(rows);
    expect(remaining.map((r) => r.id)).toEqual(["r-connector", "r-routine"]);
    const progress = cleanupProgress(rows);
    expect(progress.total).toBe(4);
    expect(progress.resolved).toBe(1);
    expect(progress.remainingRequired).toBe(2);
    expect(progress.nextTitle).toBe("커넥터 설치");
    expect(cleanupProgressSentence(progress)).toContain("2개 남았습니다");
    expect(cleanupProgressSentence(progress)).toContain("커넥터 설치");
  });

  it("says the required list is clear once nothing required remains", () => {
    const progress = cleanupProgress([
      artifact({ resolved: true, source: "manual", disposition: "removed" }),
    ]);
    expect(progress.remainingRequired).toBe(0);
    expect(cleanupProgressSentence(progress)).toContain("모두 확인했습니다");
  });

  it("builds a list row from status vocabulary, without inventing a cleanup count", () => {
    const row = hostedListRow(
      parseHostedConnectionDetail({ connection: connectionWire({ status: "detected", activeCredentialId: undefined }) })
        .connection,
      "  김인턴  "
    );
    expect(row.connectionId).toBe(CONNECTION_ID);
    expect(row.title).toBe("김인턴");
    expect(row.statusLabel).toBe("감지됨");
    expect(row.statusTone).toBe("warn");
    // detected-without-credential and detected-with-credential are different sentences.
    expect(row.statusDetail).toContain("아직 아무 권한도 열리지 않았습니다");
  });

  it("assembles a detail view: facts, status, times, and read-only cleanup rows", () => {
    const detail = parseHostedConnectionDetail({
      connection: connectionWire({ status: "cleanup_pending" }),
      cleanupArtifacts: [
        artifactWire({ id: "c1", kind: "connector", currentStatus: "present" }),
        artifactWire({
          id: "s1",
          kind: "secret",
          expectedAction: "revoke",
          resolved: true,
          disposition: "revoked",
          source: "server_verified",
          required: true,
        }),
      ],
    });
    const view = hostedDetailView(detail, "김인턴");
    expect(view.statusLabel).toBe("정리 중");
    expect(view.hasCleanup).toBe(true);
    expect(view.times.map((t) => t.label)).toEqual(["연결 만든 때", "마지막 상태 변화"]);
    // Connector sorts before secret (screen order), and the server-confirmed
    // secret carries no evidence string.
    expect(view.rows.map((r) => r.title)).toEqual(["커넥터 설치", "연결 자격증명"]);
    const secretRow = view.rows[1];
    expect(secretRow?.stateLabel).toBe("서버 확인");
    expect(secretRow?.evidence).toBeNull();
    // facts come from model.connectionFacts — closed key set, no provider claim.
    expect(view.facts.map((f) => f.key)).toEqual([
      "전용 에이전트",
      "연결 상태",
      "인증 방식",
      "허용 대상",
    ]);
  });

  it("maps hostedArtifactRow tone from state", () => {
    expect(hostedArtifactRow(artifact({ currentStatus: "unknown" })).tone).toBe("muted");
    expect(hostedArtifactRow(artifact({ currentStatus: "present" })).tone).toBe("warn");
    expect(
      hostedArtifactRow(artifact({ resolved: true, source: "manual" })).tone
    ).toBe("ok");
  });
});

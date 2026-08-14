import { describe, expect, it } from "vitest";
import {
  acknowledgeQuestion,
  acknowledgeReady,
  buildAcknowledgement,
  cleanupEvidenceText,
  cleanupDispositionLabel,
  cleanupExpectedAction,
  cleanupKindCopy,
  cleanupRowActionable,
  cleanupRowDetail,
  cleanupRowState,
  cleanupRowStateLabel,
  cleanupRowTitle,
  cleanupStatusLabel,
  dispositionChoices,
  evidenceIssue,
  evidenceIssueMessage,
  evidencePlaceholder,
  parseCleanupArtifacts,
  sortCleanupArtifacts,
  statusChoices,
  storedDisposition,
  toCleanupArtifact,
  CLEANUP_EVIDENCE_MAX_BYTES,
  HOSTED_CLEANUP_KINDS,
  HOSTED_CLEANUP_ORDER,
  type HostedCleanupArtifact,
  type HostedCleanupChoice,
  type HostedCleanupKind,
} from "./cleanup";

function artifact(
  overrides: Partial<HostedCleanupArtifact> = {}
): HostedCleanupArtifact {
  return {
    id: "019f9a01-0000-7000-8000-0000000000a1",
    kind: "connector",
    expectedAction: "remove",
    currentStatus: "unknown",
    disposition: "pending",
    resolved: false,
    required: true,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

const ALL_CHOICES: readonly HostedCleanupChoice[] = ["delete", "preserve", "revoke"];

describe("RED PROOF ① 처분 표는 데이터베이스 CHECK 의 복사본이다", () => {
  // 이 표가 갈리면 사람은 라디오를 고르고 증거를 다 적은 뒤에 400 을 듣는다.
  // 여기서는 표 자체를 소진적으로 못 박고, migration 072 의 문장과 글자 단위로
  // 대조하는 일은 파일을 읽을 수 있는 쪽이 한다(clients/web 의
  // hostedDisconnectScope.test.ts) — 코어는 레포 배치를 알면 안 된다(purity 게이트).
  it("종류는 여섯이고 그 여섯이 전부다", () => {
    expect([...HOSTED_CLEANUP_KINDS]).toEqual([
      "bot",
      "routine",
      "plugin",
      "connector",
      "local_plugin_files",
      "secret",
    ]);
  });

  it("preserve 는 bot 에만, revoke 는 secret 에만 legal 하다", () => {
    expect(storedDisposition("bot", "preserve")).toBe("preserved");
    expect(storedDisposition("bot", "delete")).toBe("removed");
    expect(storedDisposition("secret", "revoke")).toBe("revoked");
    for (const kind of ["routine", "plugin", "connector", "local_plugin_files"] as const) {
      expect(storedDisposition(kind, "delete")).toBe("removed");
      expect(storedDisposition(kind, "preserve")).toBeNull();
      expect(storedDisposition(kind, "revoke")).toBeNull();
    }
    expect(storedDisposition("bot", "revoke")).toBeNull();
    expect(storedDisposition("secret", "delete")).toBeNull();
    expect(storedDisposition("secret", "preserve")).toBeNull();
  });

  it("고를 수 있는 것만 목록에 서고, 목록 밖은 전부 거절이다", () => {
    // 서버 conformance 가 400 으로 못 박은 네 짝이 여기서도 목록 밖이다:
    // local_plugin_files/preserve, plugin/revoke, secret/delete, bot/revoke.
    for (const kind of HOSTED_CLEANUP_KINDS) {
      const offered = dispositionChoices(kind).map((choice) => choice.id);
      for (const choice of ALL_CHOICES) {
        const legal = storedDisposition(kind, choice) !== null;
        expect(offered.includes(choice)).toBe(legal);
      }
    }
    expect(dispositionChoices("bot").map((c) => c.id)).toEqual(["delete", "preserve"]);
    expect(dispositionChoices("secret").map((c) => c.id)).toEqual(["revoke"]);
    expect(dispositionChoices("local_plugin_files").map((c) => c.id)).toEqual(["delete"]);
  });

  it("요구 행동도 CHECK 와 한 표다", () => {
    expect(cleanupExpectedAction("bot")).toBe("decide");
    expect(cleanupExpectedAction("secret")).toBe("revoke");
    for (const kind of ["routine", "plugin", "connector", "local_plugin_files"] as const) {
      expect(cleanupExpectedAction(kind)).toBe("remove");
    }
  });
});

describe("RED PROOF ② 봇 삭제는 대화 기록을 파괴한다는 사실이 고르는 자리에 있다", () => {
  it("삭제 줄 자기 문장이 대화 기록을 말한다", () => {
    const remove = dispositionChoices("bot").find((c) => c.id === "delete");
    expect(remove?.detail).toContain("대화 기록");
    expect(remove?.destructive).toBe(true);
  });

  it("보존은 정식 종착이고, 재사용 위험을 함께 말한다", () => {
    const keep = dispositionChoices("bot").find((c) => c.id === "preserve");
    expect(keep).toBeDefined();
    expect(keep?.destructive).toBe(false);
    expect(keep?.detail).toContain("다시");
    // 보존한 줄은 닫힌 줄이다: 남기기로 정한 것도 답이다.
    const preserved = artifact({
      kind: "bot",
      disposition: "preserved",
      resolved: true,
      source: "manual",
    });
    expect(cleanupRowState(preserved)).toBe("resolved");
    expect(cleanupRowStateLabel(preserved)).toBe("남김");
    expect(cleanupRowDetail(preserved)).toContain("사유");
  });

  it("종류 안내가 함정을 감추지 않는다", () => {
    expect(cleanupKindCopy("connector").caution).toContain("로컬");
    expect(cleanupKindCopy("routine").caution).toContain("Active");
    expect(cleanupKindCopy("local_plugin_files").caution).toContain("oort");
    expect(cleanupKindCopy("bot").caution).toContain("대화 기록");
  });
});

describe("RED PROOF ③ 관측은 처분이 아니다", () => {
  it("꺼진 routine 은 확인이 아니라 관측으로 읽힌다", () => {
    const inactive = artifact({
      kind: "routine",
      expectedAction: "remove",
      currentStatus: "inactive",
      disposition: "pending",
      resolved: false,
    });
    expect(cleanupRowState(inactive)).toBe("observed");
    expect(cleanupRowStateLabel(inactive)).toBe("꺼짐");
    expect(cleanupRowDetail(inactive)).toContain("아직");
    expect(cleanupRowActionable(inactive)).toBe(true);
  });

  it("끌 수 없는 종류에는 꺼짐 선택지가 없다", () => {
    for (const kind of ["local_plugin_files", "secret"] as const) {
      expect(statusChoices(kind).map((c) => c.id)).toEqual(["present", "absent"]);
    }
    for (const kind of ["bot", "routine", "plugin", "connector"] as const) {
      expect(statusChoices(kind).map((c) => c.id)).toEqual([
        "present",
        "inactive",
        "absent",
      ]);
    }
  });

  it("아무 종류에도 「모르겠다」 선택지가 없다", () => {
    for (const kind of HOSTED_CLEANUP_KINDS) {
      expect(statusChoices(kind).some((c) => c.id === "unknown")).toBe(false);
    }
    // 그래도 씨앗 상태는 그릴 수 있어야 한다.
    expect(cleanupStatusLabel("unknown")).toBe("확인 전");
  });
});

describe("RED PROOF ④ 서버가 확인한 줄은 사람 확인과 다르게 읽힌다", () => {
  const serverRow = artifact({
    kind: "secret",
    expectedAction: "revoke",
    currentStatus: "absent",
    disposition: "revoked",
    resolved: true,
    source: "server_verified",
    acknowledgedAtMs: 1_700_000_000_500,
    evidence: "oort revoked 1 hosted credential(s) on this connection",
  });

  it("서버 확인 줄에는 사람이 손댈 자리가 없다", () => {
    expect(cleanupRowState(serverRow)).toBe("server_confirmed");
    expect(cleanupRowStateLabel(serverRow)).toBe("서버 확인");
    expect(cleanupRowActionable(serverRow)).toBe(false);
    expect(cleanupRowDetail(serverRow)).toContain("oort가 직접");
  });

  it("서버가 영어로 쓴 운영자 문장은 화면에 닿지 않는다", () => {
    expect(serverRow.evidence).toContain("hosted credential");
    expect(cleanupEvidenceText(serverRow)).toBeNull();
    // 사람이 적은 문장은 반대로 그대로 보인다.
    expect(
      cleanupEvidenceText(
        artifact({ source: "manual", evidence: "커넥터 목록에서 사라진 것을 확인" })
      )
    ).toBe("커넥터 목록에서 사라진 것을 확인");
    expect(cleanupEvidenceText(artifact())).toBeNull();
  });

  it("사람이 확인한 줄은 같은 낱말을 쓰지 않는다", () => {
    const manual = artifact({
      kind: "connector",
      disposition: "removed",
      resolved: true,
      source: "manual",
      acknowledgedBy: "019f9a01-0000-7000-8000-000000000404",
      evidence: "커넥터 목록에서 사라진 것을 확인",
    });
    expect(cleanupRowState(manual)).toBe("resolved");
    expect(cleanupRowStateLabel(manual)).toBe("제거됨");
    expect(cleanupRowStateLabel(manual)).not.toBe(cleanupRowStateLabel(serverRow));
  });

  it("아직 아무것도 없는 줄은 「확인 필요」이고 요구를 그대로 적는다", () => {
    const pending = artifact({ kind: "plugin" });
    expect(cleanupRowState(pending)).toBe("pending");
    expect(cleanupRowStateLabel(pending)).toBe("확인 필요");
    expect(cleanupRowDetail(pending)).toBe(cleanupKindCopy("plugin").expectation);
  });
});

describe("RED PROOF ⑤ 증거 없는 처분은 저장 대상이 아니다", () => {
  it("빈 값과 공백만 있는 값은 둘 다 거절이다", () => {
    expect(evidenceIssue("")).toBe("empty");
    expect(evidenceIssue("   \n\t ")).toBe("empty");
    expect(evidenceIssueMessage("empty")).toContain("한 줄");
  });

  it("길이는 글자가 아니라 바이트로 잰다", () => {
    // 한글 한 글자는 UTF-8 로 3바이트다. 글자로 재면 이 값이 통과하고 서버가
    // 400 을 답한다.
    const korean = "가".repeat(700);
    expect(korean.length).toBeLessThan(CLEANUP_EVIDENCE_MAX_BYTES);
    expect(new TextEncoder().encode(korean).byteLength).toBeGreaterThan(
      CLEANUP_EVIDENCE_MAX_BYTES
    );
    expect(evidenceIssue(korean)).toBe("tooLong");
    expect(evidenceIssue("가".repeat(600))).toBeNull();
  });

  it("처분을 골랐으면 증거 없이 저장할 수 없고, 관측만이면 저장할 수 있다", () => {
    expect(acknowledgeReady("connector", "delete", "")).toBe(false);
    expect(acknowledgeReady("connector", "delete", "목록에서 사라짐")).toBe(true);
    expect(acknowledgeReady("connector", null, "")).toBe(true);
    // 이 종류가 받지 않는 처분은 증거가 있어도 저장 대상이 아니다.
    expect(acknowledgeReady("connector", "preserve", "남겨 뒀습니다")).toBe(false);
  });

  it("본문은 legal 하지 않은 처분을 싣지 않는다 (fail-closed)", () => {
    expect(
      buildAcknowledgement("local_plugin_files", "present", "preserve", "남김")
    ).toEqual({ currentStatus: "present" });
    expect(buildAcknowledgement("routine", "inactive", null, "")).toEqual({
      currentStatus: "inactive",
    });
    expect(
      buildAcknowledgement("bot", "absent", "delete", "  지웠습니다  ")
    ).toEqual({
      currentStatus: "absent",
      disposition: "delete",
      evidence: "지웠습니다",
    });
  });

  it("처분을 기록하기 전에 되돌릴 수 없다는 사실을 묻는다", () => {
    const question = acknowledgeQuestion("bot", "delete");
    expect(question).toContain("대화 기록");
    expect(question).toContain("다시 정할 수 없습니다");
    expect(acknowledgeQuestion("bot", "preserve")).toContain("다시 정할 수 없습니다");
  });

  it("본문에 출처를 실을 칸이 없다", () => {
    const body = buildAcknowledgement("secret", "absent", "revoke", "사본 삭제");
    expect(Object.keys(body).sort()).toEqual([
      "currentStatus",
      "disposition",
      "evidence",
    ]);
  });
});

describe("RED PROOF ⑥ 줄 하나를 반쯤 그리지 않는다", () => {
  const wire = {
    id: "019f9a01-0000-7000-8000-0000000000a1",
    kind: "connector",
    expectedAction: "remove",
    currentStatus: "unknown",
    disposition: "pending",
    resolved: false,
    required: true,
    updatedAtMs: 1_700_000_000_000,
  };

  it("완전한 줄은 이름 붙은 필드로 다시 지어진다", () => {
    expect(toCleanupArtifact({ ...wire, secretPeek: "momo_agent_v1.xxx" })).toEqual({
      id: wire.id,
      kind: "connector",
      expectedAction: "remove",
      currentStatus: "unknown",
      disposition: "pending",
      resolved: false,
      required: true,
      updatedAtMs: wire.updatedAtMs,
    });
  });

  it("이 빌드가 모르는 어휘가 오면 줄이 통째로 없다", () => {
    expect(toCleanupArtifact({ ...wire, kind: "chat_history" })).toBeNull();
    expect(toCleanupArtifact({ ...wire, disposition: "archived" })).toBeNull();
    expect(toCleanupArtifact({ ...wire, currentStatus: "removed" })).toBeNull();
    expect(toCleanupArtifact({ ...wire, expectedAction: "purge" })).toBeNull();
    expect(toCleanupArtifact({ ...wire, resolved: "yes" })).toBeNull();
  });

  it("모르는 출처는 버려지고 「출처 미상」 줄이 되지 않는다", () => {
    const row = toCleanupArtifact({
      ...wire,
      disposition: "removed",
      resolved: true,
      source: "trust_me",
    });
    expect(row?.source).toBeUndefined();
    expect(row && cleanupRowState(row)).toBe("resolved");
  });

  it("목록은 사람의 동선 순서로 서고, 커넥터 바로 뒤에 로컬 파일이 온다", () => {
    const rows = parseCleanupArtifacts({
      cleanupArtifacts: HOSTED_CLEANUP_KINDS.map((kind, index) => ({
        ...wire,
        id: `019f9a01-0000-7000-8000-00000000000${index}`,
        kind,
        expectedAction: cleanupExpectedAction(kind),
      })),
    });
    expect(rows.map((row) => row.kind)).toEqual([...HOSTED_CLEANUP_ORDER]);
    const connector = rows.findIndex((row) => row.kind === "connector");
    expect(rows[connector + 1]?.kind).toBe("local_plugin_files");
  });

  it("해제 전에는 같은 형상의 빈 목록이다", () => {
    expect(parseCleanupArtifacts({ connection: {}, cleanupArtifacts: [] })).toEqual([]);
    expect(parseCleanupArtifacts({ connection: {} })).toEqual([]);
  });

  it("이름 붙은 항목은 씨앗 줄 뒤에 이름 순으로 선다", () => {
    const rows = sortCleanupArtifacts([
      artifact({ id: "c", kind: "routine", externalRef: "Oort Inbox: 팀 / 김인턴" }),
      artifact({ id: "a", kind: "routine" }),
      artifact({ id: "b", kind: "routine", externalRef: "Oort Inbox: 팀 / 박대리" }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["a", "c", "b"]);
  });
});

describe("줄 제목과 예시", () => {
  it("이름 붙은 항목은 종류와 이름을 함께 세운다", () => {
    expect(cleanupRowTitle(artifact({ kind: "connector" }))).toBe("커넥터 설치");
    expect(
      cleanupRowTitle(
        artifact({ kind: "routine", externalRef: "Oort Inbox: 디자인 / 김인턴" })
      )
    ).toBe("자동 실행 루틴: Oort Inbox: 디자인 / 김인턴");
  });

  it("제어문자가 섞인 이름은 한 줄로 접힌다", () => {
    const title = cleanupRowTitle(
      artifact({ kind: "plugin", externalRef: "oort\n\ninbox\tloader" })
    );
    expect(title).toBe("플러그인 등록: oort inbox loader");
  });

  it("증거 예시는 종류마다 다르다", () => {
    const examples = HOSTED_CLEANUP_KINDS.map(evidencePlaceholder);
    expect(new Set(examples).size).toBe(examples.length);
  });

  it("처분 낱말은 저장 어휘를 사람 말로 옮긴다", () => {
    expect(cleanupDispositionLabel("pending")).toBe("미확인");
    expect(cleanupDispositionLabel("removed")).toBe("제거됨");
    expect(cleanupDispositionLabel("preserved")).toBe("남김");
    expect(cleanupDispositionLabel("revoked")).toBe("폐기됨");
  });
});

describe("모든 종류가 자기 문장을 갖는다", () => {
  it("여섯 종류 전부 이름·요구·함정이 있다", () => {
    for (const kind of HOSTED_CLEANUP_KINDS as readonly HostedCleanupKind[]) {
      const copy = cleanupKindCopy(kind);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.expectation.length).toBeGreaterThan(0);
      expect(copy.caution.length).toBeGreaterThan(0);
      expect(dispositionChoices(kind).length).toBeGreaterThan(0);
      for (const choice of dispositionChoices(kind)) {
        expect(choice.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it("화면 순서가 여섯 종류를 하나도 빠뜨리지 않는다", () => {
    expect([...HOSTED_CLEANUP_ORDER].sort()).toEqual([...HOSTED_CLEANUP_KINDS].sort());
  });
});

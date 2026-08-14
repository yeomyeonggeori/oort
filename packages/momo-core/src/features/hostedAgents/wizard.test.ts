import { describe, expect, it } from "vitest";
import type { HostedAgentConnection } from "./model";
import {
  awaitingProof,
  confirmStateGate,
  hostedLiveMessage,
  hostedStepSpec,
  hostedWizardStep,
  HOSTED_PAIRING_TTL_MS,
  HOSTED_WIZARD_STEPS,
  pairingExpiry,
  regenerateGate,
  testMentionGate,
} from "./wizard";

// =============================================================================
// #1360 HAP-UX1 — 단계 기계.
//
// RED PROOF 넷:
//
//   ① 승인 직후 화면이 4단계로 되돌아가지 않는다. `hostedWizardStep` 에서
//      `activeCredentialId` 분기를 지우면 붉어진다.
//   ② 증명 전에는 테스트 멘션이 열리지 않는다. `testMentionGate` 의 `active`
//      검사를 지우면 붉어진다.
//   ③ 활성 커넥션의 재발급은 시도 전에 막힌다. `regenerateGate` 의 `active`
//      갈래를 지우면 붉어진다.
//   ④ live region 문장에는 비밀값이 들어갈 자리가 없다. `hostedLiveMessage` 가
//      커넥션 말고 다른 인자를 받기 시작하면 이 시그니처가 깨진다.
// =============================================================================

const CONNECTION = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const CREDENTIAL = "00000000-0000-7000-8000-0000000000e1";
const CHANNEL = "00000000-0000-7000-8000-000000000201";

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

describe("단계는 서버 상태에서 도출된다", () => {
  it("커넥션이 없으면 1단계", () => {
    expect(hostedWizardStep(null, false)).toBe("identity");
  });

  it("연결 값이 화면에 떠 있는 동안에는 2단계를 떠나지 않는다", () => {
    expect(hostedWizardStep(connection(), true)).toBe("pairing");
  });

  it("값을 저장하고 나면 같은 서버 상태에서 3단계로 간다", () => {
    // 지역 상태는 이 하나뿐이다. 서버는 값이 화면에 떠 있는지 알 수 없다.
    expect(hostedWizardStep(connection(), false)).toBe("detecting");
  });

  it("새로고침해도 서버 상태가 자리를 복원한다", () => {
    // 지역 상태 없이(=값이 안 떠 있는 채로) 물어도 감지 이후 자리는 그대로다.
    expect(hostedWizardStep(connection({ status: "detected" }), false)).toBe(
      "approval"
    );
    expect(hostedWizardStep(connection({ status: "active" }), false)).toBe(
      "activation"
    );
    expect(hostedWizardStep(connection({ status: "expired" }), false)).toBe(
      "expired"
    );
  });

  it("해제 계열은 이 마법사가 그리지 않는다", () => {
    expect(hostedWizardStep(connection({ status: "cleanup_pending" }), true)).toBe(
      "closed"
    );
    expect(hostedWizardStep(connection({ status: "disconnected" }), false)).toBe(
      "closed"
    );
  });
});

describe("RED PROOF ① 승인 직후 화면이 되돌아가지 않는다", () => {
  it("승인은 상태를 바꾸지 않으므로 자격증명 id 가 경계다", () => {
    const detected = connection({ status: "detected" });
    const confirmed = connection({
      status: "detected",
      activeCredentialId: CREDENTIAL,
    });
    expect(hostedWizardStep(detected, false)).toBe("approval");
    expect(hostedWizardStep(confirmed, false)).toBe("activation");
    expect(awaitingProof(confirmed)).toBe(true);
    expect(awaitingProof(connection({ status: "active" }))).toBe(false);
  });

  it("한 번 승인한 연결을 다시 승인하라고 권하지 않는다", () => {
    const gate = confirmStateGate(
      connection({ status: "detected", activeCredentialId: CREDENTIAL })
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCopy).toContain("이미 승인해");
  });
});

describe("RED PROOF ② 증명 전에는 테스트 멘션이 열리지 않는다", () => {
  it("승인만으로는 열리지 않는다", () => {
    const gate = testMentionGate(
      connection({
        status: "detected",
        activeCredentialId: CREDENTIAL,
        approvedChannelIds: [CHANNEL],
      })
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCopy).toContain("증명이 아직 성공하지 않았습니다");
  });

  it("활성이고 승인 채널이 있어야 열린다", () => {
    expect(
      testMentionGate(
        connection({ status: "active", approvedChannelIds: [CHANNEL] })
      ).allowed
    ).toBe(true);
  });

  it("활성이어도 승인 채널이 없으면 멘션할 자리가 없다고 말한다", () => {
    const gate = testMentionGate(connection({ status: "active" }));
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCopy).toContain("승인한 채널이 없습니다");
  });
});

describe("RED PROOF ③ 재발급 게이트는 서버의 409를 미리 말한다", () => {
  it("서버가 받는 세 상태에서만 열린다", () => {
    expect(regenerateGate(connection({ status: "pairing_pending" })).allowed).toBe(true);
    expect(regenerateGate(connection({ status: "detected" })).allowed).toBe(true);
    expect(regenerateGate(connection({ status: "expired" })).allowed).toBe(true);
  });

  it("활성 연결을 끊으려 시도한 뒤에야 이유를 듣게 하지 않는다", () => {
    const gate = regenerateGate(connection({ status: "active" }));
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCopy).toContain("먼저 이 연결을 해제해야 합니다");
  });

  it("해제된 연결은 새 연결을 만들라고 말한다", () => {
    expect(regenerateGate(connection({ status: "disconnected" })).blockedCopy).toContain(
      "새 연결을 만드세요"
    );
  });
});

describe("승인 상태 게이트", () => {
  it("감지 전에는 승인할 것이 없다", () => {
    expect(confirmStateGate(connection()).blockedCopy).toContain("다이얼인하지");
  });

  it("만료는 승인이 아니라 재발급을 가리킨다", () => {
    expect(confirmStateGate(connection({ status: "expired" })).blockedCopy).toContain(
      "새 값을 발급한 뒤"
    );
  });

  it("감지되고 아직 승인 전이면 열린다", () => {
    expect(confirmStateGate(connection({ status: "detected" })).allowed).toBe(true);
  });
});

describe("만료 표시", () => {
  it("서버 TTL 을 화면이 다시 지어내지 않는다", () => {
    expect(HOSTED_PAIRING_TTL_MS).toBe(15 * 60 * 1000);
  });

  it("분으로 말하고 초로 재촉하지 않는다", () => {
    const now = 1_700_000_000_000;
    expect(pairingExpiry(now + 14 * 60_000 + 30_000, now).label).toBe("약 14분 뒤 만료");
    expect(pairingExpiry(now + 30_000, now).label).toBe("1분 안에 만료");
  });

  it("지난 값은 만료로 말한다", () => {
    const now = 1_700_000_000_000;
    expect(pairingExpiry(now - 1, now)).toEqual({ expired: true, label: "만료됨" });
  });
});

describe("RED PROOF ④ 진행 표시와 live region", () => {
  it("다섯 단계에 번호가 1부터 5까지 붙는다", () => {
    expect(HOSTED_WIZARD_STEPS.map((step) => step.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("만료는 자기 번호를 갖지 않고 가로막은 단계의 번호를 쓴다", () => {
    expect(hostedStepSpec("expired").number).toBe(2);
    expect(hostedStepSpec("approval").number).toBe(4);
  });

  it("5단계 문장은 증명 전후로 갈린다", () => {
    const waiting = hostedLiveMessage(
      "activation",
      connection({ status: "detected", activeCredentialId: CREDENTIAL })
    );
    const done = hostedLiveMessage("activation", connection({ status: "active" }));
    expect(waiting).toContain("provider 설정의 값을 바꾸면");
    expect(done).toContain("연결이 활성입니다");
  });

  it("어느 단계의 문장에도 비밀값이 들어갈 자리가 없다", () => {
    // 인자가 커넥션 하나뿐이고 커넥션 타입에는 비밀값 필드가 없다. 이 단정은
    // 문자열을 재는 것이 아니라 **입력의 모양**을 못으로 박는다.
    const spoken = (["identity", "pairing", "detecting", "approval", "activation", "expired", "closed"] as const).map(
      (step) => hostedLiveMessage(step, connection({ status: "detected" }))
    );
    for (const sentence of spoken) {
      expect(sentence).not.toMatch(/momo_pair_v1|momo_agent/);
      expect(sentence.length).toBeGreaterThan(0);
    }
  });
});

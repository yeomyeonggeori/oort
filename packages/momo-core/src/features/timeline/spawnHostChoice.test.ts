import { describe, expect, it } from "vitest";
import type { SpawnExecutionPlan } from "../../lib/executionPlan";
import {
  candidateLabel,
  decisionHostId,
  NO_ELIGIBLE_HOST_COPY,
  offersHostChoice,
  preselectedHostId,
  selectableHosts,
  spawnDestinationClause,
  spawnHostGate,
  tierLabel,
  unavailableReasonCopy,
} from "./spawnHostChoice";

// =============================================================================
// #1114 클라 축 — 픽커의 선택 규칙.
//
// RED PROOF 두 개가 이 파일에 산다(게이트가 DOM에서 같은 것을 다시 잡는다):
//
//   ① 선택 불가 호스트는 결정 본문에 실리지 않는다 (서버 403 경로가 열리지 않는다)
//   ② 사람이 아무것도 안 고르면 카드의 기본값이 적용된다 (키를 안 싣는다)
//
// 규칙을 되돌리면 이름을 부르며 붉어진다: `decisionHostId`에서 `!picked.selectable`
// 가드를 지우면 ①이, 기본값 비교를 지우면 ②가 실패한다.
// =============================================================================

const LOCAL = "00000000-0000-7000-8000-0000000000a1";
const REMOTE = "00000000-0000-7000-8000-0000000000a2";
const DEAD = "00000000-0000-7000-8000-0000000000a3";
const CLOUD = "00000000-0000-7000-8000-0000000000a4";

function plan(overrides: Partial<SpawnExecutionPlan> = {}): SpawnExecutionPlan {
  return {
    kind: "work_session_spawn",
    tool: "codex",
    label: "리팩터링",
    defaultHostId: LOCAL,
    candidates: [
      {
        hostId: LOCAL,
        displayName: "내 맥",
        tier: "local",
        online: true,
        selectable: true,
      },
      {
        hostId: REMOTE,
        displayName: "팀 VPS",
        tier: "remote",
        online: true,
        selectable: true,
      },
      {
        hostId: DEAD,
        displayName: "낡은 맥",
        tier: "local",
        online: false,
        selectable: false,
        unavailableReason: "offline",
      },
      {
        hostId: CLOUD,
        displayName: "momo Cloud",
        tier: "cloud",
        online: true,
        selectable: false,
        unavailableReason: "t3_disabled",
      },
    ],
    ...overrides,
  };
}

describe("미리 골라지는 호스트", () => {
  it("서버가 고른 기본값 그대로 (ADR-0125 D6-A: 로컬 온라인 우선)", () => {
    expect(preselectedHostId(plan())).toBe(LOCAL);
  });

  it("기본값이 자격을 잃었으면 첫 자격 후보로 내려간다", () => {
    // 지어낸 상황이 아니다: REST 컨트롤 경로는 자격 후보가 없을 때 기본값을 모델이
    // 겨냥한 호스트로 되돌린다(`work_controls.rs:467`). 그 호스트가 오프라인이면
    // 카드의 기본값이 고를 수 없는 것을 가리킨다.
    expect(preselectedHostId(plan({ defaultHostId: DEAD }))).toBe(LOCAL);
  });

  it("자격 후보가 없으면 아무것도 찍히지 않는다", () => {
    const none = plan({
      defaultHostId: undefined,
      candidates: plan().candidates.filter((c) => !c.selectable),
    });
    expect(preselectedHostId(none)).toBeNull();
    expect(selectableHosts(none)).toHaveLength(0);
  });
});

describe("RED PROOF ② — 안 고르면 카드의 기본값이 적용된다", () => {
  it("찍힌 그대로 결정하면 hostId 키를 싣지 않는다", () => {
    // 서버는 같은 payload의 `default_host_id`를 적용하므로 결과가 같고, 키를 빼는
    // 쪽이 정직하다: 사람이 선택이라는 행위를 하지 않았다는 사실이 그대로 남는다.
    expect(decisionHostId(plan(), preselectedHostId(plan()))).toBeUndefined();
  });

  it("다른 호스트로 바꾸면 명시적으로 싣는다", () => {
    expect(decisionHostId(plan(), REMOTE)).toBe(REMOTE);
  });

  it("기본값이 자격을 잃어 화면이 다른 것을 찍었으면 그것을 싣는다", () => {
    // 여기서 키를 빼면 서버가 자격 없는 기본값을 집어 들고 409로 거절한다 — 사람은
    // 자격 있는 호스트가 찍힌 화면을 보고 눌렀는데 "쓸 수 있는 호스트가 없다"를 받는다.
    const shifted = plan({ defaultHostId: DEAD });
    expect(decisionHostId(shifted, preselectedHostId(shifted))).toBe(LOCAL);
  });

  it("대소문자가 다른 같은 uuid는 같은 호스트다", () => {
    // UUID는 이 와이어를 섞인 대소문자로 건넌다(Swift=UPPER, PG JSON=lower).
    expect(decisionHostId(plan(), LOCAL.toUpperCase())).toBeUndefined();
  });
});

describe("RED PROOF ① — 자격 없는 호스트는 전송되지 않는다", () => {
  it("오프라인 호스트를 골라도 본문에 실리지 않는다", () => {
    // 화면이 그것을 고르게 두지 않는 것이 1차 방어이고 이것이 2차다. 서버의 403은
    // 3차이며, 그 셋이 다 필요한 이유는 각각이 다른 실패를 막기 때문이다.
    expect(decisionHostId(plan(), DEAD)).toBeUndefined();
  });

  it("T3 슬롯도 마찬가지다", () => {
    expect(decisionHostId(plan(), CLOUD)).toBeUndefined();
  });

  it("후보에 아예 없는 호스트는 실리지 않는다", () => {
    expect(decisionHostId(plan(), "00000000-0000-7000-8000-00000000ffff")).toBeUndefined();
  });

  it("픽커가 없는 승인에는 무엇을 골랐든 싣지 않는다 (서버 400을 열지 않는다)", () => {
    expect(decisionHostId(null, LOCAL)).toBeUndefined();
    expect(decisionHostId(plan({ candidates: [] }), LOCAL)).toBeUndefined();
  });
});

describe("등록된 호스트가 하나도 없을 때 (빈 후보 목록)", () => {
  // 서버는 이 경우에도 `host_candidates` 키를 싣는다 — 빈 배열로. 그래서 서버의
  // `offers_host_choice`는 **참**이고, 결정은 409(`no eligible work host is
  // available`)로 끝난다. 클라이언트가 개수로 판정하면 같은 payload를 보고 반대로
  // 읽어(「이 카드는 호스트를 묻지 않는다」) 승인 버튼을 멀쩡히 세우고, 사람은
  // 이유 없는 실패를 받는다.
  const empty = plan({ candidates: [], defaultHostId: undefined });

  it("여전히 호스트를 묻는 카드다 — 개수가 아니라 키가 판정한다", () => {
    expect(offersHostChoice(empty)).toBe(true);
  });

  it("승인이 막히고, 그 이유를 결정 전에 말한다", () => {
    const gate = spawnHostGate(empty);
    expect(gate.canApprove).toBe(false);
    expect(gate.blockedCopy).toBe(NO_ELIGIBLE_HOST_COPY);
  });

  it("찍히는 것도, 보낼 것도 없다", () => {
    expect(preselectedHostId(empty)).toBeNull();
    expect(decisionHostId(empty, LOCAL)).toBeUndefined();
  });
});

describe("승인 게이트", () => {
  it("픽커가 없는 승인은 이 규칙이 판단할 것이 없다", () => {
    expect(spawnHostGate(null).canApprove).toBe(true);
    expect(offersHostChoice(null)).toBe(false);
  });

  it("자격 후보가 하나라도 있으면 승인할 수 있다", () => {
    expect(spawnHostGate(plan()).canApprove).toBe(true);
  });

  it("자격 후보가 없으면 승인이 막히고 이유가 선다", () => {
    // 서버가 409로 답할 것을 결정 **전에** 말한다. 거부는 이 게이트와 무관하다 —
    // 서버도 거부면 호스트를 아예 묻지 않는다.
    const none = plan({
      candidates: plan().candidates.filter((c) => !c.selectable),
    });
    const gate = spawnHostGate(none);
    expect(gate.canApprove).toBe(false);
    expect(gate.blockedCopy).toBe(NO_ELIGIBLE_HOST_COPY);
  });
});

describe("문구", () => {
  it("T3 자리는 「momo Cloud (준비 중)」이다", () => {
    const cloud = plan().candidates.find((c) => c.hostId === CLOUD)!;
    expect(candidateLabel(cloud)).toBe("momo Cloud (준비 중)");
  });

  it("오프라인 호스트는 이름 옆에서 그 사실을 말한다", () => {
    const dead = plan().candidates.find((c) => c.hostId === DEAD)!;
    expect(candidateLabel(dead)).toBe("낡은 맥 (오프라인)");
  });

  it("고를 수 있는 호스트에는 아무 꼬리표도 붙지 않는다", () => {
    const local = plan().candidates.find((c) => c.hostId === LOCAL)!;
    expect(candidateLabel(local)).toBe("내 맥");
  });

  it("모르는 사유는 서버 어휘를 화면에 내보내지 않는다", () => {
    expect(unavailableReasonCopy("quota_exhausted")).toBe("지금 선택할 수 없음");
    expect(unavailableReasonCopy(undefined)).toBeNull();
  });

  it("모르는 tier에는 아무 말도 하지 않는다", () => {
    expect(tierLabel("unknown")).toBeNull();
    expect(tierLabel("local")).toBe("로컬");
  });

  it("확정 문장이 목적지를 말한다", () => {
    expect(spawnDestinationClause("내 맥")).toBe("「내 맥」에서 실행합니다.");
  });
});

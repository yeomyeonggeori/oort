import { describe, expect, it } from "vitest";
import {
  approvalItem,
  mentionItem,
  runItem,
  type ActorNames,
} from "@momo/core/features/inbox/model";
import {
  interpretReceipt,
  unreadableAnswerOutcome,
  type DecisionOutcome,
} from "@momo/core/features/timeline/approvalDecision";
import {
  approveConfirmCopy,
  REJECT_CONFIRM,
} from "@/features/timeline/ApprovalActions";
import type {
  AgentRun,
  Approval,
  ApprovalStatus,
  Message,
} from "@momo/core/lib/api";
import {
  agentsFeedPartial,
  approvalRowControl,
  approvalsPanelState,
  decidableCount,
  decisionNote,
  APPROVED_RECEIPT,
  REJECTED_RECEIPT,
} from "./approvalsPanel";

// =============================================================================
// 웹 승인함의 계약 (goal W-AP1).
//
// 이 표면은 이 제품에서 **되돌릴 수 없는 유일한 액션 계열**을 다룬다. 그래서 여기
// 적힌 것은 취향이 아니라 두 문장이고, 둘 다 깨지면 화면이 사람에게 거짓말을 한다:
//
//   ① 결정 컨트롤은 **대기 중인 승인 행에만** 붙는다. 이미 승인된·거부된·만료된
//      행에 버튼이 서면 사람은 이미 끝난 일을 되돌릴 수 있다고 읽는다.
//   ② 서버가 "아직 없는 기능"이라고 답한 것과 "지금 고장났다"는 다른 칸이다.
//      전자는 기다릴 일이고 후자는 다시 시도할 일이다.
//
// 픽스처는 서버 DTO 모양 그대로(server-rust dto.rs ApprovalDto) 만들어 momo-core의
// 진짜 `approvalItem`을 태운다. 여기서 FeedItem을 손으로 빚으면 이 테스트는
// 자기가 만든 모양만 검사하게 되고, `approvalId`를 다는 규칙이 바뀌어도 초록으로
// 남는다.
// =============================================================================

const NOW_MS = 1_785_238_400_000;
const AGENT: ActorNames = {
  name: "김인턴",
  handle: "kim-intern",
  isAgent: true,
  ownerName: "곽성재",
};
const HUMAN: ActorNames = { name: "곽성재", isAgent: false };

function approval(status: ApprovalStatus, id = `approval-${status}`): Approval {
  return {
    id,
    workspaceId: "00000000-0000-7000-8000-000000000001",
    runId: "00000000-0000-7000-8000-000000000301",
    channelId: "00000000-0000-7000-8000-000000000201",
    requestedBy: "00000000-0000-7000-8000-000000000102",
    actionType: "work.exec",
    status,
    ...(status === "pending"
      ? { expiresAtMs: NOW_MS + 600_000 }
      : { decidedAtMs: NOW_MS - 60_000 }),
  };
}

function pendingRow(id = "approval-pending") {
  return approvalItem(approval("pending", id), AGENT, "배포", NOW_MS);
}

// ---- ① 다섯 갈래 -----------------------------------------------------------

describe("approvalsPanelState", () => {
  const base = { isLoading: false, absent: false, error: false, count: 0 };

  it("첫 응답을 기다리는 동안은 로딩", () => {
    expect(approvalsPanelState({ ...base, isLoading: true })).toBe("loading");
  });

  it("답은 왔는데 아무것도 없으면 빈 상태 (실패가 아니다)", () => {
    expect(approvalsPanelState(base)).toBe("empty");
  });

  it("실패했고 손에 아무것도 없으면 오류", () => {
    expect(approvalsPanelState({ ...base, error: true })).toBe("error");
  });

  it("서버가 그 경로를 모른다고 답하면 미제공이지 오류가 아니다", () => {
    // 404/405/501은 `error`도 함께 참으로 온다. 그때 오류로 접히면 화면은
    // "다시 시도"를 권하고, 다시 시도해도 영영 같은 답이 온다.
    expect(
      approvalsPanelState({ ...base, absent: true, error: true })
    ).toBe("unavailable");
  });

  it("미제공은 캐시된 행보다 앞선다: 누를 수 없는 버튼을 세우지 않는다", () => {
    expect(
      approvalsPanelState({ ...base, absent: true, error: true, count: 3 })
    ).toBe("unavailable");
  });

  it("손에 행이 있으면 재조회 중에도 스켈레톤으로 덮지 않는다 (P15)", () => {
    expect(approvalsPanelState({ ...base, isLoading: true, count: 2 })).toBe(
      "list"
    );
    expect(approvalsPanelState({ ...base, error: true, count: 2 })).toBe("list");
  });

  it("다섯 갈래는 서로 배타적이다", () => {
    const seen = new Set(
      [
        approvalsPanelState({ ...base, absent: true }),
        approvalsPanelState({ ...base, isLoading: true }),
        approvalsPanelState({ ...base, error: true }),
        approvalsPanelState(base),
        approvalsPanelState({ ...base, count: 1 }),
      ]
    );
    expect([...seen].sort()).toEqual([
      "empty",
      "error",
      "list",
      "loading",
      "unavailable",
    ]);
  });
});

// ---- ② red proof 1: 결정 컨트롤의 자격 -------------------------------------

describe("approvalRowControl", () => {
  it("대기 중인 승인 행만 결정 컨트롤을 받는다", () => {
    const control = approvalRowControl(pendingRow(), { offline: false });
    expect(control).toEqual({
      kind: "decide",
      approvalId: "approval-pending",
    });
  });

  // ↓ red proof ①. `approvalRowControl`의 `approvalId === undefined` 분기를
  //   부수면(예: 항상 decide를 돌려주면) 이 테스트가 상태 이름을 부르며 실패한다.
  it.each<ApprovalStatus>(["approved", "rejected", "expired", "cancelled"])(
    "이미 %s된 승인에는 결정 컨트롤이 붙지 않는다 (되돌릴 수 없는 액션)",
    (status) => {
      const item = approvalItem(approval(status), AGENT, "배포", NOW_MS);
      expect(item.approvalId).toBeUndefined();
      expect(approvalRowControl(item, { offline: false })).toEqual({
        kind: "none",
      });
    }
  );

  it("승인이 아닌 행에는 승인 결정 컨트롤이 붙지 않는다", () => {
    const message: Message = {
      id: "00000000-0000-7000-8000-000000000401",
      channelId: "00000000-0000-7000-8000-000000000201",
      seq: 42,
      hlcTs: NOW_MS - 30_000,
      hlcCount: 0,
      authorMemberId: "00000000-0000-7000-8000-000000000102",
      type: "text",
      body: "@곽성재 배포 확인 부탁드립니다",
      createdAtMs: NOW_MS - 30_000,
    };
    // 승인 대기 중인 **작업 실행** 행이다. 결정 컨트롤이 승인 행이 아니라
    // 「승인 대기」라는 글자를 보고 붙는다면 여기서 잡힌다.
    const run: AgentRun = {
      id: "00000000-0000-7000-8000-000000000501",
      workspaceId: "00000000-0000-7000-8000-000000000001",
      agentMemberId: "00000000-0000-7000-8000-000000000102",
      channelId: "00000000-0000-7000-8000-000000000201",
      status: "awaiting_approval",
      stepCount: 2,
      maxSteps: 8,
      createdAtMs: NOW_MS - 90_000,
      updatedAtMs: NOW_MS - 60_000,
    };

    for (const item of [
      mentionItem(message, HUMAN, "배포", NOW_MS),
      runItem(run, AGENT, "배포", NOW_MS),
    ]) {
      expect(approvalRowControl(item, { offline: false })).toEqual({
        kind: "none",
      });
    }
  });

  it("끊겨 있으면 자리는 지키되 결정은 보내지 않는다", () => {
    expect(approvalRowControl(pendingRow(), { offline: true })).toEqual({
      kind: "offline",
    });
  });

  it("끊김은 자격을 만들지 못한다: 결정할 수 없는 행은 여전히 none", () => {
    const settled = approvalItem(approval("approved"), AGENT, "배포", NOW_MS);
    expect(approvalRowControl(settled, { offline: true })).toEqual({
      kind: "none",
    });
  });
});

// ---- ③ red proof 2: 이미 결정된 요청은 사고가 아니다 ------------------------

describe("decisionNote", () => {
  // 서버가 409에 실어 보내는 진짜 영수증 모양(dto.rs ApprovalDecisionReceipt)을
  // momo-core의 `interpretReceipt`에 그대로 태운다. 이 왕복이 red proof ②다:
  // 폰 푸시에서 먼저 승인해 둔 사람이 웹에서 한 번 더 누르는 것은 예외가 아니라
  // 정상 경로이고, 그 답이 빨간 role="alert"로 그려지면 화면은 정상적인 상태
  // 전이를 사고라고 말하게 된다.
  const supersededOutcome = (status: string): DecisionOutcome =>
    interpretReceipt(409, {
      approval_id: "approval-pending",
      status,
      decided_by: "00000000-0000-7000-8000-000000000103",
      decided_at_ms: NOW_MS - 5_000,
    });

  it("다른 곳에서 이미 결정된 요청은 '이미 결정됨'이지 오류가 아니다", () => {
    for (const status of ["approved", "rejected", "cancelled"]) {
      const outcome = supersededOutcome(status);
      expect(outcome.kind).toBe("superseded");
      const note = decisionNote(outcome);
      expect(note.tone).toBe("neutral");
      expect(note.text).toBe("다른 곳에서 이미 결정되었습니다.");
    }
  });

  it("결정 전에 만료된 것도 오류가 아니라 상태 전이다 (ADR-0132: 부재≠실패)", () => {
    const note = decisionNote(supersededOutcome("expired"));
    expect(note.tone).toBe("neutral");
    expect(note.text).toBe("결정 전에 만료되었습니다.");
  });

  it("note 없는 superseded도 오류 색을 받지 않는다", () => {
    const note = decisionNote({ kind: "superseded" });
    expect(note.tone).toBe("neutral");
    expect(note.text).toBe("이 요청은 이미 결정되어 있었습니다.");
  });

  it("기록된 결정은 그 결정이 무엇이었는지 말한다", () => {
    expect(decisionNote({ kind: "committed", status: "approved" })).toEqual({
      tone: "neutral",
      text: APPROVED_RECEIPT,
    });
    expect(decisionNote({ kind: "committed", status: "rejected" })).toEqual({
      tone: "neutral",
      text: REJECTED_RECEIPT,
    });
  });

  // 2R 카피 정본. 이 두 단언은 문구 취향이 아니라 **서버 계약**을 지킨다.
  it("영수증이 계약을 넘어서는 약속을 하지 않는다", () => {
    // `approve_run`은 실행이 hold를 떠났으면 재개 job 없이 200으로 끝나고,
    // 정상 경로에서도 재개는 outbox를 거치는 비동기다. "바로 실행"은 어느 쪽으로도
    // 참이 아니다.
    expect(APPROVED_RECEIPT).not.toMatch(/바로|즉시|실행합니다/);
    // 거부는 같은 트랜잭션에서 실행을 취소하지만, 그 UPDATE는
    // `WHERE status='awaiting_approval'` 가드에 걸리면 조용히 빠진다. 무조건
    // 참인 것은 "재개되지 않는다"뿐이다.
    expect(REJECTED_RECEIPT).not.toMatch(/취소되었습니다/);
    expect(REJECTED_RECEIPT).toMatch(/이어지지 않습니다/);
  });

  it("미제공 결정은 사고가 아니다: 목록과 같은 색을 받는다 (2R M1)", () => {
    // 승인 라우트가 없는 서버에 결정을 보내면 본문 없는 404가 오고, core는 그것을
    // `surface_absent`로 표시한다. 같은 404를 목록은 조용한 미제공으로 접는데
    // 이 줄만 빨간 alert이면 한 화면이 같은 사실을 두 색으로 말한다.
    const outcome = unreadableAnswerOutcome(404, "");
    expect(outcome.errorCode).toBe("surface_absent");
    const note = decisionNote(outcome);
    expect(note.tone).toBe("unavailable");
    expect(note.tone).not.toBe("error");
    expect(note.text).not.toMatch(/다시 시도/);
  });

  it("200인데 알아볼 수 없는 상태면 안다고 말하지 않는다", () => {
    const note = decisionNote({ kind: "committed" });
    expect(note.tone).toBe("neutral");
    expect(note.text).toContain("목록에서 확인하세요");
  });

  it("진짜 실패만 오류 색을 받는다", () => {
    const note = decisionNote({
      kind: "error",
      errorCopy: "결정이 서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.",
    });
    expect(note.tone).toBe("error");
    expect(note.text).toContain("다시 시도");
  });

  it("멱등 충돌은 오류이고, 서버가 그렇게 답했다", () => {
    const outcome = interpretReceipt(409, {
      approval_id: "approval-pending",
      status: "idempotency_conflict",
    });
    expect(outcome.kind).toBe("error");
    expect(decisionNote(outcome).tone).toBe("error");
  });

  it("모든 문구가 사용자 문장이다: 경로·상태 코드·em-dash 0건", () => {
    const outcomes: DecisionOutcome[] = [
      { kind: "committed", status: "approved" },
      { kind: "committed", status: "rejected" },
      { kind: "committed" },
      { kind: "superseded" },
      supersededOutcome("expired"),
      { kind: "error", errorCopy: "결정을 처리하지 못했습니다." },
    ];
    for (const outcome of outcomes) {
      const { text } = decisionNote(outcome);
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/\/v1\//);
      expect(text).not.toMatch(/\b(200|403|404|409|POST|GET)\b/);
    }
  });
});

// ---- ④ 2R M3: 배지는 '해야 할 일'을 센다 ------------------------------------

describe("decidableCount", () => {
  it("결정할 수 있는 행만 센다", () => {
    const items = [
      pendingRow("a"),
      pendingRow("b"),
      approvalItem(approval("approved"), AGENT, "배포", NOW_MS),
      approvalItem(approval("expired"), AGENT, "배포", NOW_MS),
    ];
    // 행은 넷, 해야 할 일은 둘.
    expect(items).toHaveLength(4);
    expect(decidableCount(items)).toBe(2);
  });

  it("배지와 목록이 같은 판정을 쓴다", () => {
    // 같은 입력에 대해 배지의 수와 컨트롤이 붙는 행의 수가 어긋날 수 없다.
    const items = [
      pendingRow("a"),
      approvalItem(approval("cancelled"), AGENT, "배포", NOW_MS),
      pendingRow("c"),
    ];
    const withControls = items.filter(
      (item) => approvalRowControl(item, { offline: false }).kind === "decide"
    );
    expect(decidableCount(items)).toBe(withControls.length);
  });

  it("끊겼다고 해야 할 일이 사라지지는 않는다", () => {
    // 오프라인은 "지금 못 누른다"는 사실이지 "할 일이 없다"가 아니다. 배지가
    // 0이 되면 화면은 오프라인을 처리 완료로 말한다.
    expect(decidableCount([pendingRow("a"), pendingRow("b")])).toBe(2);
  });

  it("빈 목록은 0", () => {
    expect(decidableCount([])).toBe(0);
  });
});

// ---- ⑤ 2R H1: 반쪽 원장을 반쪽이라고 말한다 ---------------------------------

describe("agentsFeedPartial", () => {
  it("작업 기록을 읽을 수 없으면 반쪽이다", () => {
    expect(agentsFeedPartial(() => false)).toBe(true);
  });

  it("둘 다 있으면 반쪽이 아니다", () => {
    expect(agentsFeedPartial(() => true)).toBe(false);
  });
});

// ---- ⑥ 2R 확정 문장 정본 ----------------------------------------------------

describe("확정 문장", () => {
  it("되돌릴 수 있다고 서버가 말한 것만 경고 없이 지나간다", () => {
    expect(approveConfirmCopy(true)).toBe("승인하면 에이전트가 이어서 진행합니다.");
  });

  it("비가역은 그 사실을 재진술한다", () => {
    expect(approveConfirmCopy(false)).toMatch(/되돌릴 수 없습니다\.$/);
  });

  it("모름은 경고 쪽에 붙는다: 안 물어본 것을 안전하다고 말하지 않는다", () => {
    // server-rust `ApprovalDto`는 `is_reversible`를 아예 싣지 않는다. 그 침묵을
    // "되돌릴 수 있음"으로 읽는 것은 되돌릴 수 없는 액션 계열에서 가장 나쁜 기본값이다.
    expect(approveConfirmCopy(undefined)).toBe(approveConfirmCopy(false));
  });

  it("확정 문장이 계약을 넘어서는 약속을 하지 않는다", () => {
    for (const copy of [
      approveConfirmCopy(true),
      approveConfirmCopy(false),
      REJECT_CONFIRM,
    ]) {
      expect(copy).not.toMatch(/바로 실행|즉시/);
      expect(copy).not.toMatch(/[—–]/);
    }
    // 거부 확정과 거부 영수증이 같은 사실을 같은 말로 한다.
    expect(REJECT_CONFIRM).toMatch(/이어지지 않습니다/);
    expect(REJECTED_RECEIPT).toMatch(/이어지지 않습니다/);
  });
});

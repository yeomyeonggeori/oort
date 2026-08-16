import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import {
  COMPLETION_CHECK_TONE,
  COMPLETION_REPORT_KIND,
  MAX_COMPLETION_CHECKS_PER_ROW,
  MAX_COMPLETION_GATE_ROWS,
} from "../timeline/completionReportCard";
import {
  latestSessionVerification,
  sessionCompletionReport,
} from "./sessionVerification";

// =============================================================================
// 세션 검증 칩의 판정 (UXC-C).
//
// 재는 것은 셋이다: ①어느 메시지가 이 세션의 리포트인가 ②여러 리포트 중 어느 것이
// 지금의 이야기인가 ③한 칸으로 접을 때 무엇이 살아남는가. 셋 다 「없는 것을
// 이야기로 승격하지 않는다」는 같은 규율 아래 있다(ADR-0132).
// =============================================================================

const CHANNEL = "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5c";

function gates(...rows: Array<[string, Array<[string, string]>]>) {
  return rows.map(([surface, checks]) => ({
    surface,
    checks: checks.map(([label, outcome]) => ({ label, outcome })),
  }));
}

function reportMessage(
  seq: number,
  props: Record<string, unknown>,
  extra: Partial<Message> = {}
): Message {
  return {
    id: `0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a${seq.toString(16).padStart(2, "0")}`,
    channelId: CHANNEL,
    rootId: "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a00",
    seq,
    hlcTs: 1_760_000_000_000 + seq,
    hlcCount: 0,
    authorMemberId: "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5d",
    type: "text",
    body: "빌드를 마쳤습니다.",
    createdAtMs: 1_760_000_000_000 + seq,
    props,
    ...extra,
  };
}

const CLEAN_PROPS = {
  kind: COMPLETION_REPORT_KIND,
  summary: "웹·엔진 게이트를 전부 초록으로 맞췄습니다.",
  gates: gates(
    ["웹", [["테스트", "pass"], ["린트", "pass"]]],
    ["엔진", [["빌드", "pass"]]]
  ),
};

const FAILING_PROPS = {
  kind: COMPLETION_REPORT_KIND,
  summary: "엔진 테스트 하나가 아직 빨갛습니다.",
  gates: gates(
    ["웹", [["테스트", "pass"], ["린트", "pass"]]],
    ["엔진", [["빌드", "pass"], ["테스트", "failed"]]]
  ),
};

describe("어느 메시지가 이 세션의 리포트인가", () => {
  it("스레드에 남은 완료 리포트를 코어 계약 그대로 읽는다", () => {
    const report = sessionCompletionReport(reportMessage(11, CLEAN_PROPS));
    expect(report).not.toBeNull();
    expect(report?.seq).toBe(11);
    expect(report?.card.kind).toBe("completion_report");
  });

  it("리포트가 아닌 스레드 답글은 리포트가 아니다", () => {
    // 세션 스레드의 대다수는 ACP 이벤트이고, 사람이 공유한 발췌도 같은 스레드에
    // 산다. 둘 다 검증에 대해 아무 말도 하지 않는다.
    expect(
      sessionCompletionReport(
        reportMessage(12, { kind: "work_session_event", schema: "x" })
      )
    ).toBeNull();
    expect(sessionCompletionReport(reportMessage(13, {}))).toBeNull();
  });

  it("지워진 리포트는 더 이상 이 세션의 상태를 주장하지 않는다", () => {
    expect(
      sessionCompletionReport(
        reportMessage(14, FAILING_PROPS, { state: "deleted" })
      )
    ).toBeNull();
  });
});

describe("여러 리포트 중 지금의 이야기", () => {
  it("가장 최근(seq 최대) 리포트가 이긴다", () => {
    const older = sessionCompletionReport(reportMessage(10, FAILING_PROPS));
    const newer = sessionCompletionReport(reportMessage(30, CLEAN_PROPS));
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    // 순서를 뒤집어 넣어도 답이 같아야 한다 — 배열 순서는 계약이 아니다.
    for (const list of [
      [older!, newer!],
      [newer!, older!],
    ]) {
      const verdict = latestSessionVerification(list);
      expect(verdict?.outcome).toBe("clean");
      expect(verdict?.lead).toBe("pass");
      expect(verdict?.leadCount).toBe(3);
    }
  });

  it("리포트가 하나도 없으면 판정이 없다 — 「미검증」이 아니다", () => {
    expect(latestSessionVerification([])).toBeNull();
  });

  it("게이트 표가 빈 리포트는 검증에 대해 아무 말도 하지 않았다", () => {
    // `completionOutcome([])` 은 「완료」다. 그 낱말을 게이트 한 칸 없는 리포트
    // 위에 세우면 화면이 **하지 않은 검증**을 통과라고 말한다.
    const report = sessionCompletionReport(
      reportMessage(20, {
        kind: COMPLETION_REPORT_KIND,
        summary: "표 없이 요약만 실린 리포트입니다.",
      })
    );
    expect(report).not.toBeNull();
    expect(report?.card.outcome).toBe("clean");
    expect(latestSessionVerification([report!])).toBeNull();
  });
});

describe("한 칸으로 접어도 실패는 사라지지 않는다", () => {
  it("실패가 하나라도 있으면 칩이 그것을 말한다", () => {
    const report = sessionCompletionReport(reportMessage(40, FAILING_PROPS));
    const verdict = latestSessionVerification([report!]);
    expect(verdict?.lead).toBe("fail");
    expect(verdict?.leadCount).toBe(1);
    // 통과 3개가 실패 1개를 덮지 않는다.
    expect(verdict?.counts.pass).toBe(3);
    expect(verdict?.outcome).toBe("attention");
    // 그리고 그 칸의 옷은 코어의 역할표를 지난다.
    expect(COMPLETION_CHECK_TONE[verdict!.lead]).toBe("danger");
  });

  it("실패가 없으면 미상 > 진행 중 > 통과 > 건너뜀 순으로 앞선다", () => {
    // 건너뜀은 어휘에서 가장 조용한 칸이라 늘 진다 — 안 돌린 게이트가 표의
    // 대표가 되면 「이 세션은 아무것도 안 했다」로 읽힌다.
    const cases: Array<[string, string]> = [
      ["flaky", "unknown"],
      ["running", "pending"],
      ["pass", "pass"],
      ["skipped", "skip"],
    ];
    for (const [wire, expected] of cases) {
      const report = sessionCompletionReport(
        reportMessage(50, {
          kind: COMPLETION_REPORT_KIND,
          gates: gates(["웹", [["린트", "skipped"], ["테스트", wire]]]),
        })
      );
      const verdict = latestSessionVerification([report!]);
      expect(verdict?.lead, wire).toBe(expected);
    }
  });

  it("상한에 잘린 표는 접지 않는다 — 잘린 꼬리의 실패가 통과로 둔갑하지 않게 (G-M1)", () => {
    // 리뷰어 C 가 실측한 병리 봉투: 한 표면에 통과 40 + 실패 1. 코어 파서는
    // 41번째 칸을 잘라 `gates` 에 담고(`omitted.checks = 1`) 카드 머리의 판정은
    // **자르기 전 전체**로 재므로 카드는 여전히 「확인 필요」다. 그 표를 한 칸으로
    // 접으면 실패가 사라지고 「통과 40」(ok)만 남는다 — 카드가 막아 둔 거짓말이
    // 접기에서 다시 열리는 자리.
    const checks = [
      ...Array.from({ length: MAX_COMPLETION_CHECKS_PER_ROW }, (_, i) => [
        `게이트 ${i}`,
        "pass",
      ]),
      ["환불 회귀", "failed"],
    ] as Array<[string, string]>;
    const report = sessionCompletionReport(
      reportMessage(70, {
        kind: COMPLETION_REPORT_KIND,
        gates: gates(["엔진", checks]),
      })
    );
    expect(report).not.toBeNull();
    // 카드 자신은 정직하다: 머리는 확인 필요, 잘린 개수는 표에 남는다.
    expect(report?.card.outcome).toBe("attention");
    expect(report?.card.omitted.checks).toBe(1);
    // RED PROOF: 이 단정을 지우면 칩이 「통과 40」(ok) 으로 선다.
    expect(latestSessionVerification([report!])).toBeNull();
  });

  it("표면(줄)이 상한에 잘렸을 때도 접지 않는다 (G-M1)", () => {
    const rows = Array.from(
      { length: MAX_COMPLETION_GATE_ROWS + 1 },
      (_, i) => [`표면 ${i}`, [["테스트", "pass"]]] as [string, Array<[string, string]>]
    );
    const report = sessionCompletionReport(
      reportMessage(71, { kind: COMPLETION_REPORT_KIND, gates: gates(...rows) })
    );
    expect(report?.card.omitted.gates).toBe(1);
    expect(latestSessionVerification([report!])).toBeNull();
  });

  it("자르지 않은 표는 그대로 접는다 — 상한 방어가 정상 리포트를 침묵시키지 않는다", () => {
    const report = sessionCompletionReport(reportMessage(72, FAILING_PROPS));
    expect(report?.card.omitted).toEqual({ actions: 0, gates: 0, checks: 0 });
    expect(latestSessionVerification([report!])?.lead).toBe("fail");
  });

  it("침묵(건너뜀)과 대기(진행 중)는 실패색을 쓰지 않는다", () => {
    // ADR-0132 의 그 규율이 칩에서도 지켜지는지. 어휘가 카드의 것이므로 역할표도
    // 카드의 것이고, 여기서는 접기가 그 배정을 우회하지 않음을 잰다.
    const report = sessionCompletionReport(
      reportMessage(60, {
        kind: COMPLETION_REPORT_KIND,
        gates: gates(["웹", [["테스트", "skipped"], ["빌드", "queued"]]]),
      })
    );
    const verdict = latestSessionVerification([report!]);
    expect(verdict?.lead).toBe("pending");
    expect(COMPLETION_CHECK_TONE[verdict!.lead]).not.toBe("danger");
    expect(verdict?.outcome).toBe("clean");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPLETION_CHECK_TONE,
  COMPLETION_OUTCOME_LABEL,
} from "@momo/core/features/timeline/completionReportCard";

// =============================================================================
// 작업 완료 리포트 카드의 **웹 사본 대조** (UXC-A).
//
// 로그인 핸드오프의 `loginHandoffCopy.test.ts` 와 같은 계약이다: 이 클라에는 렌더
// 하네스가 없으므로(testing-library 미의존) 소스를 읽어 **무엇이 존재하지 않는가**
// 를 재고, 코어가 가진 것을 이 파일이 다시 갖지 않는지를 잰다.
//
// 폰 쪽 짝은 `clients/mobile/__tests__/completionReportCard.test.tsx`, 값과 판정의
// 모양은 `packages/momo-core/.../completionReportCard.test.ts` 가 잰다.
// =============================================================================

const AGENT_CARD_SRC = readFileSync(
  fileURLToPath(new URL("./AgentCard.tsx", import.meta.url)),
  "utf8"
);

/** 주석을 걷어낸 코드. 이 레포는 반례를 주석에 그대로 인용한다. */
const CODE_ONLY = AGENT_CARD_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^\s*\/\/.*$/gm,
  ""
);

/** 완료 리포트 카드가 사는 블록 하나로(셀·표·본문). */
const REPORT_BODY = CODE_ONLY.slice(
  CODE_ONLY.indexOf("function GateCell("),
  CODE_ONLY.indexOf("function ToolBody(")
);

describe("완료 리포트는 승인 카드 가족의 뼈대를 쓴다", () => {
  it("함수를 실제로 잘라 냈다", () => {
    expect(REPORT_BODY).toContain("function CompletionReportBody(");
    expect(REPORT_BODY).toContain("<CardFrame");
  });

  it("카드가 자기 kind 로 지목된다 (타임라인·캡처가 이것으로 찾는다)", () => {
    expect(REPORT_BODY).toContain('kind="completion_report"');
  });

  it("결정 카드가 아니다 — 컨트롤도 키보드도 서지 않는다", () => {
    // 끝난 일의 기록이라 승인·거부가 없다. footer 슬롯도, y/n 키 경로도, 비활성
    // 어포던스도 없다. 있으면 사람은 「내가 뭘 해야 하나」를 묻게 된다.
    expect(REPORT_BODY).not.toContain("footer=");
    expect(REPORT_BODY).not.toContain("onApprove");
    expect(REPORT_BODY).not.toMatch(/disabled/);
    expect(REPORT_BODY).not.toMatch(/aria-disabled/);
  });
});

describe("코어가 답하는 것을 웹이 다시 짓지 않는다", () => {
  it("경과 시간의 서식은 코어 헬퍼가 답한다", () => {
    expect(REPORT_BODY).toContain("formatElapsed(card.elapsedMs)");
  });

  it("결과 낱말과 집계는 코어의 것을 그대로 쓴다", () => {
    expect(REPORT_BODY).toContain("COMPLETION_CHECK_OUTCOME_LABEL[");
    expect(REPORT_BODY).toContain("completionCheckCounts(");
    // 「확인 필요」 같은 낱말을 인라인으로 적어 두지 않는다.
    expect(CODE_ONLY).not.toContain(COMPLETION_OUTCOME_LABEL.attention);
  });

  it("표 색은 역할로 칠한다 — 코어의 톤 매핑을 지난다 (divider/approvalNote 계약)", () => {
    expect(REPORT_BODY).toContain("COMPLETION_CHECK_TONE[");
    expect(REPORT_BODY).toContain("COMPLETION_TONE_CLASS");
    // fail 만 danger 다. skip·pending 은 아니다 — 침묵을 실패로 칠하지 않는다.
    expect(COMPLETION_CHECK_TONE.fail).toBe("danger");
    expect(COMPLETION_CHECK_TONE.skip).not.toBe("danger");
    expect(COMPLETION_CHECK_TONE.pending).not.toBe("danger");
  });
});

describe("빈 띠를 그리지 않는다", () => {
  it("표가 없으면 note 슬롯 자체가 서지 않는다", () => {
    // 게이트가 비면 `border-t` 만 남은 띠가 아니라 아무것도 없어야 한다. 래퍼가
    // 무조건이면 그 빈 띠가 선다 — 로그인 핸드오프 L1 과 같은 갈래.
    expect(REPORT_BODY).toContain("card.gates.length > 0 ?");
    expect(REPORT_BODY).not.toMatch(/note=\{\s*</);
  });

  it("넓은 표는 자기 컨테이너 안에서 가로 스크롤한다 (페이지 몸통은 아니다)", () => {
    expect(REPORT_BODY).toContain("overflow-x-auto");
  });
});

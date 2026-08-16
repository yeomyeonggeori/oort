import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPLETION_CHECK_OUTCOME_LABEL,
  COMPLETION_CHECK_TONE,
  type CompletionCheckOutcome,
} from "@momo/core/features/timeline/completionReportCard";
import { COMPLETION_TONE_CLASS, COMPLETION_TONE_TOKEN } from "@/features/timeline/completionTone";

// =============================================================================
// 세션 검증 칩이 **카드와 같은 다리**로 칠해지는가 (UXC-C).
//
// `completionTone.test.ts` 의 짝이다. 그 파일이 완료 리포트 카드에 대해 하는 일을
// 이 파일이 세션 표면의 칩에 대해 한다: 색이 컴포넌트 안의 리터럴이 아니라 코어의
// 역할표(`COMPLETION_CHECK_TONE`)를 지나 이 팔레트의 토큰에 닿는지, 그리고 그
// 토큰이 `tokens.css` 에 실제로 있는지.
//
// 세션 표면에 이 파일이 따로 필요한 이유는 사각지대가 표면마다 새로 열리기
// 때문이다: 카드가 다리를 지나도 세션 칩이 `text-danger` 를 직접 적으면, 안 돌린
// 게이트가 세션 목록에서만 붉어진다. 그 오타는 사람이 다시 스크린샷을 뜰 때만
// 잡히고, 그때는 이미 「이 세션은 실패했다」를 읽은 뒤다.
// =============================================================================

const css = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);
const chip = readFileSync(
  new URL("./SessionVerificationChip.tsx", import.meta.url),
  "utf8"
);
const panel = readFileSync(new URL("./WorkPanel.tsx", import.meta.url), "utf8");
const detail = readFileSync(
  new URL("./WorkSessionDetail.tsx", import.meta.url),
  "utf8"
);

const OUTCOMES: readonly CompletionCheckOutcome[] = [
  "pass",
  "fail",
  "skip",
  "pending",
  "unknown",
];

describe("칩의 색이 코어 역할표를 지난다", () => {
  it("톤 클래스를 인라인으로 다시 적지 않는다", () => {
    expect(chip).toContain(
      "COMPLETION_TONE_CLASS[COMPLETION_CHECK_TONE["
    );
    // 다리를 지나면서 자기 리터럴도 함께 적으면 위 단정이 무의미해진다.
    expect(chip).not.toMatch(/className=\{?"[^"]*text-danger/);
    expect(chip).not.toMatch(/className=\{?"[^"]*text-ok/);
  });

  it("어휘도 코어 표 그대로다 — 세션 표면 전용 낱말이 없다", () => {
    expect(chip).toContain("COMPLETION_CHECK_OUTCOME_LABEL[");
    for (const outcome of OUTCOMES) {
      expect(COMPLETION_CHECK_OUTCOME_LABEL[outcome]).toBeTruthy();
      expect(COMPLETION_TONE_CLASS[COMPLETION_CHECK_TONE[outcome]]).toBeTruthy();
    }
  });

  it("다섯 어휘가 전부 tokens.css 에 있는 토큰에 닿는다", () => {
    for (const outcome of OUTCOMES) {
      const token = COMPLETION_TONE_TOKEN[COMPLETION_CHECK_TONE[outcome]];
      expect(
        css.includes(`${token}:`),
        `${outcome} 이 tokens.css 에 없는 ${token} 을 든다`
      ).toBe(true);
    }
  });
});

describe("세션 표면이 칩을 우회하지 않는다", () => {
  it("두 표면 모두 공용 칩 컴포넌트를 쓴다", () => {
    // 표면마다 자기 <span> 을 세우기 시작하면 다리는 그대로인데 화면만 갈라진다.
    for (const [name, source] of [
      ["WorkPanel", panel],
      ["WorkSessionDetail", detail],
    ] as const) {
      expect(source, name).toContain('from "./SessionVerificationChip"');
      expect(source, name).toContain("<SessionVerificationChip");
    }
  });

  it("검증 칩이 세션 상태 칩을 대체하지 않는다 — 둘은 다른 사실이다", () => {
    // 원장이 이 세션을 무엇이라 부르는가(실행 중·종료됨·호스트 연결 끊김)와
    // 이 세션이 스스로 보고한 게이트 결과는 서로를 함의하지 않는다.
    expect(detail).toContain("SESSION_STATUS_CLASS[status.key]");
    expect(panel).toContain("SESSION_STATUS_CLASS[status.key]");
  });
});

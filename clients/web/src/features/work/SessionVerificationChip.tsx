import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";
import { COMPLETION_TONE_CLASS } from "@/features/timeline/completionTone";
import {
  COMPLETION_CHECK_OUTCOME_LABEL,
  COMPLETION_CHECK_TONE,
} from "@momo/core/features/timeline/completionReportCard";
import type { SessionVerification } from "@momo/core/features/work/sessionVerification";

// =============================================================================
// 세션의 검증 칩 (UXC-C / 커서 웹 ADE 벤치마크 §3-C).
//
// 완료 리포트 카드가 표 밑에 쓰는 집계 줄(「통과 12 · 실패 1」)을 **한 칸으로
// 접은 것**이다. 그래서 새 낱말이 없다: 어휘는 코어의
// `COMPLETION_CHECK_OUTCOME_LABEL` 그대로이고, 어느 칸을 그릴지는 코어의 심각도
// 순위가 정한다(`sessionVerification` — 실패는 어떤 접기로도 사라지지 않는다).
//
// 세션 상태 칩(`SESSION_STATUS_CLASS`)을 **대체하지 않는다.** 그 칩은 원장이
// 세션을 무엇이라 부르는가(실행 중 · 종료됨 · 호스트 연결 끊김)이고, 이 칩은 그
// 세션이 스스로 보고한 게이트 결과다. 둘은 서로를 함의하지 않는다 — 종료된
// 세션의 게이트가 실패했을 수 있고, 도는 세션이 이미 통과를 보고했을 수 있다.
//
// 색은 인라인 리터럴이 아니라 **역할 -> 토큰 두 단계**를 지난다: 코어가 역할을
// 정하고(`COMPLETION_CHECK_TONE`) 이 팔레트의 다리가 토큰을 준다
// (`COMPLETION_TONE_CLASS`). 카드의 게이트 셀·머리 칩과 같은 다리라서
// `sessionVerificationTone.test.ts` 가 tokens.css 실측으로 한 글자 오타를 잡는다.
// =============================================================================

export function SessionVerificationChip({
  verification,
  testId,
}: {
  verification: SessionVerification;
  /** 이 칩이 선 표면. 표면마다 달라서 게이트가 어디를 보는지 말할 수 있다. */
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      data-outcome={verification.outcome}
      data-lead={verification.lead}
      className={cn(
        CHIP_CLASS,
        "bg-surface-hover",
        COMPLETION_TONE_CLASS[COMPLETION_CHECK_TONE[verification.lead]]
      )}
    >
      {COMPLETION_CHECK_OUTCOME_LABEL[verification.lead]}{" "}
      {/* 숫자만 자릿폭 고정. 낱말은 한글이라 tabular-nums 를 걸면 음절 사이가
          벌어진다(카드의 집계 줄과 같은 규율). */}
      <span data-numeric>{verification.leadCount}</span>
    </span>
  );
}

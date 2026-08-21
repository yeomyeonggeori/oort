import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";
import {
  COMPLETION_TONE_CLASS,
  COMPLETION_TONE_SOFT_CLASS,
} from "@/features/timeline/completionTone";
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
//
// ## 그릇이 다르다: 원장의 칩은 톤 없는 채움, 자기 보고의 칩은 자기 톤의 채움
//
// 앞 판의 이 칩은 수명주기 칩과 **같은 그릇**이었다 — 같은 기하(`CHIP_CLASS`)에
// 같은 바탕(`--surface-hover`). 두 결함이 거기서 나왔다(#1463 리뷰 H1·M1):
//
//   1. 행의 hover·선택 바탕이 바로 그 `--surface-hover` 다. 그래서 사람이 가리키고
//      있는 행에서 두 칩이 **바탕과 같은 색**이 되어 그릇이 사라졌다(대비 1.00
//      실측). 「실패 1」이 배지가 아니라 오른쪽 여백의 붉은 조각으로 읽히는데,
//      하필 그 순간이 그 행을 들여다보는 순간이다.
//   2. 같은 그릇에 잉크만 다르면 두 칩이 무엇으로 다른지 말할 방법이 색뿐이고,
//      어휘가 겹치는 자리가 실제로 있다(실행 중 = warn, 미상 결과 = warn).
//
// 두 칩은 애초에 같은 격이 아니다. 하나는 **원장이 이 세션을 무엇이라 부르는가**,
// 다른 하나는 **세션이 자기 일에 대해 남긴 진술**이다. 그래서 그릇을 가른다.
//
// #1463 의 답은 이쪽에 **테두리**를 주는 것이었다(`--surface-raised` + `--line`).
// 그릇은 지켰지만 값을 치렀다: 이 팔레트에서 1px 테두리로 둘러싼 작은 알약은
// **컨트롤 문법**이고(입력·`<select>`·아웃라인 버튼이 전부 그 모양이다), 그래서
// 「통과 12」가 누를 수 있는 것으로 읽혔다(#1514 리뷰 H-3). 팔레트의 계약상으로는
// 컨트롤이 아닌데(`--line` 은 나누는 선, 컨트롤은 `--line-strong`) 화면은 다르게
// 말하고 있었던 것이다.
//
// 그래서 테두리가 지던 일을 **채움의 색상**이 진다 (#1516): 이 칩의 그릇은 자기 톤의
// 옅은 채움이다(`--ok-soft`·`--danger-soft`·`--warn-soft`). 색이 있는 채움은 중립
// 표면과 명도가 가까워도 구분되므로 행이 `--surface` 든 `--surface-hover` 든
// `--surface-raised` 카드든 그릇을 잃지 않는다. 그리고 그것이 **격의 구분**이기도
// 하다 — 원장의 칩은 톤 없는 `--muted-soft` 에 서고(#1515: 색을 버는 것은 측정이지
// 이름이 아니다), 측정을 나르는 이 칩만 그릇까지 물든다. 위 2번(warn 대 warn)이
// 잉크가 아니라 그릇에서 갈리는 것이 그 결과다.
//
// 건너뜀(skip)만 `--muted-soft` 로 떨어진다. 예외가 아니라 규칙 그 자체다: 게이트가
// 아무것도 재지 않았으므로 물들일 톤이 없고, 그 순간 이 칩이 원장의 칩과 같은 그릇에
// 서는 것도 같은 이유다 — 둘 다 말할 것이 없다. 그때 둘을 가르는 것은 낱말이고,
// 숫자를 지는 쪽은 여전히 이 칩 하나다.
//
// `sessionVerificationTone.test.ts` 가 이 전부를 tokens.css 실측으로 잰다.
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
        COMPLETION_TONE_SOFT_CLASS[COMPLETION_CHECK_TONE[verification.lead]],
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

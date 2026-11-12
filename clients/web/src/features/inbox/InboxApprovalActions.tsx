import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import type { SpawnExecutionPlan } from "@momo/core/lib/executionPlan";
import { ApprovalActions } from "@/features/timeline/ApprovalActions";
import { rememberSettledApproval } from "@/features/timeline/settledApprovals";
import { parseApprovalStatus } from "@momo/core/features/timeline/agentCardModel";

/**
 * 결정 대기 한 행의 승인/거부 (goal B5.3b D-5).
 *
 * 이 목록은 `GET …/approvals?status=pending`을 이미 읽고 있었지만, 결정하려면
 * 채널로 들어가 타임라인의 카드를 찾아야 했다. 결정에 필요한 사실(누가, 무엇을,
 * 언제까지, 되돌릴 수 있는지)은 전부 이 행에 이미 있으므로, 결정도 여기서 한다.
 * 컨트롤은 카드와 같은 것을 쓴다 — 두 번째 구현이 아니라 두 번째 호출자다.
 */
export function InboxApprovalActions({
  approvalId,
  onSettled,
  execution,
  lead = "실행 전에 내 허가가 필요해요.",
  className = "pb-2",
  testIdPrefix = "inbox-approval",
  decisionLabel,
  errorBeside,
  onBusyChange,
}: {
  approvalId: string;
  onSettled: (outcome: DecisionOutcome) => void;
  /**
   * 두 번째 호출자(「작업 · 내 작업」의 결과 칸, #5640)가 자리에 맞게 바꾸는 것은 이 셋뿐이다: 단추 앞 문장, 둘레, 시험 id 머리.
   * 결정 컨트롤·라우트·영수증은 그대로 한 벌이다. 기본값이 받은함의 모습이다.
   */
  lead?: string;
  className?: string;
  testIdPrefix?: string;
  /** 한 화면에 결정이 여럿 서면 어느 결정인지 접근성 이름에 남긴다(`ApprovalActions`). */
  decisionLabel?: string;
  /** 실패 문장을 단추 옆 한 줄에(「작업」 칸, #5738 — 줄 높이가 바뀌지 않게). 기본은 단추 아래다. */
  errorBeside?: boolean;
  /** 결정이 서버에 나가 있는 동안 true(「작업」 칸, #5738). */
  onBusyChange?: (busy: boolean) => void;
  /**
   * 스폰 승인의 호스트 후보 (ADR-0125 D6-A, 이슈 1114).
   *
   * 목록 행에도 픽커가 서는 이유는 위 주석이 결정 컨트롤에 대해 이미 말한 것과
   * 같다: 결정에 필요한 사실이 이 행에 다 있으므로 결정도 여기서 한다. 「어디서
   * 실행하나」는 스폰 승인에서 결정에 필요한 사실이고, 그것만 채널로 들어가
   * 고르게 하면 이 행은 다시 반쪽이 된다.
   */
  execution?: SpawnExecutionPlan;
}) {
  return (
    <ApprovalActions
      approvalId={approvalId}
      onSettled={(outcome) => {
        // 같은 승인을 그리는 타임라인 카드가 낡은 대기로 남지 않게 한다 (#3771).
        const status = parseApprovalStatus(outcome.status ?? null);
        if (status !== null) {
          rememberSettledApproval(approvalId, {
            status,
            ...(outcome.decidedAtMs !== undefined
              ? { decidedAtMs: outcome.decidedAtMs }
              : {}),
            ...(outcome.decidedByMemberId !== undefined
              ? { decidedByMemberId: outcome.decidedByMemberId }
              : {}),
          });
        }
        onSettled(outcome);
      }}
      lead={lead}
      className={className}
      testIdPrefix={testIdPrefix}
      execution={execution ?? null}
      {...(decisionLabel !== undefined ? { decisionLabel } : {})}
      {...(errorBeside !== undefined ? { errorBeside } : {})}
      {...(onBusyChange !== undefined ? { onBusyChange } : {})}
    />
  );
}


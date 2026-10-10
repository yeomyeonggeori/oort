import { useState } from "react";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import type { SpawnExecutionPlan } from "@momo/core/lib/executionPlan";
import {
  ApprovalActions,
  type Armed,
} from "@/features/timeline/ApprovalActions";

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
  reversible,
  execution,
}: {
  approvalId: string;
  onSettled: (outcome: DecisionOutcome) => void;
  reversible?: boolean;
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
  const [armed, setArmed] = useState<Armed>(null);
  return (
    <ApprovalActions
      approvalId={approvalId}
      armed={armed}
      setArmed={setArmed}
      onSettled={onSettled}
      lead="실행 전에 회원님의 허가가 필요합니다."
      className="pb-2"
      testIdPrefix="inbox-approval"
      reversible={reversible}
      execution={execution ?? null}
    />
  );
}


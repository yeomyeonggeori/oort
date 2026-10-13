import { useSyncExternalStore } from "react";
import type { ApprovalStatus } from "@momo/core/features/timeline/agentCardModel";

// =============================================================================
// 방금 결정한 승인의 영수증을 **컴포넌트 밖에** 둔다 (#3771).
//
// 실측(2026-10-13 22:52 KST, 운영): 승인을 누르자 결정은 원장에 적혔는데(approval
// `decided_at` 13:52:02Z) 카드에는 승인 버튼이 다시 떴고, 한 번 더 누르자 「이미
// 승인으로 기록되어 있었어요」가 났다. 두 번째 요청이 **새 `client_decision_id`로**
// 나갔다는 것(`approval_decision` 행은 하나뿐이다)이 카드 컴포넌트가 새로 마운트됐다는
// 증거다.
//
// 원인은 두 겹이다.
//  1. 서버는 결정 때 `message.props`를 고치지만 그 변경을 방송하지 않는다
//     (`patch_and_prune_message_props_in_tx`는 broadcast가 없고, 타임라인은
//     `approval.decided` 프레임을 읽지 않는다). 그래서 이 클라이언트가 든 메시지의
//     `status`는 reload 전까지 `pending`이다.
//  2. 결정 결과는 `ApprovalBody`의 `useState` 하나에만 있었다. 가상 리스트(Virtuoso)가
//     행을 내렸다 올리거나 목록이 다시 만들어지는 순간 이 컴포넌트가 새로 마운트되면
//     그 state가 사라지고, 카드는 낡은 메시지의 `pending`으로 되돌아가 버튼을 다시 그린다.
//
// 그래서 영수증을 승인 id로 키 잡은 모듈 저장소에 둔다. 마운트 수명과 무관하고,
// 같은 승인을 그리는 모든 표면(타임라인 카드·인박스 행)이 같은 사실을 본다.
//
// **넣지 않는 것: `secretOnce`.** 1회 값은 `ApprovalBody`의 state 하나에만 산다
// (ADR-0186 D4). 이 저장소는 그것을 받지 않는 타입이다.
// =============================================================================

export interface SettledReceipt {
  status: ApprovalStatus;
  decidedAtMs?: number;
  decidedByMemberId?: string;
  note?: string;
}

const MAX_REMEMBERED = 200;
const receipts = new Map<string, SettledReceipt>();
const listeners = new Set<() => void>();

function keyOf(approvalId: string): string {
  return approvalId.toLowerCase();
}

/**
 * 결정이 **끝난** 영수증만 기억한다. `pending`은 기억하지 않는다: 대기를 기억하면 다른
 * 곳에서 내려진 결정을 낡은 대기가 덮는다.
 */
export function rememberSettledApproval(
  approvalId: string | null | undefined,
  receipt: SettledReceipt
): void {
  if (!approvalId || receipt.status === "pending") return;
  const key = keyOf(approvalId);
  receipts.delete(key);
  receipts.set(key, receipt);
  // 세션이 길어져도 자라지 않는다: 가장 오래된 것부터 버린다. 버려진 것은 서버의
  // 메시지가 따라잡은 지 오래라 낡은 대기로 되돌아갈 일이 없다.
  while (receipts.size > MAX_REMEMBERED) {
    const oldest = receipts.keys().next();
    if (oldest.done) break;
    receipts.delete(oldest.value);
  }
  for (const listener of [...listeners]) listener();
}

export function settledApprovalFor(
  approvalId: string | null | undefined
): SettledReceipt | null {
  if (!approvalId) return null;
  return receipts.get(keyOf(approvalId)) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 이 승인을 방금 결정한 영수증. 없으면 `null`. 마운트가 몇 번 되풀이돼도 같다. */
export function useSettledApproval(
  approvalId: string | null | undefined
): SettledReceipt | null {
  return useSyncExternalStore(
    subscribe,
    () => settledApprovalFor(approvalId),
    () => null
  );
}

/** 시험 전용: 저장소를 비운다. */
export function resetSettledApprovalsForTest(): void {
  receipts.clear();
}

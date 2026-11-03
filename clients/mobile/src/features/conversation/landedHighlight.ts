import type {Message} from '@momo/core/lib/api';
import {rowPresentation} from '@momo/core/features/timeline/rowModel';

import type {ApprovalGate, ApprovalReceipt} from './approvalGate';

// =============================================================================
// 착지 틴트의 수명 (#3921) — 언제 물러나는가.
//
// 틴트("방금 여기로 왔다", `MessageRow` 의 `rowLanded`)는 세 가지로 물러난다. 먼저 오는 것이
// 이긴다.
//
//   ① 승인이 결정됐다   착지한 행이 승인 요청이고 그 승인이 결정되면 곧바로.
//   ② 보인 뒤 시한      점프의 **이동이 끝난 뒤** `LANDED_HOLD_MS`(1.5초) — 어느 행이든.
//   ③ 손가락           `onScrollBeginDrag`. #1076 부터의 규칙이고 그대로다.
//
// 이 파일은 ①의 판정과 ②의 시간을 든다. ③과 ②의 시작점(이동이 끝난 순간)은 `Timeline`
// 이 든다 — 이동의 끝은 `endJumpTravel` 만 안다.
//
// 승인 카드를 「결정할 때까지 남는」 강조로 되돌리지 않는다(owner 2026-10-31, #4949 판단).
// 틴트는 **도착 신호**이고 상태가 아니다 — 아직 결정되지 않았다는 사실은 카드의 칩과 버튼이
// 말한다. 상태까지 틴트가 겸하면 한 카드가 「끝났다」와 「남았다」를 함께 말하게 되고(#3921),
// 오래 남는 면이 어색하다는 것이 이 판단과 같은 날의 지적이었다.
// =============================================================================

/**
 * 이동이 끝난 **뒤** 틴트가 머무는 시간, ms. 약 1.5초다 — #3921 이 2초로 정했던 것을 owner 가
 * 「너무 오래 유지된다」고 짚어 줄였다(2026-10-31, #4949).
 *
 * 웹의 짝은 1,600ms 다(`inbox/anchor.ts` `HIGHLIGHT_MS`). 거기서 시계는 **행이 창 안에
 * 들어왔다고 확인된 순간** 켜진다(`rowInViewport`) — 폰의 같은 순간은 점프 이동의 끝이다
 * (`Timeline` 의 `endJumpTravel` → `onLanded`): 애니메이션이 멎고, `onScrollToIndexFailed`
 * 회복이 끝나고, 활강 대기까지 지난 뒤다. 그 끝은 움직임이 멎은 지 `JUMP_SETTLE_MS`(250ms)
 * 뒤에야 판정되므로, 사람이 틴트를 실제로 보는 시간은 이 값에 그 250ms 를 더한 만큼이고,
 * 거기에 녹는 시간(`LANDED_TINT_FADE_MS`, 240ms)이 따른다. 「동작 줄이기」는 녹는 시간만 없앤다.
 */
export const LANDED_HOLD_MS = 1500;

/**
 * 착지한 행의 승인에 대해 화면이 지금 아는 것. 승인 요청이 아니면 `null` — 결정할 것이
 * 없는 행은 ①의 대상이 아니다(②와 ③만 적용된다).
 */
export interface LandedApproval {
  approvalId: string;
  /**
   * 이 승인이 **이미 결정됐다고 화면이 말한다.** 이 기기의 결정이 방금 기록됐거나
   * (`ApprovalReceipt` — 다른 기기가 먼저 결정한 `superseded` 도 영수증이다), 카드가 든
   * 상태가 대기가 아니다(다른 기기·알림 버튼의 결정은 서버가 카드 행을 `message.edited` 로
   * 알려 레일로 들어오고 #3771, 그 프레임을 놓쳤어도 다시 읽으면 결정이 카드 props 에 있다).
   * 카드가 컨트롤 대신 영수증이나 「승인됨」 칩을 세우는 판정(`readApprovalCard`)과 같은 두
   * 근거다.
   *
   * 이 근거에 **안 닿을 수 있는 길**이 있다: 만료와 취소다. 서버는 둘 다 `approval` 행만 갱신하고
   * (`approval_sweep.rs` `settle_expired_in_tx` · `approval.rs` `cancel_pending_approvals_for_run_in_tx`)
   * 카드 행을 알리는 대신 새 줄(만료 `tool_result` · 취소 시스템 줄)을 올린다 — 카드 props 를
   * 바꾸거나 `message.edited` 를 내보내는 호출은 두 길에서 찾지 못했다. 카드는 대기로 남는다.
   * 그 길은 대기 원장 전이와 시한이 받친다.
   */
  decided: boolean;
  /**
   * 대기 원장이 **지금** 이 승인을 대기로 든다 — 컨트롤이 서는 조건(`gateFor`)의 한 반쪽.
   *
   * 이 값이 거짓인 것은 「결정됐다」가 **아니다.** 원장은 첫 읽기가 오기 전에는 비어 있고,
   * 알림 탭은 캐시를 무효화만 한다(`useNotificationTapRouting`) — 착지하는 순간 원장에
   * 그 승인이 없는 것이 정상이다. 결정으로 읽을 수 있는 것은 **있었다가 사라지는** 전이뿐이다
   * (`Timeline` 의 결정 효과).
   */
  pendingInLedger: boolean;
}

/**
 * 착지한 메시지의 승인 사정. 카드 해석은 행이 쓰는 그 함수(`rowPresentation`)다 — 두 번째
 * 구현이 아니라 두 번째 호출자다.
 */
export function landedApprovalOf(
  message: Message,
  view: {
    gates?: ReadonlyMap<string, ApprovalGate>;
    receipts?: ReadonlyMap<string, ApprovalReceipt>;
  },
): LandedApproval | null {
  const card = rowPresentation(message).card;
  // 재개 제안에는 `approvalId` 가 없다 — 승인할 대상이 없으니 결정될 일도 없다.
  if (card === null || card.kind !== 'approval' || card.approvalId === null) {
    return null;
  }
  const receipt = view.receipts?.get(card.approvalId);
  return {
    approvalId: card.approvalId,
    decided: receipt !== undefined || card.status !== 'pending',
    pendingInLedger: view.gates?.has(card.approvalId) === true,
  };
}

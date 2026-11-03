import {isFailedRow} from '@momo/core/features/connection/sendFailure';
import type {PendingMessage} from '@momo/core/features/timeline/model';

// =============================================================================
// 「모두 다시 보내기」를 어디에 세우나 (#5222, #5201 S-D).
//
// 실패한 글이 **둘 이상**일 때만, **첫 실패 줄 위에 한 번만** 선다(줄마다 달면 같은 단추가 줄 수만큼 되풀이된다). 한 줄뿐이면 그 줄의
// 새로고침 아이콘(#5210)이면 충분하다. 순수 판정이라 시험이 화면 없이 잰다.
// =============================================================================

/** 이 개수부터 한꺼번에 보내는 단추가 선다(감사 문서 §6.1 W4: 「2개 이상이면」). */
export const RESEND_ALL_MIN = 2;

export interface ResendAllOffer {
  /** 이 줄 **위에** 단추가 선다: 보낸 순서로 가장 먼저 실패한 줄의 멱등 키. */
  anchorId: string;
  /** 실패한 글의 수. */
  count: number;
}

export function resendAllOffer(
  pending: readonly PendingMessage[] | undefined,
): ResendAllOffer | null {
  const failed = (pending ?? []).filter(isFailedRow);
  if (failed.length < RESEND_ALL_MIN) return null;
  const first = failed.reduce((earliest, row) =>
    row.createdAtMs < earliest.createdAtMs ? row : earliest,
  );
  return {anchorId: first.clientMsgId, count: failed.length};
}

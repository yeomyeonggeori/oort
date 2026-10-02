import { useMemo } from "react";
import { needsMe, type NeedsMe } from "@momo/core/features/inbox/needsMe";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import {
  useLocalPaneAttention,
  type PaneAttentionEntry,
} from "@/features/workbench/local/paneAttention";
import { isDesktop } from "@/lib/tauri";
import { approvalRowControl } from "./approvalsPanel";
import { useMentionCount, useNeedsAction } from "./useInbox";

// =============================================================================
// 「나에게 필요한 일」 수의 웹 단일 출처 (#3337). 레일 인박스 배지, 인박스 머리·
// 탭 배지, 이후의 독 배지·접힘 합산 알약은 전부 이 훅 하나를 읽는다.
// 정의와 중복 제거는 core `needsMe`가 갖고, 여기는 웹의 세 원천을 그 입력으로
// 옮기는 일만 한다.
// =============================================================================

/**
 * 순수 변환: 웹의 세 원천 → core 입력. 훅 밖에 있어 DOM 없이 못박을 수 있다.
 *
 * - 승인: `approvalRowControl`이 「결정할 수 있다」고 한 행만(인박스 탭 배지와
 *   같은 판정). 연결이 끊겨도 할 일은 사라지지 않으므로 `offline:false`로 묻는다.
 * - 칸: 데스크탑에서 `waiting`인 칸만. 「끝남」은 세지 않는다. 웹에는 로컬 터미널
 *   레인이 없어(ADR-0190 D1) 칸이 있어도 세지 않는다.
 */
export function needsMeFrom(sources: {
  approvalItems: readonly FeedItem[];
  paneEntries: readonly PaneAttentionEntry[];
  unreadMentions: number;
  desktop: boolean;
}): NeedsMe {
  const decidableApprovalIds: string[] = [];
  for (const item of sources.approvalItems) {
    const control = approvalRowControl(item, { offline: false });
    if (control.kind === "decide") decidableApprovalIds.push(control.approvalId);
  }
  return needsMe({
    decidableApprovalIds,
    waitingPaneIds: sources.desktop
      ? sources.paneEntries.filter((e) => e.status === "waiting").map((e) => e.paneId)
      : [],
    unreadMentions: sources.unreadMentions,
  });
}

export function useNeedsMe(): NeedsMe {
  // 승인 원장이 없는 서버에서는 요청 자체를 만들지 않는다(`useNeedsAction(false)`):
  // 404를 0으로 세는 것은 「결정할 것이 없다」를 지어내는 일이다.
  const needsAction = useNeedsAction(isSurfaceProvided("approvals"));
  const paneEntries = useLocalPaneAttention();
  const unreadMentions = useMentionCount();
  const desktop = isDesktop();
  return useMemo(
    () =>
      needsMeFrom({
        approvalItems: needsAction.items,
        paneEntries,
        unreadMentions,
        desktop,
      }),
    [needsAction.items, paneEntries, unreadMentions, desktop]
  );
}

export function useNeedsMeCount(): number {
  return useNeedsMe().total;
}

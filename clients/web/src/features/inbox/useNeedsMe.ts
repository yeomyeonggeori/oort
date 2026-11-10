import { useMemo } from "react";
import { needsMe, type NeedsMe } from "@momo/core/features/inbox/needsMe";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import {
  useLocalPaneAttention,
  type PaneAttentionEntry,
} from "@/features/workbench/local/paneAttention";
import { isDesktop } from "@/lib/tauri";
import { approvalRowControl, awaitedApprovalId } from "./approvalsPanel";
import { useMentionCount, useNeedsAction } from "./useInbox";

// =============================================================================
// 「나에게 필요한 일」 수의 웹 단일 출처 (#3337). 레일 인박스 배지, 인박스 머리·
// 탭 배지, 이후의 독 배지·접힘 합산 알약은 전부 이 훅 하나를 읽는다.
// 정의와 중복 제거는 core `needsMe`가 갖고, 여기는 웹의 세 원천을 그 입력으로
// 옮기는 일만 한다.
// =============================================================================

/** 내가 결정할 대기 승인 하나: 배지가 세는 id와, 그 승인을 요청한 run(있을 때). */
export interface DecidableApproval {
  approvalId: string;
  runId: string | null;
}

/**
 * 「내가 결정할 승인」의 **한 판정**(#3337·#5462, #5640). 레일·인박스 배지(`needsMeFrom`)와 「작업 · 내 작업」의 「응답 필요」 구간이
 * 이 함수 하나를 읽는다: `approvalRowControl`이 결정 컨트롤(`decide`·`open`)을 준 행만. 연결이 끊겨도 할 일은 사라지지 않으므로
 * `offline:false`로 묻는다(화면의 오프라인 상태를 넘기면 끊긴 동안 두 자리의 수가 갈라진다).
 */
export function decidableApprovals(items: readonly FeedItem[]): DecidableApproval[] {
  const out: DecidableApproval[] = [];
  for (const item of items) {
    const awaited = awaitedApprovalId(approvalRowControl(item, { offline: false }));
    if (awaited !== null) out.push({ approvalId: awaited, runId: item.runId ?? null });
  }
  return out;
}

/** 내 결정을 기다리는 승인이 걸린 run의 id(소문자). 「작업」의 run 줄을 「응답 필요」로 올리는 재료다. */
export function decidableApprovalRunIds(items: readonly FeedItem[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const approval of decidableApprovals(items)) {
    if (approval.runId !== null) ids.add(approval.runId.toLowerCase());
  }
  return ids;
}

/**
 * 순수 변환: 웹의 세 원천 → core 입력. 훅 밖에 있어 DOM 없이 못박을 수 있다.
 *
 * - 승인: `approvalRowControl`이 「결정할 수 있다」고 한 행만(인박스 탭 배지와
 *   같은 판정; 카드를 열어서 결정하는 `open` 행도 내가 결정할 일이다, #5462).
 *   연결이 끊겨도 할 일은 사라지지 않으므로 `offline:false`로 묻는다.
 * - 칸: 데스크탑에서 `waiting`인 칸만. 「끝남」은 세지 않는다. 웹에는 로컬 터미널
 *   레인이 없어(ADR-0190 D1) 칸이 있어도 세지 않는다.
 */
export function needsMeFrom(sources: {
  approvalItems: readonly FeedItem[];
  paneEntries: readonly PaneAttentionEntry[];
  unreadMentions: number;
  desktop: boolean;
}): NeedsMe {
  return needsMe({
    decidableApprovalIds: decidableApprovals(sources.approvalItems).map((a) => a.approvalId),
    waitingPaneIds: sources.desktop
      ? sources.paneEntries.filter((e) => e.status === "waiting").map((e) => e.paneId)
      : [],
    unreadMentions: sources.unreadMentions,
  });
}

/**
 * 배지와 「작업」이 같이 읽는 결정 대기 원장(같은 쿼리 열쇠라 두 번 읽지 않는다).
 * 승인 원장이 없는 서버에서는 요청 자체를 만들지 않는다(`useNeedsAction(false)`):
 * 404를 0으로 세는 것은 「결정할 것이 없다」를 지어내는 일이다.
 */
function useDecisionLedger() {
  return useNeedsAction(isSurfaceProvided("approvals"));
}

export function useNeedsMe(): NeedsMe {
  const needsAction = useDecisionLedger();
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

/**
 * 「작업 · 내 작업」의 run 줄 재료(#5640): 배지와 **같은 원장**(`useNeedsAction`, 같은 쿼리 열쇠라 두 번 읽지 않는다)을 같은 판정
 * (`decidableApprovals`)으로 읽는다. 승인 원장이 없는 서버에서는 빈 집합이다(배지와 같은 규칙).
 */
export function useDecidableApprovalRunIds(): ReadonlySet<string> {
  const needsAction = useDecisionLedger();
  return useMemo(() => decidableApprovalRunIds(needsAction.items), [needsAction.items]);
}

export function useNeedsMeCount(): number {
  return useNeedsMe().total;
}

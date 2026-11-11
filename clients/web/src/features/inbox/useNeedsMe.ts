import { useMemo, useSyncExternalStore } from "react";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { uuidEq } from "@momo/core/lib/api";
import { needsMe, type NeedsMe } from "@momo/core/features/inbox/needsMe";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import { runBundleCanDecide, runBundleSnapshot } from "@momo/core/features/timeline/requestBundle";
import { runProgressSnapshot, subscribeRunProgress } from "@/features/agents/agentRunProgressStore";
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
  /** 그 원장 행 그대로(인박스가 그리는 행). 「작업」의 결과 칸이 내용과 결정 컨트롤을 이 행에서 읽는다(#5640). */
  item: FeedItem;
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
    if (awaited !== null) out.push({ approvalId: awaited, runId: item.runId ?? null, item });
  }
  return out;
}

/** run 진행 한 줄을 찾는 길: 그 승인의 채널과 run id로. 없으면 모른다(`undefined`). */
export type RunProgressLookup = (
  channelId: string,
  runId: string
) => Pick<AgentRunProgress, "bundle"> | undefined;

/**
 * 「작업 · 내 작업」의 run 줄이 결정을 세우는 재료(#5640): run id(소문자) → 그 run의 내 결정 대기 승인 하나.
 *
 * 판정은 인박스·배지와 같은 하나다(`decidableApprovals`). 한 가지만 더 거둔다: 서버가 run 진행에서 **보는 사람에게 「못 한다」고 답한
 * 승인**(`bundle.canDecide === false`, 서버가 결정 라우트의 역할·소유자 조건을 이 사람에게 물은 답)은 뺀다. 대화 카드가 같은 사실로 단추를
 * 거두는 규칙(`runBundleCanDecide`, `AgentCard`)과 같다 — 그 결정자(`requiredRole`이 정한 사람)가 아니면 이 줄에 단추가 서지 않는다.
 * `true`나 모름을 근거로 더하지는 않는다. 한 run에 대기 승인이 둘이면 원장 순서의 첫 승인이다.
 */
export function workDecisionsByRun(
  items: readonly FeedItem[],
  runFor: RunProgressLookup = () => undefined
): ReadonlyMap<string, DecidableApproval> {
  const byRun = new Map<string, DecidableApproval>();
  for (const approval of decidableApprovals(items)) {
    if (approval.runId === null) continue;
    const key = approval.runId.toLowerCase();
    if (byRun.has(key)) continue;
    if (runBundleCanDecide(runFor(approval.item.channelId, approval.runId), approval.approvalId) === false) {
      continue;
    }
    byRun.set(key, approval);
  }
  return byRun;
}

/** 내 결정을 기다리는 승인이 걸린 run의 id(소문자). 「작업」의 run 줄을 「응답 필요」로 올리는 재료다. */
export function decidableApprovalRunIds(
  items: readonly FeedItem[],
  runFor?: RunProgressLookup
): ReadonlySet<string> {
  return new Set(workDecisionsByRun(items, runFor).keys());
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

/** 「작업」이 읽는 결정 재료: run → 결정 대기 승인, 그리고 원장이 한 번이라도 답했는지(모르는 동안 「기다려요」를 지어내지 않는다). */
export interface WorkDecisions {
  byRun: ReadonlyMap<string, DecidableApproval>;
  /** 원장이 답했다(로딩·미제공·첫 실패가 아니다). 이때만 「원장에 없다」가 사실이다. */
  ledgerKnown: boolean;
  /**
   * 그 run이 지금 묻는 승인의 카드 문장(서버가 쓴 것, run 진행 bundle의 `intent`). 모르면 null. `approvalId`를 주면 그 승인의 문장일
   * 때만 준다(다른 승인의 문장을 이 승인의 내용으로 말하지 않는다).
   */
  intentFor: (channelId: string, runId: string, approvalId?: string) => string | null;
}

/**
 * 「작업 · 내 작업」의 run 줄 재료(#5640): 배지와 **같은 원장**(`useNeedsAction`, 같은 쿼리 열쇠라 두 번 읽지 않는다)을 같은 판정
 * (`workDecisionsByRun`)으로 읽는다. 승인 원장이 없는 서버에서는 빈 집합이다(배지와 같은 규칙).
 */
export function useWorkDecisions(): WorkDecisions {
  const needsAction = useDecisionLedger();
  const progress = useSyncExternalStore(subscribeRunProgress, runProgressSnapshot, runProgressSnapshot);
  // 원장이 한 번이라도 답했다(`dataUpdatedAt > 0`)고, 「이 서버에는 없다」가 아니다.
  const ledgerKnown = isSurfaceProvided("approvals") && needsAction.updatedAtMs > 0 && !needsAction.absent;
  return useMemo(() => {
    const runFor = (channelId: string, runId: string) =>
      progress.get(channelId.toLowerCase())?.find((run) => uuidEq(run.id, runId));
    return {
      byRun: workDecisionsByRun(needsAction.items, runFor),
      ledgerKnown,
      intentFor: (channelId: string, runId: string, approvalId?: string) => {
        const run = runFor(channelId, runId);
        const snapshot = run === undefined ? undefined : runBundleSnapshot(run);
        if (snapshot === undefined) return null;
        if (approvalId !== undefined && !uuidEq(snapshot.approvalId ?? "", approvalId)) return null;
        return snapshot.intent ?? null;
      },
    };
  }, [needsAction.items, progress, ledgerKnown]);
}

export function useNeedsMeCount(): number {
  return useNeedsMe().total;
}

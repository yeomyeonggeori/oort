import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { fetchMessages, type ReadState } from "@momo/core/lib/api";
import {
  HUMAN_MESSAGE_PAGE_LIMIT,
  isAmbientMessage,
  pageHasHumanMessage,
} from "@momo/core/features/sidebar/ambientMessage";
import { unreadFor } from "@momo/core/features/workspace/directory";
import { closedAtSeqOf, type ClosedDms, type ReadProjectionPhase } from "./sidebarDmClosure";

// =============================================================================
// 닫은 DM 이 되살아나는 조건: 「사람이 읽을 새 메시지」 (#4142, 성재 2026-10-20 0.1.33 실기:
// 「나간 멤버랑 Claude Code X로 계속 제거하는데 왜 계속 뜨냐」).
//
// ## 원인 (실측)
//
// `dmHiddenByClosure` 는 읽음 투영의 `latestSeq` 가 닫을 때보다 커지면 되살린다. 그런데 `latestSeq`
// 는 채널의 **모든** 메시지 수다. 에이전트 DM 에는 작업 상태·영수증 같은 기계 메시지가 쌓이고
// (`type: "system"` / `props.kind: "work_session"` - 푸시도 같은 모양을 `Work` 범주로 가른다,
// `momo-push/src/dispatch.rs category_for`) 그때마다 seq 가 올라 닫은 DM 이 사람이 읽을 것이
// 하나도 없는데 되돌아왔다.
//
// ## 서버 계약을 건드리지 않는 길
//
// 읽음 투영에는 「사람이 읽을 마지막 seq」가 없다(서버 계약 변경이라 이 이슈의 범위 밖). 그래서
// 닫은 DM 중 투영이 「새 메시지가 있다」고 말하는 것만, 닫을 때 이후의 메시지를 **한 번** 읽어
// 사람이 읽을 것이 있는지 본다. 쿼리 키가 `latestSeq` 를 품으므로 seq 가 또 올라야만 다시 읽는다
// (폴링 아님). 대상은 닫은 DM 이고 닫은 DM 은 많지 않다.
//
//   * 사람이 읽을 메시지가 있다 -> 투영의 `latestSeq` 그대로(= 되살아난다).
//   * 기계 메시지뿐이다 / 아직 읽는 중이다 -> 닫을 때의 seq(= 숨은 채). 읽는 중에 깜빡이며
//     나타나지 않게 한다.
//   * 읽지 못했다 -> 투영 그대로(되살아난다). 「새 메시지가 왔는지 모를 때 숨기는 쪽이 최악」이라는
//     원장 규칙(`sidebarDmClosure.ts`)과 같은 쪽이다.
// =============================================================================

/** 닫은 뒤 메시지를 읽는 한 쪽의 크기. 이만큼이 다 기계 메시지면 뒤에 더 있는지 몰라 되살린다. */
export const REVIVAL_PAGE_LIMIT = HUMAN_MESSAGE_PAGE_LIMIT;

export const REVIVAL_RETRY_DELAY_MS = 300;

// 「사람이 읽을 메시지」 구별은 코어로 옮겼다(#4252): 나간 멤버 DM 이 안 읽음 때문에 접히지 못하는 조건도 같은 구별을 읽는다
// (웹·폰, `@momo/core/features/sidebar/ambientMessage`). 기존 import 가 그대로 동작하도록 여기서 다시 내보낸다.
export { isAmbientMessage, pageHasHumanMessage };

export type RevivalVerdict = "human" | "ambient" | "pending" | "error";

/**
 * 한 닫은 DM 의 판정 입력으로 쓸 `latestSeq`. 투영 값을 그대로 줄지, 닫을 때의 seq 로 눌러 숨길지
 * 정한다. 순수 함수라 규칙을 시험이 직접 잡는다.
 */
export function effectiveLatestSeq(
  rawLatestSeq: number | undefined,
  closedAtSeq: number,
  verdict: RevivalVerdict
): number | undefined {
  if (rawLatestSeq === undefined || rawLatestSeq <= closedAtSeq) return rawLatestSeq;
  return verdict === "ambient" || verdict === "pending" ? closedAtSeq : rawLatestSeq;
}

/**
 * 닫은 DM 마다 「투영 latestSeq 를 어디까지 믿을 것인가」를 돌려준다. 사이드바와 `ChatShell` 의
 * 인덱스 폴백이 **같은 함수**를 읽는다(둘이 다르면 사이드바는 숨기는데 본문은 연다).
 */
export function useDmRevival(input: {
  workspaceId: string;
  dms: readonly { id: string }[];
  closed: ClosedDms;
  byChannel: Map<string, ReadState>;
  phase: ReadProjectionPhase;
}): (channelId: string) => number | undefined {
  const { workspaceId, dms, closed, byChannel, phase } = input;
  const candidates = useMemo(() => {
    if (phase !== "ready") return [];
    const out: { id: string; closedAt: number; latest: number }[] = [];
    for (const dm of dms) {
      const closedAt = closedAtSeqOf(closed, dm.id);
      const latest = unreadFor(byChannel, dm.id)?.latestSeq;
      if (closedAt !== undefined && latest !== undefined && latest > closedAt) {
        out.push({ id: dm.id.toLowerCase(), closedAt, latest });
      }
    }
    return out;
  }, [dms, closed, byChannel, phase]);

  // 결과를 「id:판정」 문자열로 접는다: 원시값이라 쿼리 결과가 같으면 참조가 같고 소비자가 불필요하게
  // 다시 계산하지 않는다.
  const signature = useQueries({
    queries: candidates.map((candidate) => ({
      queryKey: ["dm-revival", workspaceId, candidate.id, candidate.closedAt, candidate.latest],
      queryFn: async () =>
        pageHasHumanMessage(
          (
            await fetchMessages(workspaceId, candidate.id, {
              after: candidate.closedAt,
              limit: REVIVAL_PAGE_LIMIT,
            })
          ).messages
        ),
      staleTime: Infinity,
      // 일시 실패 한 번은 다시 읽는다(실패는 곧 되살림이라 깜빡임이 생긴다). 그동안은 숨은 채다.
      retry: 1,
      retryDelay: REVIVAL_RETRY_DELAY_MS,
    })),
    combine: (results) =>
      results
        .map((result, index): string => {
          const verdict: RevivalVerdict =
            result.isPending
              ? "pending"
              : result.isError || result.data === undefined
                ? "error"
                : result.data
                  ? "human"
                  : "ambient";
          return `${candidates[index]?.id}:${verdict}`;
        })
        .join("|"),
  });

  return useMemo(() => {
    const verdicts = new Map<string, RevivalVerdict>();
    for (const part of signature === "" ? [] : signature.split("|")) {
      const cut = part.lastIndexOf(":");
      verdicts.set(part.slice(0, cut), part.slice(cut + 1) as RevivalVerdict);
    }
    return (channelId: string) => {
      const raw = unreadFor(byChannel, channelId)?.latestSeq;
      const closedAt = closedAtSeqOf(closed, channelId);
      const verdict = verdicts.get(channelId.toLowerCase());
      if (closedAt === undefined || verdict === undefined) return raw;
      return effectiveLatestSeq(raw, closedAt, verdict);
    };
  }, [signature, byChannel, closed]);
}

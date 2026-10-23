import { useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { fetchMessages, type Channel, type ReadState } from "@momo/core/lib/api";
import {
  GONE_UNREAD_PAGE_LIMIT,
  pageHasHumanMessage,
} from "@momo/core/features/sidebar/ambientMessage";
import {
  goneUnreadProbeAfterSeq,
  goneUnreadSignature,
  goneUnreadVerdict,
  resolveGoneUnreadVerdicts,
  rosterIsComplete,
  type GoneUnreadVerdict,
  type ReadProjectionPhase,
} from "@momo/core/features/sidebar/goneDm";
import {
  channelLabelParts,
  idKey,
  unreadFor,
  type Directory,
} from "@momo/core/features/workspace/directory";
import { closedAtSeqOf, dmHiddenByClosure, type ClosedDms } from "./sidebarDmClosure";

// =============================================================================
// 나간 멤버 DM 의 안 읽음이 「사람이 읽을 것」인지 (#4252, 이슈 AC 「안 읽은 사람 메시지가 있으면 보인다」).
//
// 읽음 투영의 안 읽은 수는 기계 메시지(작업 상태·영수증)도 센다. 꺼 둔 에이전트의 DM 은 끈 직후 그런 줄이 안 읽음으로 쌓여
// 있어서 숫자만 보면 「추방했는데 왜 자꾸 떠요」가 그대로다. 서버 계약을 건드리지 않는 길은 `dmRevival.ts` 와 같다: 안 읽음이
// 있는 후보(`goneUnreadProbeAfterSeq`)만 안 읽은 쪽을 **한 번**, 서버가 한 쪽에 줄 수 있는 최대(200건, `GONE_UNREAD_PAGE_LIMIT`)까지
// 읽어 `pageHasHumanMessage` 로 가른다. 쿼리 키가 안 읽음의 범위(`after`·`latestSeq`)를 품어서 그 범위가 바뀔 때만 다시 읽는다
// (폴링 아님). 대상은 안 읽음이 있는 나간 멤버 DM 뿐이라 많지 않다. 안 읽은 기계 메시지가 200건 이상이면 뒤를 몰라 보이는 쪽으로
// 진다(서버가 「사람이 읽을 안 읽음 수」를 주면 이 읽기는 필요 없다, #4226 ADR 후보).
//
// 읽는 중이거나 못 읽었을 때의 값은 코어 `dmHiddenAsGone` 이 정한다(오는 중 -> 접힌 채, 못 읽음 -> 보인다). 새 메시지가 오면
// 키가 바뀌어 쿼리가 다시 「오는 중」이 되는데, 이미 가른 DM 은 새 쪽이 오는 동안 이전 판정을 유지한다(코어
// `resolveGoneUnreadVerdicts`): 사람이 읽을 안 읽음으로 보이던 DM 이 잠깐 접혔다 돌아오는 깜빡임이 없어야 한다.
//
// 사이드바와 `ChatShell` 의 인덱스 폴백이 **같은 훅**을 부른다(키가 같아 한 번만 읽는다): 둘이 다르면 사이드바는 접는데
// 본문은 연다.
// =============================================================================

export const GONE_UNREAD_RETRY_DELAY_MS = 300;

export function useGoneUnreadVerdicts(input: {
  workspaceId: string;
  dms: readonly Channel[];
  directory: Directory;
  selfMemberId: string;
  /** 명부를 받았나(`rosterLoaded`). 이름 갈래(`gone`)가 이 답을 따른다. */
  rosterReady: boolean;
  byChannel: Map<string, ReadState>;
  phase: ReadProjectionPhase;
  /**
   * 이 기기에서 X 로 닫은 DM(`sidebarDmClosure.ts`)과, 되살림 판정이 가리는 그 DM 의 최신 seq(`useDmRevival`). 원장이 **지금
   * 숨기고 있는** DM(`dmHiddenByClosure`)은 후보가 아니다: 사이드바에 서지 않으니 접을 일이 없고, 되살림 판정이 같은 안 읽은 쪽을
   * 이미 읽는다(design-review #4252 Low: 같은 쪽을 두 번 읽던 것). 원장 항목이 **남아 있는** 것만으로는 빼지 않는다: 닫은 뒤 사람 글이
   * 와서 되살아난 DM 은 읽고 난 뒤에도 원장 항목이 남아 있고, 그 뒤에 온 기계 메시지는 이 훅이 가려야 접힌다(design-review 3차 재확인
   * High: 항목이 있다는 이유로 빼면 사람 글을 읽은 뒤 기계 메시지만 와도 도로 보였다).
   */
  closed: ClosedDms;
  closureLatestSeqOf: (channelId: string) => number | undefined;
}): ReadonlyMap<string, GoneUnreadVerdict> {
  const {
    workspaceId,
    dms,
    directory,
    selfMemberId,
    rosterReady,
    byChannel,
    phase,
    closed,
    closureLatestSeqOf,
  } = input;
  const candidates = useMemo(() => {
    const rosterComplete = rosterIsComplete(directory.members.length);
    const out: { id: string; after: number; latest: number }[] = [];
    for (const dm of dms) {
      if (
        dmHiddenByClosure({
          closedAtSeq: closedAtSeqOf(closed, dm.id),
          latestSeq: closureLatestSeqOf(dm.id),
          isOpen: false,
          phase,
        })
      ) {
        continue;
      }
      const read = unreadFor(byChannel, dm.id);
      const after = goneUnreadProbeAfterSeq({
        labelKind: channelLabelParts(dm, directory, selfMemberId, { rosterReady }).kind,
        rosterComplete,
        // 열린 DM 의 안 읽음은 판정이 쓰이지 않는다(행이 0 으로 접어 센다). 여기서는 투영 그대로 후보를 고른다: 열린 DM 이
        // 다른 곳으로 옮겨 가는 순간에 판정이 이미 있어야 깜빡이지 않는다.
        isOpen: false,
        phase,
        read,
      });
      if (after !== null && read) out.push({ id: idKey(dm.id), after, latest: read.latestSeq });
    }
    return out;
  }, [dms, directory, selfMemberId, rosterReady, byChannel, phase, closed, closureLatestSeqOf]);

  // 결과를 「id:판정」 문자열로 접는다: 원시값이라 쿼리 결과가 같으면 참조가 같고 소비자가 불필요하게 다시 계산하지 않는다.
  const signature = useQueries({
    queries: candidates.map((candidate) => ({
      queryKey: ["gone-unread", workspaceId, candidate.id, candidate.after, candidate.latest],
      queryFn: async () =>
        pageHasHumanMessage(
          (
            await fetchMessages(workspaceId, candidate.id, {
              after: candidate.after,
              limit: GONE_UNREAD_PAGE_LIMIT,
            })
          ).messages,
          GONE_UNREAD_PAGE_LIMIT
        ),
      staleTime: Infinity,
      // 일시 실패 한 번은 다시 읽는다(실패는 곧 보임이라 깜빡임이 생긴다). 그동안은 오는 중으로 접힌 채다.
      retry: 1,
      retryDelay: GONE_UNREAD_RETRY_DELAY_MS,
    })),
    combine: (results) =>
      goneUnreadSignature(
        results.map((result, index) => ({
          id: candidates[index]?.id ?? "",
          verdict: goneUnreadVerdict(result),
        }))
      ),
  });

  // 이미 가른 DM 은 새 쪽이 오는 동안 이전 판정을 유지한다(코어 `resolveGoneUnreadVerdicts`).
  const settled = useRef(new Map<string, "human" | "ambient">());
  return useMemo(() => resolveGoneUnreadVerdicts(signature, settled.current), [signature]);
}

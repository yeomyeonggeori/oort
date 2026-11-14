import type { Query, QueryClient } from "@tanstack/react-query";
import type { ReadState } from "@momo/core/lib/api";
import type { DmLeaveCleanupPort } from "@momo/core/features/channels/dmLeave";
import {
  clearDraft,
  clearThreadDraft,
  forgetFailedSend,
  readFailedSends,
  threadDraftRootsInChannel,
} from "@/features/chat/draftStore";
import { clearChannelSurfaces } from "@/features/attachments/draftStore";

// =============================================================================
// 1:1 「대화 나가기」 성공 뒤 이 기기의 정리 - 코어 문(`DmLeaveCleanupPort`)의 웹 구현 (ADR-0177 증보 2026-11-14 D17 기기 줄, #5825).
//
// 불변식: 나간 대화의 하한 아래 것이 이 기기의 캐시·초안·답글 초안·트레이·못 보낸 글에 남지 않는다. **그 대화의 것만** 지운다: 여럿을 담은
// 캐시(받은함·검색)는 통째로 버리지 않고 그 대화의 항목만 걸러 낸다.
// =============================================================================

const lower = (value: string) => value.toLowerCase();

/** 쿼리 열쇠의 칸 하나가 이 대화의 id 인가(대소문자 무시). */
function keyNamesChannel(query: Query, channelId: string): boolean {
  return query.queryKey.some((part) => typeof part === "string" && lower(part) === channelId);
}

/** 캐시 값 어딘가에 이 대화의 id 가 적혀 있는가(받은함 맥락처럼 열쇠에 채널이 없는 것). */
function dataNamesChannel(query: Query, channelId: string): boolean {
  try {
    return lower(JSON.stringify(query.state.data ?? null)).includes(channelId);
  } catch {
    return false;
  }
}

interface Paged<T> {
  pages: T[];
  pageParams: unknown[];
}

function isPaged<T>(value: unknown): value is Paged<T> {
  return typeof value === "object" && value !== null && Array.isArray((value as Paged<T>).pages);
}

/**
 * 그 대화의 뿌리 글 후보를 `PUT` **전에** 모은다(#5824 검수 r1 M4): 열려 있던 이력(호출부가 넘김), 스레드 캐시(`["thread", ws, ch, root]`),
 * 답글 초안이 적어 둔 대화(`threadDraftRootsInChannel`).
 */
export function collectDmLeaveRootIds(
  client: QueryClient,
  workspaceId: string,
  channelId: string,
  known: readonly string[] = []
): string[] {
  const channel = lower(channelId);
  const out = new Set(known.map(lower));
  for (const query of client.getQueryCache().findAll({ queryKey: ["thread"] })) {
    const [, , ch, root] = query.queryKey;
    if (typeof ch === "string" && lower(ch) === channel && typeof root === "string") out.add(lower(root));
  }
  for (const root of threadDraftRootsInChannel(workspaceId, channelId)) out.add(lower(root));
  return [...out];
}

export function webDmLeaveCleanupPort(
  client: QueryClient,
  workspaceId: string,
  selfMemberId: string
): DmLeaveCleanupPort {
  return {
    updateReadRow(channelId, update) {
      const channel = lower(channelId);
      client.setQueryData<ReadState[]>(["read-state", workspaceId], (current) =>
        current?.map((row) => (lower(row.channelId) === channel ? update(row) : row))
      );
    },
    dropTimeline(channelId) {
      // 열려 있던 이력은 훅 상태라 이동(`navigate`)과 함께 바뀐다. 캐시에 남는 것은 이 대화를 열쇠에 든 것들이다: 스레드
      // (`["thread", ws, ch, root]`)·실행(`["agent-runs", ws, ch]`)·그 대화 범위의 검색·받은함 멘션.
      const channel = lower(channelId);
      client.removeQueries({ predicate: (query) => keyNamesChannel(query, channel) });
    },
    dropSearchResults(channelId) {
      const channel = lower(channelId);
      client.setQueriesData<Paged<{ hits: { channelId: string }[] }>>({ queryKey: ["message-search"] }, (data) =>
        isPaged<{ hits: { channelId: string }[] }>(data)
          ? { ...data, pages: data.pages.map((page) => ({ ...page, hits: page.hits.filter((hit) => lower(hit.channelId) !== channel) })) }
          : data
      );
    },
    dropInboxItems(channelId) {
      const channel = lower(channelId);
      client.setQueriesData<Paged<{ items: { channel: { id: string } }[] }>>({ queryKey: ["inbox", workspaceId] }, (data) =>
        isPaged<{ items: { channel: { id: string } }[] }>(data)
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => lower(item.channel.id) !== channel),
              })),
            }
          : data
      );
      // 받은함 맥락(`["inbox-context", ws, 항목 열쇠, seq]`)은 열쇠에 대화가 없다: 값이 그 대화를 가리키는 것만 버린다.
      client.removeQueries({
        queryKey: ["inbox-context", workspaceId],
        predicate: (query) => dataNamesChannel(query, channel),
      });
    },
    clearDrafts(channelId, rootIds) {
      clearDraft(workspaceId, channelId);
      for (const root of rootIds) clearThreadDraft(workspaceId, root);
    },
    clearAttachmentTrays(channelId) {
      // 트레이 열쇠는 (워크스페이스, 채널, 뿌리)라 채널 하나로 그 대화의 스레드 트레이까지 찾는다.
      clearChannelSurfaces(workspaceId, channelId);
    },
    forgetFailedSends(channelId) {
      for (const { row } of readFailedSends(workspaceId, channelId, selfMemberId)) {
        forgetFailedSend(workspaceId, channelId, row.clientMsgId);
      }
    },
  };
}

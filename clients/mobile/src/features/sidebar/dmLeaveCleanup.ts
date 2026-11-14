import type {DmLeaveCleanupPort} from '@momo/core/features/channels/dmLeave';
import type {ServerInboxPage} from '@momo/core/features/inbox/serverInbox';
import {idKey} from '@momo/core/features/workspace/directory';
import type {Message, MessageSearchPage, ReadState} from '@momo/core/lib/api';
import type {InfiniteData, QueryClient} from '@tanstack/react-query';

import {clearChannelSurfaces} from '../attachments/draftStore';
import {channelDraftKey, clearDraft, readDrafts, threadDraftKey} from '../conversation/drafts';
import {forgetFailedSend, readFailedSends} from '../conversation/failedSends';
import {workspaceKeys} from '../workspace/queries';

// =============================================================================
// 1:1 「대화 나가기」 성공 뒤 이 폰이 지우는 것 (ADR-0177 증보 2026-11-14 D17 「기기 캐시·쓰던 초안」 줄, #5826).
//
// 코어 `runDmLeaveCleanup` 이 차례를 정하고(투영 행 → 이력 → 검색 → 받은함 → 초안 → 못 보낸 글), 이 파일은 그 문(`DmLeaveCleanupPort`)을
// 폰의 저장소로 채운다. **그 대화의 것만** 지운다 — 다른 대화의 캐시·초안·트레이는 그대로다.
//
//   updateReadRow     읽음 투영 캐시(`workspaceKeys.readState`)의 그 행. 다음 GET 전에도 코어 3a 가 줄을 숨기고 실시간 하한이 선다.
//   dropTimeline      이력·스레드는 열린 대화 화면의 훅 상태라 모듈 캐시가 없다 - 그 화면은 훅의 `onLeft` 가 걷는다(아래 「남는 것」).
//                     react-query 에 그 방의 메시지를 든 것은 받은함의 대화·스레드 미리보기라 받은함 단계가 지운다.
//   dropSearchResults 메시지 검색 결과(`message-search`, 홈·대화 안 같은 키)의 쪽마다 그 방의 결과를 뺀다. 검색 탭은 숨어도 마운트돼 있어
//                     캐시를 지우지 않고 걸러 쓴다(다시 읽기 없이 화면에서 바로 빠진다).
//   dropInboxItems    받은함 목록(`inbox`)의 그 방 항목을 빼고 다시 읽게 하며, 그 방의 멘션·대화·스레드 미리보기 캐시를 버린다.
//   clearDrafts       대화 입력칸 초안 · 그 방의 스레드 초안 · 첨부 트레이(대화·스레드 모두).
//   forgetFailedSends 이 기기에 남은 그 방의 못 보낸 글(지금 사람이 쓴 것).
//
// ## 스레드 초안을 찾는 길
//
// 폰의 스레드 초안 열쇠는 `thread:<뿌리 id>` 라 채널이 없고(코어 문 `clearDrafts(channelId)` 의 모양으로는 못 찾는다), 나간 뒤에는 서버가
// 하한 아래 뿌리를 내려 주지 않는다. 그래서 **나가기 요청 전에** 이 기기가 든 그 방의 메시지 id 를 모은다(`heldThreadRoots` — 열린 대화의
// 이력 + 받은함 캐시). 기기에 남은 스레드 초안은 많아야 20개(`DRAFT_LIMIT`)라 그 열쇠 중 모은 id 에 드는 것만 지운다.
// =============================================================================

/**
 * 나가기 요청 **전에** 부른다: 이 기기가 그 방에 대해 든 메시지 id(스레드 뿌리 후보) 가운데 스레드 초안이 남아 있는 것. `held` 는 열린
 * 대화 화면의 이력이 준 id 다.
 */
export function heldThreadRoots(
  client: QueryClient,
  workspaceId: string,
  channelId: string,
  held: readonly string[],
): string[] {
  const prefix = threadDraftKey('');
  // 열쇠의 뿌리 id 는 저장된 글자 그대로 둔다(지울 때 같은 열쇠여야 한다). 비교만 소문자로 한다.
  const draftRoots = Object.keys(readDrafts())
    .filter(key => key.startsWith(prefix))
    .map(key => key.slice(prefix.length));
  if (draftRoots.length === 0) return [];
  const ids = new Set<string>(held.map(idKey));
  const channel = idKey(channelId);
  for (const [, data] of client.getQueriesData<InfiniteData<ServerInboxPage>>({
    queryKey: ['inbox', workspaceId],
  })) {
    for (const page of data?.pages ?? []) {
      for (const item of page.items ?? []) {
        if (idKey(item.channel.id) !== channel) continue;
        ids.add(idKey(item.message.id));
        if (item.rootId) ids.add(idKey(item.rootId));
      }
    }
  }
  for (const message of cachedInboxMessages(client, workspaceId, channelId)) {
    ids.add(idKey(message.id));
    if (message.rootId) ids.add(idKey(message.rootId));
  }
  return draftRoots.filter(root => ids.has(idKey(root)));
}

/** 받은함의 대화·스레드 미리보기 캐시가 든 그 방의 메시지(`fetchMessages` 쪽). */
function cachedInboxMessages(client: QueryClient, workspaceId: string, channelId: string): Message[] {
  const out: Message[] = [];
  for (const prefix of ['inbox-dm', 'inbox-thread-roots']) {
    for (const [, data] of client.getQueriesData<{messages?: Message[]}>({
      queryKey: [prefix, workspaceId, channelId],
    })) {
      out.push(...(data?.messages ?? []));
    }
  }
  return out;
}

export interface PhoneDmLeaveCleanupInput {
  client: QueryClient;
  workspaceId: string;
  /** 지금 사람 - 그 사람이 쓴 못 보낸 글만 지운다(같은 기기의 다른 계정 것은 그대로). */
  selfMemberId: string;
  /** `heldThreadRoots` 의 답 - 나가기 요청 전에 모은 것. */
  threadRootIds: readonly string[];
}

export function phoneDmLeaveCleanupPort({
  client,
  workspaceId,
  selfMemberId,
  threadRootIds,
}: PhoneDmLeaveCleanupInput): DmLeaveCleanupPort {
  return {
    updateReadRow(channelId, update) {
      const key = idKey(channelId);
      client.setQueryData<ReadState[]>(workspaceKeys.readState(workspaceId), current =>
        current?.map(row => (idKey(row.channelId) === key ? update(row) : row)),
      );
    },
    dropTimeline() {
      // 이력·스레드는 대화 화면의 훅 상태다(머리말). 그 화면은 성공 뒤 `onLeft` 가 걷는다.
    },
    dropSearchResults(channelId) {
      const key = idKey(channelId);
      client.setQueriesData<InfiniteData<MessageSearchPage>>(
        {queryKey: ['message-search', workspaceId.toLowerCase()]},
        data =>
          data === undefined
            ? data
            : {
                ...data,
                pages: data.pages.map(page => ({
                  ...page,
                  hits: page.hits.filter(hit => idKey(hit.channelId) !== key),
                })),
              },
      );
    },
    dropInboxItems(channelId) {
      const key = idKey(channelId);
      client.setQueriesData<InfiniteData<ServerInboxPage>>({queryKey: ['inbox', workspaceId]}, data =>
        data === undefined
          ? data
          : {
              ...data,
              pages: data.pages.map(page => ({
                ...page,
                items: page.items.filter(item => idKey(item.channel.id) !== key),
              })),
            },
      );
      // 스레드 답글 미리보기는 뿌리 id 로 열쇠가 서므로, 그 방의 뿌리 캐시를 버리기 전에 뿌리를 읽어 둔다.
      const roots = new Set(
        cachedInboxMessages(client, workspaceId, channelId).map(message => message.id),
      );
      for (const prefix of ['inbox-mentions', 'inbox-dm', 'inbox-thread-roots']) {
        client.removeQueries({queryKey: [prefix, workspaceId, channelId]});
      }
      for (const root of roots) {
        client.removeQueries({queryKey: ['inbox-thread-reply', workspaceId, root]});
      }
      // 서버도 그 항목을 지웠다(D16-1). 남은 쪽의 숫자·커서를 서버에서 다시 받는다.
      void client.invalidateQueries({queryKey: ['inbox', workspaceId]});
    },
    clearDrafts(channelId) {
      clearDraft(channelDraftKey(channelId));
      for (const root of threadRootIds) clearDraft(threadDraftKey(root));
      clearChannelSurfaces(workspaceId, channelId);
    },
    forgetFailedSends(channelId) {
      for (const {row} of readFailedSends(workspaceId, channelId, selfMemberId)) {
        forgetFailedSend(workspaceId, row.channelId, row.clientMsgId);
      }
    },
  };
}

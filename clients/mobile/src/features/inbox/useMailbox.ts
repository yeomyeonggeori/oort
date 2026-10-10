import {
  fetchMessages,
  fetchThreadReplies,
  threadRollup,
  uuidEq,
  type Message,
} from '@momo/core/lib/api';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import {
  composeMailbox,
  dmEntry,
  isUnreadSeq,
  mentionEntry,
  taskEntry,
  threadEntry,
  type MailboxEntry,
} from '@momo/core/features/inbox/mailbox';
import {useQueries, useQueryClient} from '@tanstack/react-query';
import {useCallback, useMemo} from 'react';
import {useNow} from '../../lib/useNow';
import {useSession} from '../../session/useSession';
import {useChannels, useReadStates} from '../workspace/queries';
import {useFeedContext, useMentionMessages, useNeedsAction} from './useInbox';

// =============================================================================
// 인박스 「전체」 목록의 원천, 폰판 (#3663). 웹 `useMailbox.ts`와 **같은 원천·같은
// 상한·같은 core 빌더**다. 서버에 인박스 라우트는 없으므로 이미 있는 읽기만 쓴다
// (DM 최근 페이지, 멘션 수 뒤의 메시지, 안 읽은 채널의 내 글 롤업, 대기 승인).
// 한계(읽은 멘션·내가 답만 한 스레드·배정된 작업은 서버가 기억하지 않는다)는 core
// `mailbox.ts` 머리말에 있다.
//
// 폰 1차 범위는 「목록 + 이동」이다: 줄을 누르면 그 대화가 열리고, 대화를 여는 것이
// 읽음 광고(`channel_open`)이므로 여기에 따로 읽음 처리는 없다.
// =============================================================================

const DM_CHANNEL_CAP = 30;
const DM_PAGE = 20;
const THREAD_CHANNEL_CAP = 12;
const THREAD_PAGE = 50;
const THREAD_ROOT_CAP = 10;
const STALE_MS = 15_000;

export interface Mailbox {
  entries: MailboxEntry[];
  isLoading: boolean;
  /** 시도한 원천이 모두 실패했을 때만. 일부만 실패하면 있는 만큼 그린다. */
  error: boolean;
  capped: boolean;
  updatedAtMs: number;
  refetch: () => Promise<unknown>;
}

export function useMailbox(enabled: boolean): Mailbox {
  const {member, workspaceId} = useSession();
  const selfId = member.id;
  const context = useFeedContext();
  const channelsQuery = useChannels(workspaceId);
  const readStates = useReadStates(workspaceId);
  const client = useQueryClient();
  const tasksProvided = isSurfaceProvided('approvals');
  const needsAction = useNeedsAction(enabled && tasksProvided);
  const {results: mentionResults} = useMentionMessages(enabled);

  const stateOf = useCallback(
    (channelId: string) => readStates.byChannel.get(channelId.toLowerCase()),
    [readStates.byChannel],
  );

  // 서버가 준 순서 그대로 상한까지. 채널 사이에는 비교할 수 있는 최근성이 없다.
  const dmChannels = useMemo(
    () => channelsQuery.groups.dms.slice(0, DM_CHANNEL_CAP),
    [channelsQuery.groups.dms],
  );
  const dmResults = useQueries({
    queries: dmChannels.map(channel => ({
      queryKey: [
        'inbox-dm',
        workspaceId,
        channel.id,
        stateOf(channel.id)?.latestSeq ?? 0,
      ],
      queryFn: () => fetchMessages(workspaceId, channel.id, {limit: DM_PAGE}),
      enabled,
      staleTime: STALE_MS,
    })),
    combine: results => ({
      pages: results.map(r => r.data?.messages),
      isLoading: results.some(r => r.isLoading),
      allFailed: results.length > 0 && results.every(r => r.isError),
      updatedAtMs: results.reduce((m, r) => Math.max(m, r.dataUpdatedAt), 0),
    }),
  });

  const unreadChannelsAll = useMemo(
    () =>
      channelsQuery.groups.channels.filter(channel => {
        const state = stateOf(channel.id);
        return state !== undefined && isUnreadSeq(state, state.latestSeq);
      }),
    [channelsQuery.groups.channels, stateOf],
  );
  const unreadChannels = useMemo(
    () => unreadChannelsAll.slice(0, THREAD_CHANNEL_CAP),
    [unreadChannelsAll],
  );
  const channelResults = useQueries({
    queries: unreadChannels.map(channel => ({
      queryKey: [
        'inbox-thread-roots',
        workspaceId,
        channel.id,
        stateOf(channel.id)?.latestSeq ?? 0,
      ],
      queryFn: () =>
        fetchMessages(workspaceId, channel.id, {limit: THREAD_PAGE}),
      enabled,
      staleTime: STALE_MS,
    })),
    combine: results => ({
      pages: results.map(r => r.data?.messages),
      isLoading: results.some(r => r.isLoading),
      allFailed: results.length > 0 && results.every(r => r.isError),
      updatedAtMs: results.reduce((m, r) => Math.max(m, r.dataUpdatedAt), 0),
    }),
  });

  const roots = useMemo(() => {
    const found: Message[] = [];
    channelResults.pages.forEach((page, index) => {
      const channel = unreadChannels[index];
      if (!channel || !page) return;
      const state = stateOf(channel.id);
      for (const message of page) {
        if (!uuidEq(message.authorMemberId, selfId)) continue;
        const rollup = threadRollup(message);
        if (rollup === null || !isUnreadSeq(state, rollup.lastReplySeq)) continue;
        found.push(message);
      }
    });
    return found
      .sort(
        (a, b) =>
          (threadRollup(b)?.lastReplySeq ?? 0) -
          (threadRollup(a)?.lastReplySeq ?? 0),
      )
      .slice(0, THREAD_ROOT_CAP);
  }, [channelResults.pages, unreadChannels, stateOf, selfId]);

  const replyResults = useQueries({
    queries: roots.map(root => ({
      queryKey: [
        'inbox-thread-reply',
        workspaceId,
        root.id,
        threadRollup(root)?.lastReplySeq ?? 0,
      ],
      queryFn: () =>
        fetchThreadReplies(workspaceId, root.channelId, root.id, undefined, 200),
      enabled,
      staleTime: STALE_MS,
    })),
    combine: results => ({
      lastReplies: results.map(r => {
        const texts = (r.data?.messages ?? []).filter(m => m.type === 'text');
        return texts.length > 0 ? texts[texts.length - 1] : undefined;
      }),
      isLoading: results.some(r => r.isLoading),
    }),
  });

  const nowMs = useNow();
  const entries = useMemo(() => {
    const dms = dmChannels.map((channel, index) => {
      const messages = dmResults.pages[index];
      if (!messages) return null;
      return dmEntry({
        channelId: channel.id,
        channelLabel: context.labelFor(channel.id),
        readState: stateOf(channel.id),
        messages,
        selfMemberId: selfId,
        actorFor: context.actorFor,
        nowMs,
      });
    });
    const mentions = mentionResults.messages.map(message =>
      mentionEntry(
        message,
        context.actorFor(message.authorMemberId),
        context.labelFor(message.channelId),
        nowMs,
      ),
    );
    const threads = roots.map((root, index) =>
      threadEntry({
        root,
        channelLabel: context.labelFor(root.channelId),
        readState: stateOf(root.channelId),
        lastReply: replyResults.lastReplies[index],
        selfMemberId: selfId,
        actorFor: context.actorFor,
        nowMs,
      }),
    );
    const tasks = needsAction.items.map(item => taskEntry(item, nowMs));
    return composeMailbox({
      dms,
      mentions,
      threads,
      tasks,
      dmChannelIds: new Set(
        channelsQuery.groups.dms.map(c => c.id.toLowerCase()),
      ),
    });
  }, [
    dmChannels,
    dmResults.pages,
    mentionResults.messages,
    roots,
    replyResults.lastReplies,
    needsAction.items,
    channelsQuery.groups.dms,
    context,
    stateOf,
    selfId,
    nowMs,
  ]);

  const sources = [
    {attempted: dmChannels.length > 0, failed: dmResults.allFailed},
    {
      attempted: (readStates.data ?? []).some(s => s.mentionCount > 0),
      failed: mentionResults.allFailed,
    },
    {attempted: unreadChannels.length > 0, failed: channelResults.allFailed},
    {
      attempted: tasksProvided && !needsAction.absent,
      failed: needsAction.error,
    },
  ];
  const tried = sources.filter(source => source.attempted);
  const error =
    channelsQuery.isError ||
    (tried.length > 0 && tried.every(source => source.failed));

  const capped =
    channelsQuery.groups.dms.length > DM_CHANNEL_CAP ||
    unreadChannelsAll.length > THREAD_CHANNEL_CAP;

  const refetch = useCallback(() => {
    return Promise.all([
      readStates.refetch(),
      needsAction.refetch(),
      ...['inbox-dm', 'inbox-mentions', 'inbox-thread-roots', 'inbox-thread-reply'].map(
        key => client.invalidateQueries({queryKey: [key, workspaceId]}),
      ),
    ]);
  }, [readStates, needsAction, client, workspaceId]);

  return {
    entries,
    isLoading:
      context.isLoading ||
      channelsQuery.isLoading ||
      readStates.isLoading ||
      dmResults.isLoading ||
      mentionResults.isLoading ||
      channelResults.isLoading ||
      (tasksProvided && needsAction.isLoading),
    error,
    capped,
    updatedAtMs: Math.max(
      dmResults.updatedAtMs,
      mentionResults.updatedAtMs,
      channelResults.updatedAtMs,
      needsAction.updatedAtMs,
      readStates.dataUpdatedAt,
    ),
    refetch,
  };
}

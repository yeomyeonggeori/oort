import {
  fetchInbox,
  fetchMessages,
  fetchThreadReplies,
  isInboxAbsent,
  markInboxItemRead,
  threadRollup,
  uuidEq,
  type Message,
} from '@momo/core/lib/api';
import {apiBase} from '@momo/core/runtime/host';
import type {
  InboxServerFilter,
  ServerInboxPage,
} from '@momo/core/features/inbox/serverInbox';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import {
  composeMailbox,
  dmEntry,
  isUnreadSeq,
  mentionEntry,
  orderMailbox,
  serverEntry,
  taskEntry,
  threadEntry,
  type MailboxEntry,
  type MailboxFilter,
} from '@momo/core/features/inbox/mailbox';
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {useCallback, useMemo} from 'react';
import {useNow} from '../../lib/useNow';
import {useSession} from '../../session/useSession';
import {useChannels, useReadStates} from '../workspace/queries';
import {
  useFeedContext,
  useMentionMessages,
  useNeedsAction,
  type Feed,
} from './useInbox';

// =============================================================================
// 인박스 「전체」 목록의 원천, 폰판 (#3663 → #3684, ADR-0199). 웹 `useMailbox.ts`와
// **같은 원천·같은 판별·같은 core 모델**이다.
//
//   서버 투영   `GET /inbox`: 답글·멘션·스레드·DM, 읽은 것도 30일. 필터와 커서는 서버가 한다.
//   구 서버     `GET /inbox`가 404(v0.1.20 이하)면 아래 `useComposedMailbox`가 이미 있는
//               읽기 계약(DM 최근 페이지, 멘션 수 뒤의 메시지, 안 읽은 채널의 내 글 롤업)을
//               모은다. 읽은 멘션은 못 보여 주는 한계가 있다.
//
// 어느 쪽인지는 세션 동안 **한 번만** 묻는다. 404만 「없는 서버」고 5xx·네트워크 오류는
// 장애로 보여 준다. 폰은 개인 채널 구독이 아직 없다(`subscribeInbox` 미연결): 화면이
// 보이게 될 때와 당겨서 새로고침할 때 다시 읽는다. 대기 중 승인은 어느 쪽에서나 따로
// 합친다(서버 투영에 저장되지 않는 상태 사실, D2).
//
// 폰은 「목록 + 이동」이 범위다: 줄을 누르면 그 대화가 열리고 대화를 여는 것이 채널
// 읽음 광고(`channel_open`)다. 서버 항목은 누를 때 그 항목의 읽음도 함께 보낸다.
// =============================================================================

const DM_CHANNEL_CAP = 30;
const DM_PAGE = 20;
const THREAD_CHANNEL_CAP = 12;
const THREAD_PAGE = 50;
const THREAD_ROOT_CAP = 10;
const STALE_MS = 15_000;

export type MailboxSource = 'probing' | 'server' | 'composed';

export interface Mailbox {
  source: MailboxSource;
  entries: MailboxEntry[];
  hasMore: boolean;
  isFetchingMore: boolean;
  fetchMore: () => void;
  isLoading: boolean;
  /** 시도한 원천이 모두 실패했을 때만. 일부만 실패하면 있는 만큼 그린다. */
  error: boolean;
  capped: boolean;
  updatedAtMs: number;
  refetch: () => Promise<unknown>;
}

const PAGE_SIZE = 30;

function toServerFilter(filter: MailboxFilter): InboxServerFilter {
  return filter === 'task' ? 'all' : filter;
}

/** 이 서버에 인박스 투영이 있는가. 세션 동안 한 번만 묻는다. */
function useInboxSurface(enabled: boolean) {
  const {workspaceId} = useSession();
  return useQuery({
    queryKey: ['inbox-surface', apiBase(), workspaceId],
    queryFn: async (): Promise<'present' | 'absent'> => {
      try {
        await fetchInbox(workspaceId, {limit: 1});
        return 'present';
      } catch (error) {
        if (isInboxAbsent(error)) return 'absent';
        throw error;
      }
    },
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnReconnect: false,
  });
}

export function useMailbox(
  enabled: boolean,
  filter: MailboxFilter = 'all',
): Mailbox {
  const {workspaceId} = useSession();
  const context = useFeedContext();
  const tasksProvided = isSurfaceProvided('approvals');
  const needsAction = useNeedsAction(enabled && tasksProvided);
  const surface = useInboxSurface(enabled);
  const absent = surface.data === 'absent';
  const serverOn = enabled && !absent && (surface.data === 'present' || surface.isError);
  const nowMs = useNow();

  const composed = useComposedMailbox(enabled && absent, needsAction, tasksProvided);

  const serverFilter = toServerFilter(filter);
  const query = useInfiniteQuery({
    queryKey: ['inbox', workspaceId, serverFilter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      fetchInbox(workspaceId, {
        filter: serverFilter,
        limit: PAGE_SIZE,
        ...(pageParam === undefined ? {} : {cursor: pageParam}),
      }),
    getNextPageParam: (last: ServerInboxPage) => last.nextCursor ?? undefined,
    enabled: serverOn,
    staleTime: STALE_MS,
  });

  const entries = useMemo(() => {
    const tasks = needsAction.items
      .map(item => taskEntry(item, nowMs))
      .filter((entry): entry is MailboxEntry => entry !== null);
    const server: MailboxEntry[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) {
        const resolved = context.labelFor(item.channel.id);
        const unresolved = resolved === item.channel.id.slice(0, 8);
        server.push(
          serverEntry(item, {
            channelLabel:
              unresolved && item.channel.name !== null
                ? `#${item.channel.name}`
                : resolved,
            actor: context.actorFor(item.actorMemberId),
            nowMs,
          }),
        );
      }
    }
    // 서버가 준 순서가 정본이다. 처리할 일만 맨 위에 둔다.
    return [...orderMailbox(tasks), ...server];
  }, [needsAction.items, query.data, context, nowMs]);

  const refetch = useCallback((): Promise<unknown> => {
    return Promise.all([
      surface.isError ? surface.refetch() : query.refetch(),
      needsAction.refetch(),
    ]);
  }, [surface, query, needsAction]);

  if (absent) return {...composed, source: 'composed'};

  return {
    source: serverOn ? 'server' : 'probing',
    // 투영이 답하지 못했는데 승인만 그리면 그것이 인박스 전부로 읽힌다: 오류를 말한다.
    entries: serverOn && !(query.isError && !query.data) ? entries : [],
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    fetchMore: () => void query.fetchNextPage(),
    isLoading: enabled && (surface.isPending || (serverOn && query.isLoading)),
    error: surface.isError || (serverOn && query.isError),
    capped: false,
    updatedAtMs: Math.max(query.dataUpdatedAt, needsAction.updatedAtMs),
    refetch,
  };
}

/**
 * 서버 항목을 눌렀을 때 그 항목을 읽음으로 보낸다(채널 읽음 위치는 안 움직인다).
 * 실패해도 대화는 열린다: 읽음은 다음 조회가 바로잡는다.
 */
export function useMarkInboxItemRead() {
  const {workspaceId} = useSession();
  const client = useQueryClient();
  return useCallback(
    (entry: MailboxEntry) => {
      if (entry.itemId === undefined || !entry.unread) return;
      void markInboxItemRead(workspaceId, entry.itemId)
        .then(() => client.invalidateQueries({queryKey: ['inbox', workspaceId]}))
        .catch(() => undefined);
    },
    [workspaceId, client],
  );
}

/** 구 서버 후퇴 경로: 이미 있는 읽기 계약을 클라이언트에서 모은다. */
function useComposedMailbox(
  enabled: boolean,
  needsAction: Feed,
  tasksProvided: boolean,
): Mailbox {
  const {member, workspaceId} = useSession();
  const selfId = member.id;
  const context = useFeedContext();
  const channelsQuery = useChannels(workspaceId);
  const readStates = useReadStates(workspaceId);
  const client = useQueryClient();
  const {results: mentionResults} = useMentionMessages(enabled);

  const stateOf = useCallback(
    (channelId: string) => readStates.byChannel.get(channelId.toLowerCase()),
    [readStates.byChannel],
  );

  // 서버가 준 순서 그대로 상한까지. 채널 사이에는 비교할 수 있는 최근성이 없다.
  const dmChannels = useMemo(
    () => (enabled ? channelsQuery.groups.dms.slice(0, DM_CHANNEL_CAP) : []),
    [enabled, channelsQuery.groups.dms],
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
      enabled
        ? channelsQuery.groups.channels.filter(channel => {
            const state = stateOf(channel.id);
            return state !== undefined && isUnreadSeq(state, state.latestSeq);
          })
        : [],
    [enabled, channelsQuery.groups.channels, stateOf],
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
    enabled &&
    (channelsQuery.isError ||
      (tried.length > 0 && tried.every(source => source.failed)));

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
    source: 'composed',
    hasMore: false,
    isFetchingMore: false,
    fetchMore: () => undefined,
    entries,
    isLoading:
      enabled &&
      (context.isLoading ||
        channelsQuery.isLoading ||
        readStates.isLoading ||
        dmResults.isLoading ||
        mentionResults.isLoading ||
        channelResults.isLoading ||
        (tasksProvided && needsAction.isLoading)),
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

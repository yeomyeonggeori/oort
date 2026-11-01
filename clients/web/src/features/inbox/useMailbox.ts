import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  fetchInbox,
  fetchMessages,
  isInboxAbsent,
  markInboxItemRead,
  markInboxReadAll,
  fetchThreadReplies,
  threadRollup,
  uuidEq,
  type Message,
  type ReadState,
} from "@momo/core/lib/api";
import { apiBase } from "@momo/core/runtime/host";
import type {
  InboxServerFilter,
  ServerInboxPage,
} from "@momo/core/features/inbox/serverInbox";
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
} from "@momo/core/features/inbox/mailbox";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import { useSession } from "@/app/session";
import { advertiseReadState } from "@/features/chat/advertiseReadState";
import {
  applyReadStateToCache,
  useChannels,
  useReadStates,
} from "@/features/workspace/useWorkspace";
import {
  useFeedContext,
  useMentionMessages,
  useNeedsAction,
  type Feed,
} from "./useInbox";

// =============================================================================
// 인박스 목록의 원천 (#3663 → #3684, ADR-0199). 원천이 둘이고 화면은 같은 `Mailbox`만 본다.
//
//   서버 투영   `GET /inbox`: 서버가 기억하는 답글·멘션·스레드·DM, 읽은 것도 30일.
//               필터와 커서(더 보기)는 서버가 한다. 항목 읽음은 `PUT …/read`.
//   구 서버     `GET /inbox`가 404인 서버(v0.1.20 이하)는 아래 `useComposedMailbox`가
//               이미 있는 읽기 계약을 클라이언트에서 모은다(DM 최근 페이지, 멘션 수 뒤의
//               메시지, 안 읽은 채널의 내 글 롤업). 읽은 멘션은 못 보여 주는 한계가 있다.
//
// 어느 쪽인지는 **한 번만** 판별해 세션 동안 캐시한다(`inbox-surface` 쿼리, staleTime
// 무한). 404만 「없는 서버」다. 5xx·네트워크 오류는 장애로 보여 주고 후퇴하지 않는다.
// 처리할 일(승인)은 서버 투영에 저장되지 않으므로(D2) 어느 경로에서나 대기 중 승인을
// 따로 합친다. 서버 응답의 `approvalsPending`은 쓰지 않는다: 같은 사실을 결정
// 컨트롤이 붙은 `FeedItem`으로 이미 읽고 있다.
//
// 팬아웃은 상한이 있다(구 서버 경로). 채널이 많은 워크스페이스에서 인박스를 연 순간
// 수백 요청이 나가는 것은 기능이 아니라 사고다. 잘렸는지는 `capped`로 화면에 말한다.
// =============================================================================

const DM_CHANNEL_CAP = 30;
const DM_PAGE = 20;
const THREAD_CHANNEL_CAP = 12;
const THREAD_PAGE = 50;
const THREAD_ROOT_CAP = 10;
const STALE_MS = 15_000;

/** `probing`: 아직 어느 서버인지 모른다. `server`: 투영 API. `composed`: 구 서버 후퇴. */
export type MailboxSource = "probing" | "server" | "composed";

export interface Mailbox {
  source: MailboxSource;
  entries: MailboxEntry[];
  /** 서버 경로: 보이는 안 읽음 전체 수(필터 무관, 서버 상한 1000). */
  serverUnreadCount: number | null;
  /** 서버 경로: 다음 쪽이 있는가. */
  hasMore: boolean;
  isFetchingMore: boolean;
  /** 다음 쪽만 실패했다: 이미 받은 목록은 그대로다. */
  moreError: boolean;
  fetchMore: () => void;
  /**
   * 어떤 원천이 아직 첫 응답을 못 받았다. 서버 경로는 투영과 승인 원장을 함께 센다(#5092): 원장이
   * 늦는 동안 투영만 비어 있다고 「비어 있어요」가 번쩍이지 않게 하는 값이다.
   */
  isLoading: boolean;
  /**
   * 보여 줄 줄이 없을 때 「비어 있다」고 말하면 거짓이 되는 실패가 있다. 구 서버 경로는 시도한
   * 원천이 모두 실패했을 때, 서버 경로는 투영이 실패했거나 승인 원장이 실패했을 때(#5092).
   * 일부만 실패하면 있는 만큼 그린다: 화면은 이 탭에 보일 줄이 없을 때만 이 값을 읽는다.
   */
  error: boolean;
  /** 승인 원장이 없는 서버: 「처리할 일」 칸을 장애가 아닌 미제공으로 말한다. */
  tasksAbsent: boolean;
  /** 상한 때문에 일부 채널을 읽지 못했다. */
  capped: boolean;
  updatedAtMs: number;
  refetch: () => void;
}

const PAGE_SIZE = 30;

function toServerFilter(filter: MailboxFilter | "reminders"): InboxServerFilter {
  return filter === "task" || filter === "reminders" ? "all" : filter;
}

/**
 * 이 서버에 인박스 투영이 있는가. 세션 동안 한 번만 묻는다(staleTime 무한, 재시도 없음).
 * 서버 주소가 키에 있어서 서버를 바꾸면 다시 묻는다.
 */
export function useInboxSurface() {
  const { workspaceId } = useSession();
  return useQuery({
    queryKey: ["inbox-surface", apiBase(), workspaceId],
    queryFn: async (): Promise<"present" | "absent"> => {
      try {
        await fetchInbox(workspaceId, { limit: 1 });
        return "present";
      } catch (error) {
        if (isInboxAbsent(error)) return "absent";
        throw error;
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** 개인 채널 신호(`inbox_item.*`)를 받으면 목록을 다시 조회한다. 본문은 오지 않는다. */
function useInboxRealtime(enabled: boolean) {
  const { session, workspaceId, realtime } = useSession();
  const client = useQueryClient();
  const selfId = session.member.id;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !realtime?.subscribeInbox) return;
    // 재접속 때 지난 신호가 한꺼번에 재생된다: 한 번의 조회로 합친다.
    const refresh = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void client.invalidateQueries({ queryKey: ["inbox", workspaceId] });
      }, 250);
    };
    const off = realtime.subscribeInbox(selfId, {
      onEvent: refresh,
      onResync: refresh,
    });
    return () => {
      off();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [enabled, realtime, selfId, workspaceId, client]);
}

export function useMailbox(filter: MailboxFilter | "reminders" = "all"): Mailbox {
  const { workspaceId } = useSession();
  const context = useFeedContext();
  const tasksProvided = isSurfaceProvided("approvals");
  const needsAction = useNeedsAction(tasksProvided);
  const surface = useInboxSurface();
  const absent = surface.data === "absent";
  const serverOn = !absent && (surface.data === "present" || surface.isError);
  useInboxRealtime(surface.data === "present");

  const composed = useComposedMailbox(absent, needsAction, tasksProvided);

  // 승인(처리할 일)은 투영에 저장되지 않아서(위 머리말) 승인 원장은 투영과 **따로** 오고 따로 실패한다.
  // 원장이 늦거나 실패했는데 투영만 빈 채로 답했다고 「비어 있어요」라고 말하면 대기 중인 승인을
  // 모르는 채 조용한 게 정상이라고 말하는 일이다(#5092). 구 서버 경로(`useComposedMailbox`)는 이미
  // 승인 원장의 로딩과 실패를 센다: 서버 경로도 같은 원천을 센다.
  const ledgerLoading = tasksProvided && needsAction.isLoading;
  // 404(`absent`)는 장애가 아니라 미제공이다: 화면이 「처리할 일」 탭에서 따로 말한다.
  const ledgerFailed = tasksProvided && !needsAction.absent && needsAction.error;

  const serverFilter = toServerFilter(filter);
  const query = useInfiniteQuery({
    queryKey: ["inbox", workspaceId, serverFilter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchInbox(workspaceId, {
        filter: serverFilter,
        limit: PAGE_SIZE,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (last: ServerInboxPage) => last.nextCursor ?? undefined,
    enabled: serverOn,
    staleTime: STALE_MS,
  });

  const serverEntries = useMemo(() => {
    const nowMs = Date.now();
    const out: MailboxEntry[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) {
        const resolved = context.labelFor(item.channel.id);
        const unresolved = resolved === item.channel.id.slice(0, 8);
        out.push(
          serverEntry(item, {
            channelLabel:
              unresolved && item.channel.name !== null
                ? `#${item.channel.name}`
                : resolved,
            actor: context.actorFor(item.actorMemberId),
            nowMs,
          })
        );
      }
    }
    return out;
    // 시각 라벨은 데이터가 바뀔 때 다시 그려진다(now는 의존에 넣지 않는다).
  }, [query.data, context]);

  const entries = useMemo(() => {
    const tasks = needsAction.items
      .map((item) => taskEntry(item, Date.now()))
      .filter((entry): entry is MailboxEntry => entry !== null);
    // 서버가 준 순서가 정본이다(최신순 키셋). 처리할 일만 맨 위에 둔다.
    return [...orderMailbox(tasks), ...serverEntries];
  }, [needsAction.items, serverEntries]);

  const refetchServer = useCallback(() => {
    if (surface.isError) void surface.refetch();
    else void query.refetch();
    needsAction.refetch();
  }, [surface, query, needsAction]);

  if (absent) return { ...composed, source: "composed" };

  return {
    source: serverOn ? "server" : "probing",
    // 투영이 답하지 못했는데 승인만 그리면 그것이 인박스 전부로 읽힌다: 오류를 말한다.
    entries: serverOn && !(query.isError && !query.data) ? entries : [],
    serverUnreadCount: query.data?.pages[0]?.unreadCount ?? null,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    moreError: query.isFetchNextPageError,
    fetchMore: () => void query.fetchNextPage(),
    isLoading: surface.isPending || (serverOn && (query.isLoading || ledgerLoading)),
    error: surface.isError || (serverOn && (query.isError || ledgerFailed)),
    tasksAbsent: !tasksProvided || needsAction.absent,
    capped: false,
    updatedAtMs: Math.max(query.dataUpdatedAt, needsAction.updatedAtMs),
    refetch: refetchServer,
  };
}

/** 구 서버 후퇴 경로: 이미 있는 읽기 계약을 클라이언트에서 모은다. */
function useComposedMailbox(
  enabled: boolean,
  needsAction: Feed,
  tasksProvided: boolean
): Mailbox {
  const { session, workspaceId } = useSession();
  const selfId = session.member.id;
  const context = useFeedContext();
  const channelsQuery = useChannels(workspaceId);
  const readStates = useReadStates(workspaceId);
  const client = useQueryClient();
  const { results: mentionResults } = useMentionMessages(enabled);

  const stateOf = useCallback(
    (channelId: string) => readStates.byChannel.get(channelId.toLowerCase()),
    [readStates.byChannel]
  );

  // ---- DM: 서버가 준 순서대로 상한까지 ----------------------------------------
  // 채널 사이에는 비교할 수 있는 최근성이 없다(`latestSeq`는 채널별 카운터라 서로
  // 견줄 수 없다). 순서를 지어내지 않고 서버의 순서를 그대로 쓴다.
  const dmChannels = useMemo(
    () => (enabled ? channelsQuery.groups.dms.slice(0, DM_CHANNEL_CAP) : []),
    [enabled, channelsQuery.groups.dms]
  );
  const dmResults = useQueries({
    queries: dmChannels.map((channel) => ({
      // latestSeq가 키에 있어 새 메시지가 오면 이 페이지를 다시 읽는다.
      queryKey: [
        "inbox-dm",
        workspaceId,
        channel.id,
        stateOf(channel.id)?.latestSeq ?? 0,
      ],
      queryFn: () => fetchMessages(workspaceId, channel.id, { limit: DM_PAGE }),
      staleTime: STALE_MS,
    })),
    combine: (results) => ({
      pages: results.map((r) => r.data?.messages),
      isLoading: results.some((r) => r.isLoading),
      allFailed: results.length > 0 && results.every((r) => r.isError),
      updatedAtMs: results.reduce((m, r) => Math.max(m, r.dataUpdatedAt), 0),
    }),
  });

  // ---- 스레드: 안 읽은 채널의 최근 페이지에서 내 글 -------------------------
  const unreadChannelsAll = useMemo(
    () =>
      enabled
        ? channelsQuery.groups.channels.filter((channel) => {
            const state = stateOf(channel.id);
            return state !== undefined && isUnreadSeq(state, state.latestSeq);
          })
        : [],
    [enabled, channelsQuery.groups.channels, stateOf]
  );
  const unreadChannels = useMemo(
    () => unreadChannelsAll.slice(0, THREAD_CHANNEL_CAP),
    [unreadChannelsAll]
  );
  const channelResults = useQueries({
    queries: unreadChannels.map((channel) => ({
      queryKey: [
        "inbox-thread-roots",
        workspaceId,
        channel.id,
        stateOf(channel.id)?.latestSeq ?? 0,
      ],
      queryFn: () =>
        fetchMessages(workspaceId, channel.id, { limit: THREAD_PAGE }),
      staleTime: STALE_MS,
    })),
    combine: (results) => ({
      pages: results.map((r) => r.data?.messages),
      isLoading: results.some((r) => r.isLoading),
      allFailed: results.length > 0 && results.every((r) => r.isError),
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
      .sort((a, b) => (threadRollup(b)?.lastReplySeq ?? 0) - (threadRollup(a)?.lastReplySeq ?? 0))
      .slice(0, THREAD_ROOT_CAP);
  }, [channelResults.pages, unreadChannels, stateOf, selfId]);

  const replyResults = useQueries({
    queries: roots.map((root) => ({
      queryKey: [
        "inbox-thread-reply",
        workspaceId,
        root.id,
        threadRollup(root)?.lastReplySeq ?? 0,
      ],
      queryFn: () =>
        fetchThreadReplies(workspaceId, root.channelId, root.id, undefined, 200),
      staleTime: STALE_MS,
    })),
    combine: (results) => ({
      lastReplies: results.map((r) => {
        const replies = r.data?.messages ?? [];
        // 내 답글은 「나를 찾은」 일이 아니다: 남이 쓴 마지막 답글을 고른다.
        const others = replies.filter((m) => m.type === "text");
        return others.length > 0 ? others[others.length - 1] : undefined;
      }),
      isLoading: results.some((r) => r.isLoading),
    }),
  });

  const nowMs = Date.now();
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
    const mentions = mentionResults.messages.map((message) =>
      mentionEntry(
        message,
        context.actorFor(message.authorMemberId),
        context.labelFor(message.channelId),
        nowMs
      )
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
      })
    );
    const tasks = needsAction.items.map((item) => taskEntry(item, nowMs));
    return composeMailbox({
      dms,
      mentions,
      threads,
      tasks,
      dmChannelIds: new Set(
        channelsQuery.groups.dms.map((c) => c.id.toLowerCase())
      ),
    });
    // nowMs는 의존에 넣지 않는다: 시각 라벨은 데이터가 바뀔 때 다시 그려진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  ]);

  // 시도한 원천이 전부 실패했을 때만 장애다. 하나라도 답했으면 그만큼을 그린다.
  const sources: { attempted: boolean; failed: boolean }[] = [
    { attempted: dmChannels.length > 0, failed: dmResults.allFailed },
    {
      attempted: (readStates.data ?? []).some((s) => s.mentionCount > 0),
      failed: mentionResults.allFailed,
    },
    { attempted: unreadChannels.length > 0, failed: channelResults.allFailed },
    {
      attempted: tasksProvided && !needsAction.absent,
      failed: needsAction.error,
    },
  ];
  const tried = sources.filter((source) => source.attempted);
  const error =
    enabled &&
    (channelsQuery.isError ||
      (tried.length > 0 && tried.every((source) => source.failed)));

  const capped =
    channelsQuery.groups.dms.length > DM_CHANNEL_CAP ||
    unreadChannelsAll.length > THREAD_CHANNEL_CAP;

  const refetch = useCallback(() => {
    void readStates.refetch();
    needsAction.refetch();
    for (const key of [
      "inbox-dm",
      "inbox-mentions",
      "inbox-thread-roots",
      "inbox-thread-reply",
    ]) {
      void client.invalidateQueries({ queryKey: [key, workspaceId] });
    }
  }, [readStates, needsAction, client, workspaceId]);

  return {
    source: "composed",
    serverUnreadCount: null,
    hasMore: false,
    isFetchingMore: false,
    moreError: false,
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
    tasksAbsent: !tasksProvided || needsAction.absent,
    capped,
    updatedAtMs: Math.max(
      dmResults.updatedAtMs,
      mentionResults.updatedAtMs,
      channelResults.updatedAtMs,
      needsAction.updatedAtMs,
      readStates.dataUpdatedAt
    ),
    refetch,
  };
}

// ---- 읽음 처리 --------------------------------------------------------------

type InboxCache = InfiniteData<ServerInboxPage, string | undefined>;

/** 캐시된 모든 서버 목록에서 항목 하나를 읽음으로 칠하고 안 읽음 수를 맞춘다. */
function patchItemRead(
  data: InboxCache | undefined,
  itemId: string,
  readAtMs: number,
  unreadCount: number
): InboxCache | undefined {
  if (data === undefined) return data;
  return {
    ...data,
    pages: data.pages.map((page, index) => ({
      ...page,
      unreadCount: index === 0 ? unreadCount : page.unreadCount,
      items: page.items.map((item) =>
        item.id.toLowerCase() === itemId.toLowerCase() && item.readAtMs === null
          ? { ...item, readAtMs }
          : item
      ),
    })),
  };
}

/**
 * 읽음 처리. 두 경로의 의미가 다르다.
 *
 *   서버 투영 항목(`entry.itemId`)  `PUT …/inbox/{id}/read`. 그 항목만 읽음이 되고
 *                                   채널의 읽음 위치는 움직이지 않는다(ADR-0199 D3).
 *   구 서버 항목                    채널 커서를 올린다. **같은 채널의 앞선 메시지도 함께**
 *                                   읽음이 된다. 의도는 채널 열기와 같다.
 *
 * 안 읽음으로 되돌리는 길은 구 서버 항목에만 있다(서버 투영 v1에는 없다).
 */
export function useMailboxReadActions() {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const invalidate = useCallback(() => {
    for (const key of [
      "inbox",
      "inbox-mentions",
      "inbox-dm",
      "inbox-thread-roots",
    ]) {
      void client.invalidateQueries({ queryKey: [key, workspaceId] });
    }
  }, [client, workspaceId]);

  const markRead = useCallback(
    async (entry: MailboxEntry) => {
      if (entry.itemId !== undefined) {
        const done = await markInboxItemRead(workspaceId, entry.itemId);
        client.setQueriesData<InboxCache>(
          { queryKey: ["inbox", workspaceId] },
          (data) =>
            patchItemRead(data, entry.itemId ?? "", done.readAtMs, done.unreadCount)
        );
        invalidate();
        return;
      }
      if (entry.seq === undefined) return;
      const next = await advertiseReadState(
        workspaceId,
        entry.channelId,
        entry.seq,
        "mark_read_menu"
      );
      applyReadStateToCache(client, workspaceId, next);
      invalidate();
    },
    [workspaceId, client, invalidate]
  );

  const markUnread = useCallback(
    async (entry: MailboxEntry) => {
      // 서버 투영에는 안 읽음으로 되돌리는 길이 없다(v1). 화면이 이 버튼을 그리지 않는다.
      if (entry.itemId !== undefined || entry.seq === undefined) return;
      const rows = client.getQueryData<ReadState[]>(["read-state", workspaceId]);
      const row = rows?.find((r) => uuidEq(r.channelId, entry.channelId));
      const next = await advertiseReadState(
        workspaceId,
        entry.channelId,
        row?.lastReadSeq ?? 0,
        "mark_unread",
        { markUnreadBeforeSeq: entry.seq }
      );
      applyReadStateToCache(client, workspaceId, next);
      invalidate();
    },
    [workspaceId, client, invalidate]
  );

  /** 서버 경로 「모두 읽음」: 필터에 맞는 보이는 안 읽음 전부. 채널 위치는 그대로다. */
  const markAllRead = useCallback(
    async (filter: MailboxFilter | "reminders") => {
      const done = await markInboxReadAll(workspaceId, {
        filter: toServerFilter(filter),
      });
      invalidate();
      return done;
    },
    [workspaceId, invalidate]
  );

  return { markRead, markUnread, markAllRead };
}

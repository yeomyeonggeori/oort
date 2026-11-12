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
import { idKey } from "@momo/core/features/workspace/directory";
import {
  composeMailbox,
  dmEntry,
  isServerItemUnread,
  isUnreadSeq,
  mailboxFilterHasTasks,
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
//
// ## 점은 항목 읽음과 채널 읽음 위치를 합쳐 정한다 (#5345, #5331의 웹 판)
//
// 서버는 채널 읽음 위치가 전진하는 트랜잭션에서 그 채널의 `seq <= 위치` 항목을 읽음으로 채운다(D3). 그런데 그 일은 서버
// 안에서 끝나서 이미 받아 둔 목록은 그 전의 스냅샷으로 남고, 위치에 의한 자동 읽음은 인박스 이벤트를 내지 않는다.
// 웹의 다시 읽는 길은 이벤트(`inbox_item.*`), 항목 읽음 직후, 마운트 때 낡았을 때(`STALE_MS`) 뿐이라 — 사이드바의 예약 훅이
// 같은 개인 채널을 앱이 사는 동안 쥐고 있어 받은함이 다시 마운트되어도 재구독 신호(`onResync`)가 오지 않는다 — 대화를
// 읽고 15초 안에 돌아오거나 다른 기기가 대화를 읽으면 같은 대화의 다른 항목이 점을 단 채 남았다.
//
// 그래서 규칙은 코어 `isServerItemUnread` 한 곳이다(폰과 같다): 항목의 `readAt`이 비었고 **그 채널의 읽음 위치(read-state
// 투영)가 항목의 `seq`를 지나지 않았을 때만** 안 읽음이다. 읽음 위치 투영은 이미 사이드바가 들고 있고(`useReadStates`)
// 위치를 보낼 때마다 바로, 그 밖에는 30초마다 다시 읽힌다. 점을 켜는 방향은 없다.
// 목록이 낡았다는 것을 알아챈 순간(`readAt`은 비었는데 위치가 지났다)에는 서버의 `readAt`·`unreadCount`를 되찾으려고 목록을
// 한 번 다시 읽는다(`useStaleListReread`).
// =============================================================================

const DM_CHANNEL_CAP = 30;
const DM_PAGE = 20;
const THREAD_CHANNEL_CAP = 12;
const THREAD_PAGE = 50;
const THREAD_ROOT_CAP = 10;
const STALE_MS = 15_000;
/** 메뉴 막대 「모두 읽음 처리」가 한 번에 보내는 요청 수(`markChannelsRead`). */
const READ_ALL_CONCURRENCY = 4;

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
   * 늦는 동안 투영만 비어 있다고 「비어 있어요」가 번쩍이지 않게 하는 값이다. 원장은 승인이 섞인
   * 탭(`mailboxFilterHasTasks`)에서만 세고, 채널·디렉터리가 오는 중인 것은 세지 않는다(#5116).
   */
  isLoading: boolean;
  /**
   * 보여 줄 줄이 없을 때 「비어 있다」고 말하면 거짓이 되는 실패가 있다. 구 서버 경로는 시도한
   * 원천이 모두 실패했을 때, 서버 경로는 투영이 실패했거나 승인 원장이 실패했을 때(#5092).
   * 일부만 실패하면 있는 만큼 그린다: 화면은 이 탭에 보일 줄이 없을 때만 이 값을 읽는다. 원장의
   * 실패도 승인이 섞인 탭에서만 센다(#5116).
   */
  error: boolean;
  /**
   * 서버 경로가 답하지 못했을 때의 그 오류 객체(투영 탐지 → 목록 순). 화면이 실패의 원인 문장(오프라인 / 서버에 닿지 못함)을 정하는
   * 데 쓴다(#5242). 구 서버 경로는 원천이 여럿이라 하나로 말할 수 없어 `null`이고, 그때 이유는 「문제가 생겼어요」다.
   */
  failure: unknown;
  /** 승인 원장이 없는 서버: 「처리할 일」 칸을 장애가 아닌 미제공으로 말한다. */
  tasksAbsent: boolean;
  /**
   * 승인 원장이 답했고 이 목록의 처리할 일 줄이 그 답에서 온다(#5116). 이때 목록에 없는 승인은 더 이상
   * 결정을 기다리지 않는다 — 다른 기기에서 결정했거나 만료됐다. 원장이 아직 한 번도 답하지 않았거나
   * (로딩·실패) 미제공이거나 투영이 실패해 목록을 비운 동안은 「없음」이 답이 아니므로 `false`다.
   */
  ledgerAnswered: boolean;
  /** 상한 때문에 일부 채널을 읽지 못했다. */
  capped: boolean;
  updatedAtMs: number;
  refetch: () => void;
}

const PAGE_SIZE = 30;

/** 서버가 센 안 읽음 수에서, 읽음 위치가 이미 지나서 점이 꺼진 낡은 항목 수를 뺀다. 수가 점보다 많이 남지 않게 한다. */
function serverUnreadOf(counted: number | undefined, staleItems: number): number | null {
  return counted === undefined ? null : Math.max(0, counted - staleItems);
}

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

/**
 * 목록이 낡았다는 것을 알아챈 순간 한 번 다시 읽는다 (#5345). 항목의 `readAt`은 비었는데 채널 읽음 위치가 이미 항목을 지났다:
 * 서버는 위치가 전진한 트랜잭션에서 그 항목을 읽음으로 채웠으니 우리가 가진 목록(그리고 그 `unreadCount`)이 그 전 스냅샷이라는 뜻이다.
 * 점은 규칙(`isServerItemUnread`)이 이미 바로잡았으므로 이 읽기는 서버의 `readAt`·수를 되찾는 일이다.
 *
 * 같은 낡음으로는 한 번만 요청한다: 항목 낱낱의 id 모음이 열쇠라서, 다시 읽은 답에도 그 항목이 여전히 비어 있으면(서버가 채우지
 * 않았다) 같은 요청을 되풀이하지 않고, 위치가 더 전진해 낡은 항목이 늘면 그때 다시 읽는다. 다른 읽기가 오는 중이면 그 답을 기다린다 —
 * 지금 막 마운트로 시작된 읽기를 끊고 다시 시작하지 않는다.
 */
function useStaleListReread(args: {
  enabled: boolean;
  staleItemIds: string;
  fetching: boolean;
  /** 이 화면의 목록 쿼리를 다시 읽는다(쿼리 키를 여기서 다시 적지 않는다). */
  reread: () => void;
}): void {
  const askedFor = useRef("");
  const { enabled, staleItemIds, fetching, reread } = args;
  useEffect(() => {
    if (!enabled || staleItemIds === "" || fetching) return;
    if (askedFor.current === staleItemIds) return;
    askedFor.current = staleItemIds;
    reread();
  }, [enabled, staleItemIds, fetching, reread]);
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
  //
  // 그 말은 **승인이 섞인 탭에만** 건다(#5116): 멘션·답글·DM·스레드 탭의 내용은 원장과 무관하다. 로딩은 원장
  // 자신의 첫 응답만 센다 — `needsAction.isLoading`은 채널·디렉터리가 오는 중인 것까지 세는 값이다.
  const tasksInTab = tasksProvided && mailboxFilterHasTasks(filter);
  const ledgerLoading = tasksInTab && needsAction.ledgerLoading;
  // 404(`absent`)는 장애가 아니라 미제공이다: 화면이 「처리할 일」 탭에서 따로 말한다.
  const ledgerFailed = tasksInTab && !needsAction.absent && needsAction.error;

  // 읽음 위치(read-state 투영): 사이드바가 이미 든 같은 쿼리라 요청이 늘지 않는다. 항목의 점은 이 위치와 합쳐 정한다.
  const readStates = useReadStates(workspaceId);
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
            place: context.placeFor(item.channel.id, item.channel),
            actor: context.actorFor(item.actorMemberId),
            nowMs,
            lastReadSeq: readStates.byChannel.get(idKey(item.channel.id))?.lastReadSeq,
          })
        );
      }
    }
    return out;
    // 시각 라벨은 데이터가 바뀔 때 다시 그려진다(now는 의존에 넣지 않는다).
  }, [query.data, context, readStates.byChannel]);

  // 목록은 안 읽음이라는데 읽음 위치는 이미 지난 항목: 목록이 위치 전진 전의 스냅샷이다. 점은 위 규칙이 이미 껐고, 서버가 센
  // 안 읽음 수에서는 이 항목들을 뺀다(같은 사실을 수에도 쓴다). 다시 읽으면 서버가 둘 다 맞게 돌려준다.
  const staleItems = useMemo(() => {
    const ids: string[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) {
        if (
          item.readAtMs === null &&
          !isServerItemUnread(item, readStates.byChannel.get(idKey(item.channel.id))?.lastReadSeq)
        ) {
          ids.push(item.id);
        }
      }
    }
    return ids;
  }, [query.data, readStates.byChannel]);
  const { refetch: rereadList } = query;
  const rereadStale = useCallback(() => void rereadList(), [rereadList]);
  useStaleListReread({
    enabled: serverOn,
    staleItemIds: staleItems.join(","),
    fetching: query.isFetching,
    reread: rereadStale,
  });

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

  // 투영이 답하지 못했는데 승인만 그리면 그것이 인박스 전부로 읽힌다: 오류를 말한다.
  const listed = serverOn && !(query.isError && !query.data);

  return {
    source: serverOn ? "server" : "probing",
    entries: listed ? entries : [],
    serverUnreadCount: serverUnreadOf(query.data?.pages[0]?.unreadCount, staleItems.length),
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    moreError: query.isFetchNextPageError,
    fetchMore: () => void query.fetchNextPage(),
    isLoading: surface.isPending || (serverOn && (query.isLoading || ledgerLoading)),
    error: surface.isError || (serverOn && (query.isError || ledgerFailed)),
    failure: surface.error ?? (serverOn ? query.error : null),
    tasksAbsent: !tasksProvided || needsAction.absent,
    ledgerAnswered: listed && ledgerHasAnswered(tasksProvided, needsAction),
    capped: false,
    updatedAtMs: Math.max(query.dataUpdatedAt, needsAction.updatedAtMs),
    refetch: refetchServer,
  };
}

/** 승인 원장이 성공한 답을 한 번이라도 줬다(미제공이 아니다). 그 답이 처리할 일 줄의 원천이다. */
function ledgerHasAnswered(tasksProvided: boolean, needsAction: Feed): boolean {
  return tasksProvided && !needsAction.absent && needsAction.updatedAtMs > 0;
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
        place: context.placeFor(channel.id),
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
        nowMs,
        context.placeFor(message.channelId)
      )
    );
    const threads = roots.map((root, index) =>
      threadEntry({
        root,
        channelLabel: context.labelFor(root.channelId),
        place: context.placeFor(root.channelId),
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
    failure: null,
    tasksAbsent: !tasksProvided || needsAction.absent,
    ledgerAnswered: ledgerHasAnswered(tasksProvided, needsAction),
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

  /**
   * 메뉴 막대 「모두 읽음 처리」(#5195): 받은 채널들의 읽음 위치를 올린다(`PUT read-state`, 사유 `mark_read_menu` =
   * 「읽음 처리」 메뉴와 같은 명시 행동). **인박스의 `read-all`과 다르다**: 항목만 읽음이 되고 채널 위치와 `mention_count`가
   * 그대로인 그 길(ADR-0199 D3)로는 독 배지와 메뉴 막대의 점이 안 꺼진다. 위치를 올리면 서버가 같은 트랜잭션에서
   * `mention_count`를 다시 세고 그 채널의 인박스 항목을 읽음으로 채운다 — 점·배지·인박스가 한 규칙으로 바뀐다.
   * 어느 채널을 올릴지는 호출부(`readAllTargets`)가 정한다.
   *
   * 채널마다 한 요청이고 `READ_ALL_CONCURRENCY`개씩 보낸다. 한 채널의 실패가 나머지를 멈추지 않는다 — 읽은 만큼은
   * 읽힌 채로 남고, 실패는 수로 돌려준다. 실패한 채널은 위치가 그대로라 점이 남아 다시 누를 수 있다.
   */
  const markChannelsRead = useCallback(
    async (targets: readonly { channelId: string; seq: number }[]) => {
      let failed = 0;
      let next = 0;
      const worker = async () => {
        for (;;) {
          const target = targets[next++];
          if (target === undefined) return;
          try {
            const state = await advertiseReadState(
              workspaceId,
              target.channelId,
              target.seq,
              "mark_read_menu"
            );
            applyReadStateToCache(client, workspaceId, state);
          } catch {
            failed += 1;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(READ_ALL_CONCURRENCY, targets.length) }, worker)
      );
      void client.invalidateQueries({ queryKey: ["read-state", workspaceId] });
      invalidate();
      return { marked: targets.length - failed, failed };
    },
    [workspaceId, client, invalidate]
  );

  return { markRead, markUnread, markAllRead, markChannelsRead };
}

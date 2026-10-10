import { useCallback, useMemo } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  fetchMessages,
  fetchThreadReplies,
  threadRollup,
  uuidEq,
  type Message,
  type ReadState,
} from "@momo/core/lib/api";
import {
  composeMailbox,
  dmEntry,
  isUnreadSeq,
  mentionEntry,
  taskEntry,
  threadEntry,
  type MailboxEntry,
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
} from "./useInbox";

// =============================================================================
// 인박스 목록의 원천 (#3663). 서버에 「인박스」 라우트는 없으므로 이미 있는 읽기만
// 쓴다 — 새 계약도, 새 의존도 없다. 각 원천과 한계는 core `mailbox.ts` 머리말에 있다.
//
//   DM       DM 채널 × 최근 메시지 페이지        (읽은 DM도 남는다)
//   멘션     read-state 멘션 수가 있는 채널의 커서 뒤 메시지 (안 읽은 것만, P7)
//   스레드   안 읽은 채널의 최근 페이지에서 내 글의 롤업 + 그 스레드의 마지막 답글
//   처리할 일 대기 중 승인
//
// 팬아웃은 상한이 있다. 채널이 많은 워크스페이스에서 인박스를 연 순간 수백 요청이
// 나가는 것은 기능이 아니라 사고다. 잘렸는지는 `capped`로 화면에 말한다.
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
  /** 모든 원천이 실패했을 때만. 일부만 실패하면 있는 만큼 그린다. */
  error: boolean;
  /** 승인 원장이 없는 서버: 「처리할 일」 칸을 장애가 아닌 미제공으로 말한다. */
  tasksAbsent: boolean;
  /** 상한 때문에 일부 채널을 읽지 못했다. */
  capped: boolean;
  updatedAtMs: number;
  refetch: () => void;
}

function recencyOf(state: ReadState | undefined): number {
  return state?.latestSeq ?? 0;
}

export function useMailbox(): Mailbox {
  const { session, workspaceId } = useSession();
  const selfId = session.member.id;
  const context = useFeedContext();
  const channelsQuery = useChannels(workspaceId);
  const readStates = useReadStates(workspaceId);
  const client = useQueryClient();
  const tasksProvided = isSurfaceProvided("approvals");
  const needsAction = useNeedsAction(tasksProvided);
  const { results: mentionResults } = useMentionMessages(true);

  const stateOf = useCallback(
    (channelId: string) => readStates.byChannel.get(channelId.toLowerCase()),
    [readStates.byChannel]
  );

  // ---- DM: 가장 최근에 움직인 대화부터 상한까지 --------------------------------
  const dmChannels = useMemo(
    () =>
      [...channelsQuery.groups.dms]
        .sort(
          (a, b) =>
            recencyOf(stateOf(b.id)) - recencyOf(stateOf(a.id))
        )
        .slice(0, DM_CHANNEL_CAP),
    [channelsQuery.groups.dms, stateOf]
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
  const unreadChannels = useMemo(
    () =>
      channelsQuery.groups.channels
        .filter((channel) => {
          const state = stateOf(channel.id);
          return state !== undefined && isUnreadSeq(state, state.latestSeq);
        })
        .slice(0, THREAD_CHANNEL_CAP),
    [channelsQuery.groups.channels, stateOf]
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
    channelsQuery.isError ||
    (tried.length > 0 && tried.every((source) => source.failed));

  const capped =
    channelsQuery.groups.dms.length > DM_CHANNEL_CAP ||
    channelsQuery.groups.channels.filter((c) => {
      const s = stateOf(c.id);
      return s !== undefined && isUnreadSeq(s, s.latestSeq);
    }).length > THREAD_CHANNEL_CAP;

  const refetch = useCallback(() => {
    void readStates.refetch();
    void needsAction.refetch();
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

/**
 * 항목 단위 읽음/안 읽음. 서버의 읽음은 채널 커서 하나라서 **같은 채널의 앞선
 * 메시지도 함께** 읽음이 된다 — 화면 문구가 그 사실을 말한다. 의도는 채널 열기와
 * 같다(`mark_read_menu` → explicit_open): 사람이 이 항목을 열어 읽었다는 뜻이다.
 */
export function useMailboxReadActions() {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const invalidate = useCallback(() => {
    for (const key of ["inbox-mentions", "inbox-dm", "inbox-thread-roots"]) {
      void client.invalidateQueries({ queryKey: [key, workspaceId] });
    }
  }, [client, workspaceId]);

  const markRead = useCallback(
    async (entry: MailboxEntry) => {
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
      if (entry.seq === undefined) return;
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

  return { markRead, markUnread };
}

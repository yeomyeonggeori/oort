import { useCallback, useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAgentRuns,
  fetchApprovals,
  fetchMessages,
  uuidEq,
  type ApprovalStatus,
  type Message,
} from "@momo/core/lib/api";
import { advertiseReadState } from "@/features/chat/advertiseReadState";
import { useSession } from "@/app/session";
import {
  channelLabel,
  memberFor,
  useChannels,
  useDirectory,
  useInvalidateReadStates,
  useReadStates,
  type Directory,
} from "@/features/workspace/useWorkspace";
import {
  approvalItem,
  mentionItem,
  mentionsMember,
  orderFeed,
  runItem,
  type ActorNames,
  type FeedItem,
} from "@momo/core/features/inbox/model";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";

// =============================================================================
// Inbox / activity reads. EXISTING REST only, no server change (MOMO-599):
//
//   결정 대기  GET /approvals?status=pending          approval ledger projection
//   멘션       GET /read-state  +  GET /messages?after=  the server's own mention
//              decision, read back from message.props.mention_member_ids
//   에이전트   GET /approvals?status=(pending|approved|rejected|expired)
//              + GET /channels/{ch}/agent-runs         work run projection
//
// Two consequences are stated rather than papered over:
//   - the inbox shows UNREAD mentions. `read_state.mention_count` is recomputed
//     as "mentions with seq > last_read_seq", so a mention that was read no
//     longer exists as a server fact and this client will not invent a history.
//   - there is no workspace-wide agent-run route, so the run feed fans out over
//     the caller's channels and is capped (RUN_CHANNEL_CAP) instead of walking
//     an unbounded list.
// =============================================================================

/** Mention backfill: at most this many ascending pages per channel. */
const MENTION_PAGE_LIMIT = 50;
const MENTION_MAX_PAGES = 4;
/** How many channels the work-run fan-out is allowed to touch. */
const RUN_CHANNEL_CAP = 12;
const FEED_STALE_MS = 15_000;

export interface Feed {
  items: FeedItem[];
  isLoading: boolean;
  /** True only when every source failed; a partial result still renders. */
  error: boolean;
  /**
   * 서버가 이 목록의 경로를 **모른다고 직접 답했다**(404/405/501).
   *
   * `error`와 따로 있는 이유는 goal W-AP1의 전부다. 승인 표면의 정적 판정은
   * 이제 `provided: true`이고(serverSurfaces.ts: 라우트가 코드에 올라갔다),
   * 그러니 아직 그 라우트를 배포하지 않은 서버에 붙으면 이 목록은 404를 받는다.
   * 그 404를 `error`로만 세면 화면은 "인박스를 불러오지 못했습니다 / 다시 시도"를
   * 그리고, 다시 시도해도 영영 같은 답이 온다. 아직 없는 기능은 장애가 아니다.
   *
   * 판정은 발명하지 않고 `serverSaysAbsent` 한 벌을 그대로 쓴다.
   */
  absent: boolean;
  /** Newest successful fetch across the sources, for the offline banner. */
  updatedAtMs: number;
  refetch: () => void;
}

// ---- shared resolution -------------------------------------------------

interface FeedContext {
  directory: Directory;
  labelFor: (channelId: string) => string;
  actorFor: (memberId: string) => ActorNames;
  isLoading: boolean;
}

function useFeedContext(): FeedContext {
  const { session, workspaceId } = useSession();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const { directory } = directoryQuery;
  const selfId = session.member.id;

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );

  const labelFor = useCallback(
    (channelId: string) => {
      const channel = channels.find((c) => uuidEq(c.id, channelId));
      // An id we cannot resolve is shown as an id, never as a made-up name.
      if (!channel) return channelId.slice(0, 8);
      return channelLabel(channel, directory, selfId);
    },
    [channels, directory, selfId]
  );

  const actorFor = useCallback(
    (memberId: string): ActorNames => {
      const member = memberFor(directory, memberId);
      if (!member) return { name: memberId.slice(0, 8), isAgent: false };
      const owner =
        member.kind === "agent"
          ? memberFor(directory, member.ownerHumanId)
          : null;
      return {
        name: member.displayName,
        handle: member.kind === "agent" ? member.handle : undefined,
        isAgent: member.kind === "agent",
        ownerName: owner?.displayName,
      };
    },
    [directory]
  );

  const isLoading = channelsQuery.isLoading || directoryQuery.isLoading;

  // Stable identity: every feed below memoises its rows against this object, so
  // a fresh one per render would rebuild the whole list on every keystroke.
  return useMemo(
    () => ({ directory, labelFor, actorFor, isLoading }),
    [directory, labelFor, actorFor, isLoading]
  );
}

// ---- 결정 대기 ---------------------------------------------------------

/**
 * 없는 경로는 다시 물어보지 않는다.
 *
 * 전역 기본값은 `retry: 1`인데, 404/405/501은 두 번 물어도 같은 답이 온다. 그
 * 한 번의 재시도는 미제공 판정을 왕복 하나만큼 늦추면서 아무것도 바꾸지 못한다.
 * 그 밖의 실패(네트워크 블립, 5xx)는 기본값 그대로 한 번 더 물어본다.
 */
function retryUnlessAbsent(failureCount: number, error: unknown): boolean {
  if (serverSaysAbsent(error)) return false;
  return failureCount < 1;
}

function useApprovalPage(status: ApprovalStatus, enabled: boolean) {
  const { workspaceId } = useSession();
  return useQuery({
    queryKey: ["approvals", workspaceId, status],
    queryFn: () => fetchApprovals(workspaceId, status),
    enabled,
    staleTime: FEED_STALE_MS,
    retry: retryUnlessAbsent,
  });
}

/**
 * Re-read the ledger after a decision was recorded (goal B5.3b D-5).
 *
 * Every status page, not just `pending`: a decision moves the row from one page
 * to another, so refreshing only the page it left would leave the 에이전트 feed
 * showing a stale absence. Where it went is the server's answer, and this client
 * does not move the row itself.
 */
export function useInvalidateApprovals(): () => void {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({ queryKey: ["approvals", workspaceId] });
  }, [client, workspaceId]);
}

export function useNeedsAction(enabled: boolean): Feed {
  const context = useFeedContext();
  const query = useApprovalPage("pending", enabled);

  const items = useMemo(() => {
    const nowMs = Date.now();
    return orderFeed(
      (query.data ?? []).map((approval) =>
        approvalItem(
          approval,
          context.actorFor(approval.requestedBy),
          context.labelFor(approval.channelId),
          nowMs
        )
      )
    );
  }, [query.data, context]);

  return {
    items,
    isLoading: query.isLoading || context.isLoading,
    error: query.isError,
    absent: serverSaysAbsent(query.error),
    updatedAtMs: query.dataUpdatedAt,
    refetch: () => void query.refetch(),
  };
}

// ---- 멘션 -------------------------------------------------------------

/**
 * Ascending pages after the read cursor until the server's mention count is
 * accounted for, or the page cap is reached. `?after=` is the same backfill the
 * timeline uses, so ordering stays seq-driven end to end.
 */
async function fetchMentionsAfter(
  workspaceId: string,
  channelId: string,
  afterSeq: number,
  selfMemberId: string,
  expected: number
): Promise<Message[]> {
  const found: Message[] = [];
  let cursor = afterSeq;
  for (let page = 0; page < MENTION_MAX_PAGES; page += 1) {
    const result = await fetchMessages(workspaceId, channelId, {
      after: cursor,
      limit: MENTION_PAGE_LIMIT,
    });
    if (result.messages.length === 0) break;
    for (const message of result.messages) {
      if (mentionsMember(message, selfMemberId)) found.push(message);
    }
    const maxSeq = result.messages.reduce(
      (max, message) => Math.max(max, message.seq),
      cursor
    );
    if (maxSeq <= cursor) break;
    cursor = maxSeq;
    if (found.length >= expected) break;
    if (result.messages.length < MENTION_PAGE_LIMIT) break;
  }
  return found;
}

export function useMentions(enabled: boolean): Feed {
  const { session, workspaceId } = useSession();
  const context = useFeedContext();
  const readStates = useReadStates(workspaceId);
  const client = useQueryClient();
  const selfId = session.member.id;

  // P7: the SERVER says which channels hold unread mentions. The client only
  // fetches the rows behind a count it was given, never scans for mentions.
  const pending = useMemo(
    () => (readStates.data ?? []).filter((state) => state.mentionCount > 0),
    [readStates.data]
  );

  const results = useQueries({
    queries: pending.map((state) => ({
      queryKey: [
        "inbox-mentions",
        workspaceId,
        state.channelId,
        state.lastReadSeq,
        state.mentionCount,
      ],
      queryFn: () =>
        fetchMentionsAfter(
          workspaceId,
          state.channelId,
          state.lastReadSeq,
          selfId,
          state.mentionCount
        ),
      enabled,
      staleTime: FEED_STALE_MS,
    })),
    // `combine` keeps one memoised shape instead of a fresh results array per
    // render, which is what the row memo below is keyed on.
    combine: (results) => ({
      messages: results.flatMap((result) => result.data ?? []),
      isLoading: results.some((result) => result.isLoading),
      allFailed: results.length > 0 && results.every((result) => result.isError),
      updatedAtMs: results.reduce(
        (max, result) => Math.max(max, result.dataUpdatedAt),
        0
      ),
    }),
  });

  const items = useMemo(() => {
    const nowMs = Date.now();
    return orderFeed(
      results.messages.map((message) =>
        mentionItem(
          message,
          context.actorFor(message.authorMemberId),
          context.labelFor(message.channelId),
          nowMs
        )
      )
    );
  }, [results.messages, context]);

  const refetch = useCallback(() => {
    void readStates.refetch();
    void client.invalidateQueries({ queryKey: ["inbox-mentions", workspaceId] });
  }, [readStates, client, workspaceId]);

  return {
    items,
    isLoading: readStates.isLoading || context.isLoading || results.isLoading,
    error: readStates.isError || results.allFailed,
    // 멘션은 read-state 투영과 메시지 읽기 위에 서 있고 둘 다 어느 세대의
    // 서버에나 있다(serverSurfaces.ts에 줄이 없는 이유가 그것이다). 이 탭이
    // 실패했다면 그것은 장애이지 미제공이 아니다.
    absent: false,
    updatedAtMs: Math.max(results.updatedAtMs, readStates.dataUpdatedAt),
    refetch,
  };
}

/**
 * Mark a mention read by advancing the server cursor past it (P7: the client
 * reports a position, the server owns the count). The server recomputes
 * `mention_count` in the same transaction, so the row leaves the inbox because
 * the projection changed, not because the client hid it.
 */
export function useMarkRead(): (channelId: string, seq: number) => Promise<void> {
  const { workspaceId } = useSession();
  const invalidateReadStates = useInvalidateReadStates(workspaceId);
  const client = useQueryClient();
  return useCallback(
    async (channelId: string, seq: number) => {
      await advertiseReadState(
        workspaceId,
        channelId,
        seq,
        "inbox_mention"
      );
      invalidateReadStates();
      await client.invalidateQueries({
        queryKey: ["inbox-mentions", workspaceId],
      });
    },
    [workspaceId, invalidateReadStates, client]
  );
}

/**
 * Unread mention total straight off the read-state projection (P7). The sidebar
 * already holds this query, so the tab badge costs no extra request and cannot
 * disagree with the per-channel pills.
 */
export function useMentionCount(): number {
  const { workspaceId } = useSession();
  const readStates = useReadStates(workspaceId);
  return (readStates.data ?? []).reduce(
    (total, state) => total + state.mentionCount,
    0
  );
}

/** Channels that still hold unread mentions, with the seq to read up to. */
export function useUnreadMentionChannels(): { channelId: string; seq: number }[] {
  const { workspaceId } = useSession();
  const readStates = useReadStates(workspaceId);
  return useMemo(
    () =>
      (readStates.data ?? [])
        .filter((state) => state.mentionCount > 0)
        .map((state) => ({ channelId: state.channelId, seq: state.latestSeq })),
    [readStates.data]
  );
}

// ---- 에이전트 ----------------------------------------------------------

const SETTLED_STATUSES: ApprovalStatus[] = ["approved", "rejected", "expired"];

/**
 * Agent activity: what agents asked for and what came of it, plus the work runs
 * they executed. `ownedBy` narrows to the agents one human is accountable for
 * (ADR-0131), which is what the inbox tab wants; the activity route passes
 * nothing and shows the whole workspace.
 */
export function useAgentFeed(
  enabled: boolean,
  options: { ownedBy?: string } = {}
): Feed {
  const { workspaceId } = useSession();
  const context = useFeedContext();
  const channelsQuery = useChannels(workspaceId);
  const client = useQueryClient();

  const approvalQueries = useQueries({
    queries: ["pending" as ApprovalStatus, ...SETTLED_STATUSES].map(
      (status) => ({
        queryKey: ["approvals", workspaceId, status],
        queryFn: () => fetchApprovals(workspaceId, status),
        enabled,
        staleTime: FEED_STALE_MS,
        retry: retryUnlessAbsent,
      })
    ),
    combine: (results) => ({
      approvals: results.flatMap((result) => result.data ?? []),
      isLoading: results.some((result) => result.isLoading),
      allFailed: results.every((result) => result.isError),
      absent: results.every((result) => serverSaysAbsent(result.error)),
      updatedAtMs: results.reduce(
        (max, result) => Math.max(max, result.dataUpdatedAt),
        0
      ),
    }),
  });

  const runChannelIds = useMemo(
    () =>
      [...channelsQuery.groups.channels, ...channelsQuery.groups.dms]
        .slice(0, RUN_CHANNEL_CAP)
        .map((channel) => channel.id),
    [channelsQuery.groups]
  );

  const runQueries = useQueries({
    queries: runChannelIds.map((channelId) => ({
      queryKey: ["agent-runs", workspaceId, channelId],
      queryFn: () => fetchAgentRuns(workspaceId, channelId),
      enabled,
      staleTime: FEED_STALE_MS,
      retry: retryUnlessAbsent,
    })),
    combine: (results) => ({
      runs: results.flatMap((result) => result.data ?? []),
      isLoading: results.some((result) => result.isLoading),
      // Vacuously true for an empty fan-out, so a workspace with no channels
      // lets the approval sources decide whether the feed is broken.
      allFailed: results.every((result) => result.isError),
      // 같은 공허참 규약. 채널이 0개인 워크스페이스에서는 승인 원장 쪽이 이
      // 피드의 제공 여부를 혼자 정한다.
      absent: results.every((result) => serverSaysAbsent(result.error)),
      updatedAtMs: results.reduce(
        (max, result) => Math.max(max, result.dataUpdatedAt),
        0
      ),
    }),
  });

  const ownedBy = options.ownedBy;
  const items = useMemo(() => {
    const nowMs = Date.now();
    /** Owner attribution decides membership of the "my agents" tab (ADR-0131). */
    const mine = (agentMemberId: string) => {
      if (ownedBy === undefined) return true;
      const member = context.directory.byId.get(agentMemberId.toLowerCase());
      return uuidEq(member?.ownerHumanId, ownedBy);
    };

    const rows: FeedItem[] = [];
    for (const approval of approvalQueries.approvals) {
      if (!mine(approval.requestedBy)) continue;
      rows.push(
        approvalItem(
          approval,
          context.actorFor(approval.requestedBy),
          context.labelFor(approval.channelId),
          nowMs
        )
      );
    }
    for (const run of runQueries.runs) {
      if (!mine(run.agentMemberId)) continue;
      rows.push(
        runItem(
          run,
          context.actorFor(run.agentMemberId),
          context.labelFor(run.channelId),
          nowMs
        )
      );
    }
    return orderFeed(rows);
  }, [approvalQueries.approvals, runQueries.runs, context, ownedBy]);

  const refetch = useCallback(() => {
    void client.invalidateQueries({ queryKey: ["approvals", workspaceId] });
    void client.invalidateQueries({ queryKey: ["agent-runs", workspaceId] });
  }, [client, workspaceId]);

  return {
    items,
    isLoading:
      context.isLoading || approvalQueries.isLoading || runQueries.isLoading,
    error: approvalQueries.allFailed && runQueries.allFailed,
    // 이 피드는 두 원장 위에 서 있다. 한쪽만 없으면 남은 쪽이 답할 수 있으므로
    // 미제공이 아니다 — 둘 다 "그런 경로 없다"고 답했을 때만 표면이 없는 것이다.
    absent: approvalQueries.absent && runQueries.absent,
    updatedAtMs: Math.max(
      approvalQueries.updatedAtMs,
      runQueries.updatedAtMs
    ),
    refetch,
  };
}

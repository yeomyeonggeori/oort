import {
  fetchAgentRuns,
  fetchApprovals,
  updateReadState,
  uuidEq,
  type ApprovalStatus,
} from '@momo/core/lib/api';
import {
  approvalItem,
  mentionItem,
  orderFeed,
  runItem,
  type ActorNames,
  type FeedItem,
} from '@momo/core/features/inbox/model';
import {
  channelLabel,
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {useQueries, useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback, useMemo} from 'react';
import {useNow} from '../../lib/useNow';
import {useSession} from '../../session/useSession';
import {
  useChannels,
  useDirectory,
  useInvalidateReadStates,
  useReadStates,
  workspaceKeys,
} from '../workspace/queries';
import {fetchMentionsAfter} from './mentions';

// =============================================================================
// The inbox feeds.
//
// Host wiring by ADR-0137 D3 (react-query hooks are explicitly not in the core),
// built to the same shape as `clients/web/src/features/inbox/useInbox.ts` —
// same query keys, same `combine` policy, same staleness. **Every row is built
// by the core**: `approvalItem`, `mentionItem`, `runItem` and `orderFeed` decide
// the sentence, the outcome word, the tone and the order. Nothing in this file
// writes user-facing copy about a row.
//
// ## `error` means EVERY source failed
//
// Not "a source failed". The three feeds fan out over channels, and on a phone
// one of eight requests failing on a lift ride is normal. Rendering the whole
// inbox as broken because of it would hide the seven answers that arrived. A
// partial result renders, and the aggregate only reports failure when there is
// genuinely nothing to show.
//
// ## Two of these three feeds are dark on the current server
//
// `approvals` and `agentRunHistory` are `provided: false` in
// `@momo/core/features/capabilities/serverSurfaces` (measured 2026-08-02 against
// the Rust server). They are implemented anyway, and gated by
// `availableInboxFilters` at the screen — which means the person never sees a
// tab that would always be empty, and the day those routes land the change is
// the one line in the core's table, with no RN edit at all. That is precisely
// what that table was built for.
// =============================================================================

/** Feeds hold their answers this long before a refetch is considered. */
const FEED_STALE_MS = 15_000;
/** How many channels the work-run fan-out may touch. */
const RUN_CHANNEL_CAP = 12;

export interface Feed {
  items: FeedItem[];
  isLoading: boolean;
  /** True only when every source failed; a partial result still renders. */
  error: boolean;
  /** Newest successful fetch across the sources. */
  updatedAtMs: number;
  refetch: () => void;
}

const SETTLED_STATUSES: ApprovalStatus[] = ['approved', 'rejected', 'expired'];

// ---- shared resolution ----------------------------------------------------

interface FeedContext {
  directory: Directory;
  labelFor: (channelId: string) => string;
  actorFor: (memberId: string) => ActorNames;
  isLoading: boolean;
}

function useFeedContext(): FeedContext {
  const {member, workspaceId} = useSession();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const {directory} = directoryQuery;
  const selfId = member.id;

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups],
  );

  const labelFor = useCallback(
    (channelId: string) => {
      const channel = channels.find(candidate => uuidEq(candidate.id, channelId));
      // An id we cannot resolve is shown as an id, never as a made-up name.
      if (!channel) return channelId.slice(0, 8);
      return channelLabel(channel, directory, selfId);
    },
    [channels, directory, selfId],
  );

  const actorFor = useCallback(
    (memberId: string): ActorNames => {
      const found = memberFor(directory, memberId);
      if (!found) return {name: memberId.slice(0, 8), isAgent: false};
      const owner =
        found.kind === 'agent' ? memberFor(directory, found.ownerHumanId) : null;
      return {
        name: found.displayName,
        handle: found.kind === 'agent' ? found.handle : undefined,
        isAgent: found.kind === 'agent',
        ownerName: owner?.displayName,
      };
    },
    [directory],
  );

  const isLoading = channelsQuery.isLoading || directoryQuery.isLoading;

  // Stable identity: each feed memoises its rows against this object, so a fresh
  // one per render would rebuild every row on every keystroke elsewhere.
  return useMemo(
    () => ({directory, labelFor, actorFor, isLoading}),
    [directory, labelFor, actorFor, isLoading],
  );
}

// ---- 결정 대기 -------------------------------------------------------------

/**
 * 결정이 기록된 뒤 원장을 다시 읽는다 (goal M-AP1, web의 같은 이름과 같은 규칙).
 *
 * `pending` 페이지만이 아니라 **모든 status 페이지**를 무효화한다: 결정은 행을 한
 * 페이지에서 다른 페이지로 옮기므로, 떠난 쪽만 새로 읽으면 에이전트 피드가 이미
 * 끝난 결정을 계속 대기 중으로 그린다. 행이 어디로 갔는지는 서버의 답이고, 이
 * 클라이언트는 행을 스스로 옮기지 않는다.
 */
export function useInvalidateApprovals(): () => void {
  const {workspaceId} = useSession();
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({queryKey: ['approvals', workspaceId]});
  }, [client, workspaceId]);
}

export function useNeedsAction(enabled: boolean): Feed {
  const {workspaceId} = useSession();
  const context = useFeedContext();
  const query = useQuery({
    queryKey: ['approvals', workspaceId, 'pending'],
    queryFn: () => fetchApprovals(workspaceId, 'pending'),
    enabled,
    staleTime: FEED_STALE_MS,
  });

  const nowMs = useNow();
  const items = useMemo(() => {
    return orderFeed(
      (query.data ?? []).map(approval =>
        approvalItem(
          approval,
          context.actorFor(approval.requestedBy),
          context.labelFor(approval.channelId),
          nowMs,
        ),
      ),
    );
  }, [query.data, context, nowMs]);

  return {
    items,
    isLoading: query.isLoading || context.isLoading,
    error: query.isError,
    updatedAtMs: query.dataUpdatedAt,
    refetch: () => void query.refetch(),
  };
}

// ---- 멘션 ------------------------------------------------------------------

export function useMentions(enabled: boolean): Feed {
  const {member, workspaceId} = useSession();
  const context = useFeedContext();
  const readStates = useReadStates(workspaceId);
  const client = useQueryClient();
  const selfId = member.id;

  // P7: the SERVER says which channels hold unread mentions. This client only
  // fetches the rows behind a count it was given; it never scans for mentions.
  const pending = useMemo(
    () => (readStates.data ?? []).filter(state => state.mentionCount > 0),
    [readStates.data],
  );

  const results = useQueries({
    queries: pending.map(state => ({
      queryKey: [
        'inbox-mentions',
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
          state.mentionCount,
        ),
      enabled,
      staleTime: FEED_STALE_MS,
    })),
    combine: queryResults => ({
      messages: queryResults.flatMap(result => result.data ?? []),
      isLoading: queryResults.some(result => result.isLoading),
      allFailed:
        queryResults.length > 0 && queryResults.every(result => result.isError),
      updatedAtMs: queryResults.reduce(
        (max, result) => Math.max(max, result.dataUpdatedAt),
        0,
      ),
    }),
  });

  const nowMs = useNow();
  const items = useMemo(() => {
    return orderFeed(
      results.messages.map(message =>
        mentionItem(
          message,
          context.actorFor(message.authorMemberId),
          context.labelFor(message.channelId),
          nowMs,
        ),
      ),
    );
  }, [results.messages, context, nowMs]);

  // Depends on the query CLIENT, not on the `readStates` object — that object is
  // `{...query, byChannel}`, a fresh identity every render, which would make this
  // callback unstable and quietly break the first `useEffect` that lists it as a
  // dependency (the next batch's timeline will).
  const refetch = useCallback(() => {
    void client.invalidateQueries({queryKey: workspaceKeys.readState(workspaceId)});
    void client.invalidateQueries({queryKey: ['inbox-mentions', workspaceId]});
  }, [client, workspaceId]);

  return {
    items,
    isLoading: readStates.isLoading || context.isLoading || results.isLoading,
    error: readStates.isError || results.allFailed,
    updatedAtMs: Math.max(results.updatedAtMs, readStates.dataUpdatedAt),
    refetch,
  };
}

// ---- 에이전트 --------------------------------------------------------------

export function useAgentFeed(enabled: boolean, ownedBy: string): Feed {
  const {workspaceId} = useSession();
  const context = useFeedContext();
  const channelsQuery = useChannels(workspaceId);
  const client = useQueryClient();

  const runChannelIds = useMemo(
    () =>
      [...channelsQuery.groups.channels, ...channelsQuery.groups.dms]
        .slice(0, RUN_CHANNEL_CAP)
        .map(channel => channel.id),
    [channelsQuery.groups],
  );

  const approvalQueries = useQueries({
    queries: (['pending' as ApprovalStatus, ...SETTLED_STATUSES]).map(status => ({
      queryKey: ['approvals', workspaceId, status],
      queryFn: () => fetchApprovals(workspaceId, status),
      enabled,
      staleTime: FEED_STALE_MS,
    })),
    combine: queryResults => ({
      approvals: queryResults.flatMap(result => result.data ?? []),
      isLoading: queryResults.some(result => result.isLoading),
      allFailed: queryResults.every(result => result.isError),
      updatedAtMs: queryResults.reduce(
        (max, result) => Math.max(max, result.dataUpdatedAt),
        0,
      ),
    }),
  });

  const runQueries = useQueries({
    queries: runChannelIds.map(channelId => ({
      queryKey: ['agent-runs', workspaceId, channelId],
      queryFn: () => fetchAgentRuns(workspaceId, channelId),
      enabled,
      staleTime: FEED_STALE_MS,
    })),
    combine: queryResults => ({
      runs: queryResults.flatMap(result => result.data ?? []),
      isLoading: queryResults.some(result => result.isLoading),
      // Vacuously true for an empty fan-out, so a workspace with no channels
      // lets the approval source decide whether the feed is broken.
      allFailed: queryResults.every(result => result.isError),
      updatedAtMs: queryResults.reduce(
        (max, result) => Math.max(max, result.dataUpdatedAt),
        0,
      ),
    }),
  });

  const nowMs = useNow();
  const items = useMemo(() => {
    // ADR-0131: an agent has a human who is accountable for it, and this tab is
    // "what did MY agents do" — not "what did every agent in the workspace do".
    const mine = (memberId: string): boolean => {
      const found = memberFor(context.directory, memberId);
      return uuidEq(found?.ownerHumanId, ownedBy);
    };
    const rows: FeedItem[] = [];
    for (const approval of approvalQueries.approvals) {
      if (!mine(approval.requestedBy)) continue;
      rows.push(
        approvalItem(
          approval,
          context.actorFor(approval.requestedBy),
          context.labelFor(approval.channelId),
          nowMs,
        ),
      );
    }
    for (const run of runQueries.runs) {
      if (!mine(run.agentMemberId)) continue;
      rows.push(
        runItem(
          run,
          context.actorFor(run.agentMemberId),
          context.labelFor(run.channelId),
          nowMs,
        ),
      );
    }
    return orderFeed(rows);
  }, [approvalQueries.approvals, runQueries.runs, context, ownedBy, nowMs]);

  // Invalidation rather than a list of `refetch()` calls: this feed fans out
  // over four approval status pages and up to twelve channels, and the fan-out
  // changes shape as the channel list does. Invalidating the two key prefixes
  // catches every query that is actually mounted, including ones added since
  // this callback was created.
  const refetch = useCallback(() => {
    void client.invalidateQueries({queryKey: ['approvals', workspaceId]});
    void client.invalidateQueries({queryKey: ['agent-runs', workspaceId]});
  }, [client, workspaceId]);

  return {
    items,
    isLoading:
      context.isLoading || approvalQueries.isLoading || runQueries.isLoading,
    error: approvalQueries.allFailed && runQueries.allFailed,
    updatedAtMs: Math.max(approvalQueries.updatedAtMs, runQueries.updatedAtMs),
    refetch,
  };
}

// ---- read cursor -----------------------------------------------------------

/**
 * Unread mention total, straight off the read-state projection (P7).
 *
 * The sidebar already holds this query, so the tab badge costs no extra request
 * and cannot disagree with the per-channel counts.
 */
export function useMentionCount(): number {
  const {workspaceId} = useSession();
  const readStates = useReadStates(workspaceId);
  return (readStates.data ?? []).reduce(
    (total, state) => total + state.mentionCount,
    0,
  );
}

/**
 * Mark a mention read by advancing the SERVER cursor past it (P7: the client
 * reports a position, the server owns the count). The row leaves the inbox
 * because the projection changed, not because this client hid it.
 */
export function useMarkRead(): (channelId: string, seq: number) => Promise<void> {
  const {workspaceId} = useSession();
  const invalidateReadStates = useInvalidateReadStates(workspaceId);
  const client = useQueryClient();
  return useCallback(
    async (channelId: string, seq: number) => {
      await updateReadState(workspaceId, channelId, seq);
      invalidateReadStates();
      await client.invalidateQueries({
        queryKey: ['inbox-mentions', workspaceId],
      });
    },
    [workspaceId, invalidateReadStates, client],
  );
}

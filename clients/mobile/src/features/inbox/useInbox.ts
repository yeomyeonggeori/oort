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
import {serverSaysAbsent} from '@momo/core/features/capabilities/serverSurfaces';
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
  /**
   * 서버가 이 목록의 경로를 **모른다고 직접 답했다**(404/405/501) — goal M-AP1 3R N-A.
   *
   * `error`와 따로 있어야 하는 이유는 정적 판정이 방금 뒤집혔기 때문이다:
   * `serverSurfaces`의 승인 줄은 이제 `provided: true`이고(라우트가 코드에 올라갔다),
   * 그러니 아직 그 라우트를 **배포하지 않은** 서버에 붙으면 이 목록은 404를 받는다.
   * 그 404를 `error`로만 세면 화면은 "인박스를 불러오지 못했습니다 / 다시 시도"를
   * 그리고, 다시 시도해도 영영 같은 답이 온다. 아직 없는 기능은 장애가 아니다.
   *
   * 판정은 발명하지 않고 웹과 **같은 한 벌**(`serverSaysAbsent`)을 쓴다.
   */
  absent: boolean;
  /** Newest successful fetch across the sources. */
  updatedAtMs: number;
  refetch: () => void;
}

const SETTLED_STATUSES: ApprovalStatus[] = ['approved', 'rejected', 'expired'];

/**
 * 없는 경로는 다시 물어보지 않는다 (3R N-A).
 *
 * 404/405/501은 두 번 물어도 같은 답이 온다. 그 한 번의 재시도는 미제공 판정을
 * 왕복 하나만큼 늦추면서 아무것도 바꾸지 못하고, 폰에서는 그 왕복이 라디오를 켠다.
 * 그 밖의 실패(네트워크 블립·5xx)는 기본 정책 그대로 한 번 더 물어본다.
 */
function retryUnlessAbsent(failureCount: number, error: unknown): boolean {
  if (serverSaysAbsent(error)) return false;
  return failureCount < 1;
}

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
    retry: retryUnlessAbsent,
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
    absent: serverSaysAbsent(query.error),
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
    // 멘션은 read-state 투영과 메시지 읽기 위에 서 있고 둘 다 어느 세대의 서버에나
    // 있다(`serverSurfaces`에 이 표면의 줄이 없는 이유가 그것이다). 이 탭이
    // 실패했다면 그것은 장애이지 미제공이 아니다.
    absent: false,
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
      retry: retryUnlessAbsent,
    })),
    combine: queryResults => ({
      approvals: queryResults.flatMap(result => result.data ?? []),
      isLoading: queryResults.some(result => result.isLoading),
      allFailed: queryResults.every(result => result.isError),
      absent: queryResults.every(result => serverSaysAbsent(result.error)),
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
      retry: retryUnlessAbsent,
    })),
    combine: queryResults => ({
      runs: queryResults.flatMap(result => result.data ?? []),
      isLoading: queryResults.some(result => result.isLoading),
      // Vacuously true for an empty fan-out, so a workspace with no channels
      // lets the approval source decide whether the feed is broken.
      allFailed: queryResults.every(result => result.isError),
      // 같은 공허참 규약. 채널이 0개인 워크스페이스에서는 승인 원장 쪽이 이 피드의
      // 제공 여부를 혼자 정한다.
      absent: queryResults.every(result => serverSaysAbsent(result.error)),
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
    // 이 피드는 두 원장 위에 서 있다. 한쪽만 없으면 남은 쪽이 답할 수 있으므로
    // 미제공이 아니다 — 둘 다 "그런 경로 없다"고 답했을 때만 표면이 없는 것이다.
    absent: approvalQueries.absent && runQueries.absent,
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

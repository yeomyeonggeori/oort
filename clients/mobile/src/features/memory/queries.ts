import {ApiError, fetchMessages} from '@momo/core/lib/api';
import {
  acceptMemoryProposal,
  getMemorySettings,
  getRunMemoryReceipt,
  listMemoryDigests,
  listMemoryProposals,
  patchMyMemorySettings,
  rejectMemoryProposal,
} from '@momo/core/features/memory/api';
import {memoryIsCaughtUp} from '@momo/core/features/memory/model';
import type {
  MemoryDigestPage,
  MemoryProposal,
  MemoryReceipt,
  MemorySettings,
} from '@momo/core/features/memory/model';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useRef} from 'react';
import type {QueryPhase} from './model';

// =============================================================================
// 팀 기억 v2 폰 읽기·쓰기 (ADR-0196 / #3166). 요청은 전부 코어 클라이언트를 지난다 —
// 여기서 `fetch`를 부르거나 응답을 다시 파싱하지 않는다.
//
// 훅은 호스트에 둔다(ADR-0137 D3). 키는 웹과 같은 모양이면 좋으나 두 클라이언트가
// 캐시를 나누지 않으므로 이름만 겹치지 않으면 된다.
// =============================================================================

export const memoryKeys = {
  settings: (workspaceId: string) =>
    ['memory', 'settings', workspaceId.toLowerCase()] as const,
  digests: (
    workspaceId: string,
    channelId: string,
    threadRootId: string | null,
    sinceSeq: number,
  ) =>
    [
      'memory',
      'digests',
      workspaceId.toLowerCase(),
      channelId.toLowerCase(),
      threadRootId?.toLowerCase() ?? '-',
      sinceSeq,
    ] as const,
  proposals: (workspaceId: string, channelId: string, runId: string) =>
    [
      'memory',
      'proposals',
      workspaceId.toLowerCase(),
      channelId.toLowerCase(),
      runId.toLowerCase(),
    ] as const,
  evidenceText: (workspaceId: string, channelId: string, messageId: string) =>
    [
      'memory',
      'evidence-text',
      workspaceId.toLowerCase(),
      channelId.toLowerCase(),
      messageId.toLowerCase(),
    ] as const,
  receipt: (workspaceId: string, runId: string) =>
    ['memory', 'receipt', workspaceId.toLowerCase(), runId.toLowerCase()] as const,
};

/** 요약을 아직 만드는 중일 때 다시 묻는 간격. */
export const DIGEST_POLL_MS = 20_000;

export function phaseOf(query: {
  isPending: boolean;
  isError: boolean;
  data: unknown;
}): QueryPhase {
  if (query.data !== undefined) return 'ready';
  if (query.isError) return 'error';
  return 'loading';
}

/** 워크스페이스 설정과 내 일시정지. 채널 행은 내가 읽을 수 있는 것만 온다. */
export function useMemorySettings(workspaceId: string, enabled = true) {
  return useQuery<MemorySettings>({
    queryKey: memoryKeys.settings(workspaceId),
    queryFn: () => getMemorySettings(workspaceId),
    enabled,
    retry: false,
  });
}

/**
 * 안 읽은 동안의 요약.
 *
 * **`sinceLastRead`를 쓰지 않고 방문이 얼린 `sinceSeq`를 보낸다.** 서버의
 * `sinceLastRead`는 요청 시점의 내 커서를 기준으로 삼는데, 폰은 방을 열자마자 커서를
 * 앞으로 보낸다. 요청이 그 뒤에 도착하면 서버는 「이미 다 읽음」으로 보고 빈 목록을
 * 준다 — 요약해야 할 바로 그 대화를 「없음」이라고 말하게 된다. 구분선이 쓰는 얼린
 * 경계(`foldVisitBoundary`)가 같은 기준선이다.
 */
export function useMissedDigests(input: {
  workspaceId: string;
  channelId: string;
  threadRootId: string | null;
  sinceSeq: number;
  headSeq: number;
  enabled: boolean;
}) {
  // 머리 seq는 키에 넣지 않는다: 메시지가 올 때마다 새 요청이 나가면 안 된다.
  const head = useRef(input.headSeq);
  head.current = input.headSeq;
  return useQuery<MemoryDigestPage>({
    queryKey: memoryKeys.digests(
      input.workspaceId,
      input.channelId,
      input.threadRootId,
      input.sinceSeq,
    ),
    queryFn: () =>
      listMemoryDigests(input.workspaceId, input.channelId, {
        sinceSeq: input.sinceSeq,
        limit: 10,
        ...(input.threadRootId !== null ? {threadRootId: input.threadRootId} : {}),
      }),
    enabled: input.enabled,
    retry: false,
    // 워커가 따라잡을 때까지만 다시 묻는다. 따라잡은 뒤에는 멈춘다.
    refetchInterval: query =>
      query.state.data !== undefined &&
      !memoryIsCaughtUp(query.state.data, head.current)
        ? DIGEST_POLL_MS
        : false,
  });
}

/**
 * 한 run의 기억 영수증. 영수증은 run마다 한 번 쓰이고 바뀌지 않으므로 다시 묻지 않는다.
 * 404(영수증 없음)는 오류가 아니라 「참고한 기억 없음」이라 `null`이다.
 */
export function useRunMemoryReceipt(workspaceId: string, runId: string | null) {
  return useQuery<MemoryReceipt | null>({
    queryKey: memoryKeys.receipt(workspaceId, runId ?? ''),
    queryFn: async () => {
      try {
        return await getRunMemoryReceipt(workspaceId, runId as string);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: runId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 내 기억 일시정지. `usePauseNotifications`와 같은 모양이다: 한 번 읽어야 스위치가
 * 서고(모르는 상태를 「꺼짐」으로 그리지 않는다), 쓰기는 낙관적으로 칠하고 실패하면
 * 되돌린다.
 */
export function useMyMemoryPause(workspaceId: string) {
  const client = useQueryClient();
  const key = memoryKeys.settings(workspaceId);
  const query = useMemorySettings(workspaceId);
  const mutation = useMutation({
    mutationFn: (paused: boolean) => patchMyMemorySettings(workspaceId, paused),
    onMutate: async (paused: boolean) => {
      await client.cancelQueries({queryKey: key});
      const previous = client.getQueryData<MemorySettings>(key);
      if (previous) {
        client.setQueryData<MemorySettings>(key, {...previous, me: {paused}});
      }
      return {previous};
    },
    onError: (_error, _paused, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSuccess: saved => {
      const current = client.getQueryData<MemorySettings>(key);
      if (current) client.setQueryData<MemorySettings>(key, {...current, me: saved});
    },
  });
  const settings = query.data;
  return {
    ready: settings !== undefined,
    paused: settings?.me.paused ?? false,
    workspaceEnabled: settings?.workspace.enabled ?? true,
    loadFailed: query.isError && settings === undefined,
    retryLoad: () => void query.refetch(),
    pending: mutation.isPending,
    failed: mutation.isError,
    setPaused: (paused: boolean) => {
      if (settings === undefined || mutation.isPending) return;
      mutation.mutate(paused);
    },
  };
}

/**
 * 한 run이 낸 「기억해 둘게요」 제안(아직 정하지 않은 것). 실시간 신호가 없으므로
 * 다시 묻지 않는다: 답이 그려질 때 한 번 묻고, 결정은 카드가 응답으로 직접 안다.
 * 읽지 못하는 채널은 서버가 빈 목록을 주므로 「제안 없음」과 구분되지 않는다 — 그래서
 * 오류도 조용히 카드가 없다(답을 가리지 않는다).
 */
export function useRunMemoryProposals(
  workspaceId: string,
  channelId: string,
  runId: string | null,
) {
  return useQuery<MemoryProposal[]>({
    queryKey: memoryKeys.proposals(workspaceId, channelId, runId ?? ''),
    queryFn: () =>
      listMemoryProposals(workspaceId, channelId, {
        runId: runId as string,
        status: 'pending',
        limit: 5,
      }),
    enabled: runId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 제안 근거 한 줄의 원문. 코어는 메시지 하나를 id로 읽는 길이 없어서 채널 읽기
 * (`after=seq-1`, 1건)로 그 seq의 메시지를 가져온다. 다른 메시지가 오거나 지워졌으면
 * `null` — 카드는 원문 없이 「누가 · #seq」 줄만 세운다.
 */
export function useProposalEvidenceText(
  workspaceId: string,
  channelId: string,
  evidence: {messageId: string; seq: number},
) {
  return useQuery<string | null>({
    queryKey: memoryKeys.evidenceText(workspaceId, channelId, evidence.messageId),
    queryFn: async () => {
      const page = await fetchMessages(workspaceId, channelId, {
        after: Math.max(0, evidence.seq - 1),
        limit: 1,
      });
      const row = page.messages.find(
        message => message.id.toLowerCase() === evidence.messageId.toLowerCase(),
      );
      if (row === undefined || row.state === 'deleted') return null;
      return row.body ?? null;
    },
    staleTime: Infinity,
    retry: false,
  });
}

/** 수락·거절. 성공하면 응답(본문이 지워진 껍데기)을 돌려준다. */
export function useDecideProposal(workspaceId: string) {
  return useMutation({
    mutationFn: (input: {id: string; decision: 'accept' | 'reject'}) =>
      input.decision === 'accept'
        ? acceptMemoryProposal(workspaceId, input.id)
        : rejectMemoryProposal(workspaceId, input.id),
  });
}

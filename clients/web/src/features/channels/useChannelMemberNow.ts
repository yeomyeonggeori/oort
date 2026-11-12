import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ApiError,
  fetchAllActiveAgentRuns,
  type AgentRunProgress,
} from "@momo/core/lib/api";
import { WireShapeError } from "@momo/core/lib/wire";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import {
  channelAgentNow,
  type ChannelAgentNow,
} from "@momo/core/features/agents/channelAgentNow";
import type { AgentWorkingSignal } from "@momo/core/features/agents/workingSignal";
import { useSession } from "@/app/session";
import { useAgentWorkingSignals } from "@/features/agents/agentWorkingSignal";

// =============================================================================
// 채널 멤버 패널의 「지금」 읽기 (#5686). 패널이 **열려 있을 때만** 이 훅이 선다(패널 목록 컴포넌트가 Dialog 안에
// 있어 닫히면 사라진다). 닫혀 있으면 요청도 타이머도 없다.
//
// 언제 읽나:
//   1. 열 때 한 번 — `GET …/agent-runs?state=active`(쪽 상한까지, 보통 한 번). 5초 안에 다시 열면 받아 둔 답을 쓴다.
//   2. 열려 있는 동안 레일 신호가 이 채널에서 바뀔 때 — 단계 프레임은 run당 2초에 하나로 합쳐 오므로(ADR-0200 증보 7 ④)
//      한 번 읽은 뒤 `RAIL_REFETCH_GAP_MS` 안의 신호는 그 끝에 한 번으로 모은다.
//   3. 열려 있는 동안 느린 박자(`SLOW_POLL_MS`) — 레일이 모르는 run(관리형·gateway)의 단계·끝을 줍는다.
//
// 채널 진행 읽기(`…/agent-runs/progress`)는 쓰지 않는다: 호스팅 에이전트만 주므로 Hermes·관리형이 빠진다.
// =============================================================================

/** 열려 있는 동안의 느린 박자. */
export const SLOW_POLL_MS = 60_000;
/** 레일 신호로 다시 읽는 최소 간격(이 안의 신호는 끝에 한 번으로 모은다). */
export const RAIL_REFETCH_GAP_MS = 5_000;
/** 「n분째」를 고쳐 그리는 시계. 1분 단위 글이라 이 간격이면 많아야 15초 늦다. */
export const MEMBER_NOW_CLOCK_MS = 15_000;
/** 열 때 묶음을 정하기 전에 첫 읽기를 기다리는 상한. 넘으면 아는 만큼으로 묶는다. */
export const SNAPSHOT_WAIT_MS = 1_200;
/** 다시 열 때 받아 둔 답을 그대로 쓰는 시간. */
const ACTIVE_RUNS_STALE_MS = 5_000;

export function activeAgentRunsQueryKey(workspaceId: string) {
  return ["agent-runs-active", workspaceId.toLowerCase()] as const;
}

/** 읽기 결과: `null`은 「이 서버에는 없다(또는 읽지 못하는 모양)」 — 오류가 아니다. */
type ActiveRuns = { runs: AgentRunProgress[] } | null;

export type MemberNowRead =
  /** 첫 읽기를 기다리는 중. */
  | "pending"
  /** 답이 있다(직전 답일 수도 있다). */
  | "ready"
  /** 이 서버에는 이 읽기가 없다: 에이전트 줄은 생존 낱말만 말한다. */
  | "absent"
  /** 읽지 못했다(네트워크·5xx). 다시 불러올 수 있다. */
  | "failed";

/** 이 채널의 레일 신호 지문: 시계와 무관하게 「무엇이 바뀌었나」만. */
function railFingerprint(
  signals: ReadonlyMap<string, AgentWorkingSignal>,
  channelId: string
): string {
  const prefix = `${channelId.toLowerCase()}|`;
  const parts: string[] = [];
  for (const [key, signal] of signals) {
    if (!key.startsWith(prefix)) continue;
    parts.push(
      [
        key,
        signal.runId ?? "",
        signal.state,
        signal.server?.phase ?? "",
        signal.headlines[0] ?? "",
      ].join("\u0000")
    );
  }
  return parts.sort().join("\u0001");
}

function useClock(enabled: boolean, everyMs: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), everyMs);
    return () => clearInterval(id);
  }, [enabled, everyMs]);
  return Date.now();
}

export interface ChannelMemberNow {
  /** 이 채널에서 일하는 에이전트의 한 줄(에이전트 id 소문자 → 줄). */
  lines: ReadonlyMap<string, ChannelAgentNow>;
  read: MemberNowRead;
  /** 묶음을 정해도 되는가: 첫 읽기가 끝났거나 기다림 상한을 넘었다. */
  settled: boolean;
  nowMs: number;
  retry: () => void;
}

export function useChannelMemberNow(channelId: string, enabled: boolean): ChannelMemberNow {
  const { workspaceId } = useSession();
  const query = useQuery({
    queryKey: activeAgentRunsQueryKey(workspaceId),
    queryFn: async (): Promise<ActiveRuns> => {
      try {
        const { runs } = await fetchAllActiveAgentRuns(workspaceId);
        return { runs };
      } catch (error) {
        if (serverSaysAbsent(error) || error instanceof WireShapeError) return null;
        throw error;
      }
    },
    enabled,
    staleTime: ACTIVE_RUNS_STALE_MS,
    retry: (count: number, error: unknown) =>
      !(error instanceof ApiError && error.status < 500) && count < 1,
    refetchInterval: (q: { state: { data?: ActiveRuns } }) =>
      enabled && q.state.data !== null ? SLOW_POLL_MS : false,
    refetchOnWindowFocus: false,
  });

  // 레일 신호로 다시 읽기. 첫 지문은 읽기를 부르지 않는다(열 때 이미 읽는다). 첫 답이 오기 전의 신호와 이 서버에
  // 없는 읽기(`null`)는 지문만 받아 두고 읽지 않는다: 도는 첫 읽기를 끊고 다시 읽으면 열 때의 요청이 둘이 된다.
  const signals = useAgentWorkingSignals();
  const fingerprint = useMemo(() => railFingerprint(signals, channelId), [signals, channelId]);
  const lastFingerprint = useRef(fingerprint);
  const lastRefetchAt = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetch = query.refetch;
  const answered = query.data !== undefined && query.data !== null;
  // 열 때의 읽기도 「마지막으로 읽은 때」다: 열자마자 온 신호가 두 번째 읽기를 바로 부르지 않게.
  useEffect(() => {
    if (query.dataUpdatedAt > lastRefetchAt.current) lastRefetchAt.current = query.dataUpdatedAt;
  }, [query.dataUpdatedAt]);
  useEffect(() => {
    if (fingerprint === lastFingerprint.current) return;
    lastFingerprint.current = fingerprint;
    if (!enabled || !answered) return;
    if (trailing.current !== null) return;
    const wait = lastRefetchAt.current + RAIL_REFETCH_GAP_MS - Date.now();
    const fire = () => {
      trailing.current = null;
      lastRefetchAt.current = Date.now();
      void refetch();
    };
    if (wait <= 0) fire();
    else trailing.current = setTimeout(fire, wait);
  }, [enabled, answered, fingerprint, refetch]);
  useEffect(
    () => () => {
      if (trailing.current !== null) clearTimeout(trailing.current);
      trailing.current = null;
    },
    []
  );

  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const id = setTimeout(() => setWaited(true), SNAPSHOT_WAIT_MS);
    return () => clearTimeout(id);
  }, [enabled]);

  const nowMs = useClock(enabled, MEMBER_NOW_CLOCK_MS);
  const runs = query.data?.runs;
  const lines = useMemo(
    () => (runs === undefined ? new Map<string, ChannelAgentNow>() : channelAgentNow(runs, channelId, nowMs)),
    [runs, channelId, nowMs]
  );

  const read: MemberNowRead =
    query.data === null
      ? "absent"
      : query.data !== undefined
        ? "ready"
        : query.isError
          ? "failed"
          : "pending";
  const settled =
    !enabled ||
    waited ||
    query.fetchStatus === "paused" ||
    (query.status !== "pending" && !query.isFetching);

  return {
    lines,
    read: read === "ready" && query.isError ? "failed" : read,
    settled,
    nowMs,
    retry: () => void refetch(),
  };
}

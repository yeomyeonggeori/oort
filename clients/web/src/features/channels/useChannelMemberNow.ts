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
import { isUncollected } from "@momo/core/features/agents/runWaiting";
import { useSession } from "@/app/session";
import { agentTurnsInChannel, useAgentWorkingSignals } from "@/features/agents/agentWorkingSignal";

// =============================================================================
// 채널 멤버 패널의 「지금」 읽기 (#5686). 패널이 **열려 있을 때만** 이 훅이 선다(패널 목록 컴포넌트가 Dialog 안에
// 있어 닫히면 사라진다). 닫혀 있으면 요청도 타이머도 없다.
//
// 에이전트 멤버가 없는 채널(사람만·빈 채널)에서는 읽지 않는다(`enabled`). 패널은 이 읽기를 **기다리지 않는다**:
// 명부의 줄은 첫 프레임부터 서고, 읽기가 돌아오면 에이전트 줄의 둘째 줄 자리를 그대로 채운다(#5686 수리 1회차, 검수 H1).
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
/** 다시 열 때 받아 둔 답을 그대로 쓰는 시간. */
const ACTIVE_RUNS_STALE_MS = 5_000;
/**
 * 받아 둔 「지금」 답을 묶음 판정과 「작업 중」 줄에 쓰는 나이 상한(#5701). 패널을 연 때 이보다 오래된 답은 새 답이 올
 * 때까지 쓰지 않는다: 그사이 끝난 run이 「작업 중 · n분째」로 서거나 일하는 묶음에 남지 않게(react-query는 닫은 뒤에도
 * 5분 보관한다). 열려 있는 동안 받은 답은 나이를 다시 묻지 않는다.
 */
export const MEMBER_NOW_ANSWER_MAX_AGE_MS = 60_000;

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
  /**
   * 연결이 끊겼거나 마지막 다시 읽기가 실패해 줄이 **마지막으로 받은 때**의 사실이다. 그동안 「n분째」와 「아직 받지 않았어요」
   * 유예는 그 시각에 멈춘다(끊긴 소켓 위에서 시계가 계속 가면 에이전트가 아니라 우리의 짐작을 잰다, ADR-0200 증보 7 ③).
   */
  stale: boolean;
  /**
   * 레일 신호가 지금 이 채널에서 열린 턴으로 아는 에이전트(id 소문자). 「지금」 읽기의 답이 아직 없을 때도 열 때의 묶음이
   * 「일하는 에이전트」를 가를 수 있게(레일과 같은 판정: 낡은 신호·「아직 받지 않았어요」 유예를 넘은 run은 뺌).
   */
  railWorking: ReadonlySet<string>;
  nowMs: number;
  retry: () => void;
}

export function useChannelMemberNow(
  channelId: string,
  enabled: boolean,
  options: { offline?: boolean } = {}
): ChannelMemberNow {
  const { workspaceId } = useSession();
  // 패널을 연 때(이 훅이 선 때). 열기 전에 받아 둔 답의 나이는 이 시각으로 잰다.
  const openedAt = useRef(Date.now());
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
  const failing = query.isError;
  const fetching = query.isFetching;
  useEffect(() => {
    if (fingerprint === lastFingerprint.current) return;
    lastFingerprint.current = fingerprint;
    if (!enabled || !answered) return;
    // 마지막 읽기가 실패한 동안에는 신호로 다시 묻지 않는다(실패마다 다시 묻기가 붙어 늘어난다, 검수 L1): 박자와
    // 「다시 불러오기」가 맡는다. 도는 읽기가 있으면 그 답을 기다린다(끊고 다시 읽으면 열 때의 요청이 둘이 된다, L2).
    if (failing || fetching) return;
    if (trailing.current !== null) return;
    const wait = lastRefetchAt.current + RAIL_REFETCH_GAP_MS - Date.now();
    const fire = () => {
      trailing.current = null;
      lastRefetchAt.current = Date.now();
      void refetch();
    };
    if (wait <= 0) fire();
    else trailing.current = setTimeout(fire, wait);
  }, [enabled, answered, failing, fetching, fingerprint, refetch]);
  useEffect(
    () => () => {
      if (trailing.current !== null) clearTimeout(trailing.current);
      trailing.current = null;
    },
    []
  );

  // 연 때 60초보다 오래된 답은 새 답이 올 때까지 없는 것으로 친다. 열려 있는 동안 받은 답은 시각을 비교하지 않고 「연 때 있던
  // 답과 다른 답인가」로 가른다: 벽시계가 뒤로 가도(60초 넘게) 새 답을 낡은 것으로 거르지 않는다(#5711 L2).
  const openedWith = useRef(query.dataUpdatedAt);
  const receivedWhileOpen = query.dataUpdatedAt !== openedWith.current;
  const usable =
    answered && (receivedWhileOpen || openedAt.current - query.dataUpdatedAt <= MEMBER_NOW_ANSWER_MAX_AGE_MS);
  // 첫 읽기부터 실패한 뒤 다시 읽는 동안에도 실패 줄(과 그 단추)을 둔다: 단추가 사라지면 초점이 패널 그릇으로 간다(#5711 L3).
  const failedBefore = useRef(false);
  if (query.isError) failedBefore.current = true;
  else if (query.data !== undefined) failedBefore.current = false;
  const stale = usable && (options.offline === true || query.isError);
  const nowMs = useClock(enabled && !stale, MEMBER_NOW_CLOCK_MS);
  // 줄을 재는 시각: 끊겼거나 다시 읽기가 실패했으면 마지막으로 받은 때, 아니면 지금.
  const linesAt = stale && query.dataUpdatedAt > 0 ? query.dataUpdatedAt : nowMs;
  const railWorking = new Set<string>();
  for (const turn of agentTurnsInChannel(signals, channelId, nowMs)) {
    if (isUncollected(turn.server, nowMs)) continue;
    railWorking.add(turn.memberId.toLowerCase());
  }
  const runs = usable ? query.data?.runs : undefined;
  const lines = useMemo(
    () => (runs === undefined ? new Map<string, ChannelAgentNow>() : channelAgentNow(runs, channelId, linesAt)),
    [runs, channelId, linesAt]
  );

  const read: MemberNowRead =
    query.data === null
      ? "absent"
      : usable
        ? "ready"
        : query.isError || (failedBefore.current && query.isFetching)
          ? "failed"
          : "pending";

  return {
    lines,
    read: read === "ready" && query.isError ? "failed" : read,
    stale,
    railWorking,
    nowMs,
    retry: () => void refetch(),
  };
}

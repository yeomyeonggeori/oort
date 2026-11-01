import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAgentRunEvents } from "@momo/core/lib/api";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import { isOpenRunPhase } from "@momo/core/features/agents/runPhase";
import {
  ledgerRows,
  type RunLedgerRow,
} from "@momo/core/features/agents/runLedger";
import {
  workToolRecord,
  type WorkToolRecord,
} from "@momo/core/features/agents/workTimeline";
import type { ServerRunFacts } from "@momo/core/features/agents/workingSignal";
import {
  doorbellFactOf,
  type DoorbellFact,
} from "@momo/core/features/agents/runStatusLine";
import { useSession } from "@/app/session";
import { subscribeRunLedgerFrames } from "./agentRunProgressStore";

// =============================================================================
// 서버 원장 읽기 (ADR-0200 D2, #3748). 원장은 서버가 기억하므로 패널을 닫아도
// 남고, 이 훅은 열 때마다 통째로 다시 읽는다(커서가 없다 — openapi 「ordinal은
// 키가 아님」).
//
// 다시 읽는 때: 열 때, 서버가 이 run에 대해 새 사실을 알려 줄 때(진행 읽기의
// 지문이 바뀔 때 — `agent.run.event` 프레임이 그 읽기를 일으킨다), 그리고 열린
// run이 있는 동안 30초마다(마지막 단계가 프레임 없이 끝날 수 있다).
// =============================================================================

export const RUN_LEDGER_POLL_MS = 30_000;

export interface RunLedgerView {
  rows: RunLedgerRow[];
  counts?: { tools?: number; approvals: number };
  /** 원장의 깨우는 신호(행이 없거나 아직 못 읽었으면 null). */
  doorbell: DoorbellFact | null;
  /**
   * 「oort 기록」 칸의 재료(oort가 직접 잰 도구 호출, #4654). 아직 읽은 원장이 없으면 null.
   * `supported`가 false면 이 서버는 `include=tools`를 모른다: 호출이 없다는 뜻이 아니다.
   */
  tools: WorkToolRecord | null;
  isLoading: boolean;
  /** 읽지 못했다(네트워크·5xx). 직전에 읽은 줄이 있으면 그대로 남는다. */
  isError: boolean;
}

/** 진행 읽기에서 원장이 바뀌었음을 알려 주는 사실들의 지문. */
function fingerprintOf(facts: ServerRunFacts | null): string {
  if (facts === null) return "";
  return [
    facts.phase,
    facts.leaseState,
    facts.lastEventAtMs ?? "",
    facts.latestStage ?? "",
    facts.approvalId ?? "",
    facts.endReason ?? "",
  ].join("|");
}

/**
 * 원장 읽기의 키와 함수. 작업 패널과 메시지 아래 상태 줄이 **같은 캐시**를 쓴다: 한 run의
 * 원장을 두 표면이 따로 읽으면 같은 순간에 서로 다른 단계를 말할 수 있다.
 *
 * 깨우는 신호 행(`doorbell`, #3824)과 oort가 잰 도구 호출(`tools`, #4654)을 함께 달라고
 * 묻는다. 그 값을 모르는 옛 서버는 쿼리를 읽지 않고 예전 원장을 주거나, 400이면 한 칸씩 물러서
 * 다시 읽는다(`fetchAgentRunEvents`). 두 표면이 같은 캐시를 쓰므로 묻는 값도 같다.
 */
export function runLedgerQueryOptions(workspaceId: string, runKey: string | null) {
  return {
    queryKey: ["agent-run-events", workspaceId, runKey] as const,
    queryFn: () =>
      fetchAgentRunEvents(workspaceId, runKey as string, {
        includeDoorbell: true,
        includeTools: true,
      }),
    staleTime: 0,
    retry: (count: number, error: unknown) => !serverSaysAbsent(error) && count < 1,
  };
}

/**
 * 이 run의 원장에 행이 생겼다는 프레임이 오면 다시 읽는다. 깨우는 신호 행은 진행의
 * 지문을 바꾸지 않으므로(서버가 `lastEventAtMs`에서 뺀다) 이 길이 아니면 30초를 기다린다.
 */
export function useRunLedgerFrames(
  runKey: string | null,
  refetch: () => unknown
): void {
  const latest = useRef(refetch);
  latest.current = refetch;
  useEffect(() => {
    if (runKey === null) return;
    return subscribeRunLedgerFrames(runKey, () => void latest.current());
  }, [runKey]);
}

export function useRunLedger(
  runId: string | null,
  facts: ServerRunFacts | null,
  includeCounts = false
): RunLedgerView {
  const { workspaceId } = useSession();
  // 서버가 모르는 run(관리형·BYOA·옛 서버)의 원장은 비어 있다. 물어볼 이유가 없다.
  const enabled = runId !== null && facts !== null;
  const open = facts !== null && isOpenRunPhase(facts.phase);
  const key = runId?.toLowerCase() ?? null;
  const query = useQuery({
    ...runLedgerQueryOptions(workspaceId, key),
    enabled,
    refetchInterval: open ? RUN_LEDGER_POLL_MS : false,
  });
  useRunLedgerFrames(enabled ? key : null, query.refetch);

  const fingerprint = fingerprintOf(facts);
  const seen = useRef<string>(fingerprint);
  useEffect(() => {
    if (seen.current === fingerprint) return;
    seen.current = fingerprint;
    if (enabled) void query.refetch();
    // `query.refetch`는 매 렌더 새 함수일 수 있어 의존성에서 뺀다. 지문만이 신호다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, enabled]);

  const rows = useMemo(
    () => (query.data === undefined ? [] : ledgerRows(query.data.events)),
    [query.data]
  );
  const doorbell = useMemo(() => doorbellFactOf(query.data?.events), [query.data]);
  const tools = useMemo(
    () => (query.data === undefined ? null : workToolRecord(query.data)),
    [query.data]
  );
  const events = query.data?.events ?? [];
  return {
    rows, doorbell, tools,
    ...(includeCounts && query.data !== undefined ? { counts: {
      // 여기의 「도구 N」은 에이전트가 한 일의 수다. oort가 직접 잰 호출(`tools`, 대개 job_start·
      // run_event·run_complete 같은 보고 호출)은 출처가 달라 이 요약에 섞지 않는다(#4654 「출처를
      // 한 칸에 섞지 않는다」). 에이전트 자기 보고 개수는 #4657이 「에이전트 보고」로 더한다.
      // 모르는 값을 0회로 말하지 않는 것은 그대로다.
      ...(events.some((event) => event.rawKind === "agent_port.call") ? {
        tools: events.filter((event) => event.rawKind === "agent_port.call").length,
      } : {}),
      approvals: events.filter((event) => event.kind === "approval_requested").length,
    } } : {}),
    isLoading: enabled && query.isLoading, isError: query.isError,
  };
}

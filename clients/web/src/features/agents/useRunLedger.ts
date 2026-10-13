import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAgentRunEvents } from "@momo/core/lib/api";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import { isOpenRunPhase } from "@momo/core/features/agents/runPhase";
import {
  ledgerRows,
  type RunLedgerRow,
} from "@momo/core/features/agents/runLedger";
import type { ServerRunFacts } from "@momo/core/features/agents/workingSignal";
import { useSession } from "@/app/session";

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

export function useRunLedger(
  runId: string | null,
  facts: ServerRunFacts | null
): RunLedgerView {
  const { workspaceId } = useSession();
  // 서버가 모르는 run(관리형·BYOA·옛 서버)의 원장은 비어 있다. 물어볼 이유가 없다.
  const enabled = runId !== null && facts !== null;
  const open = facts !== null && isOpenRunPhase(facts.phase);
  const key = runId?.toLowerCase() ?? null;
  const query = useQuery({
    queryKey: ["agent-run-events", workspaceId, key],
    queryFn: () => fetchAgentRunEvents(workspaceId, key as string),
    enabled,
    staleTime: 0,
    retry: (count, error) => !serverSaysAbsent(error) && count < 1,
    refetchInterval: open ? RUN_LEDGER_POLL_MS : false,
  });

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
  return { rows, isLoading: enabled && query.isLoading, isError: query.isError };
}

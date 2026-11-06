import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAgentRunEvents, type AgentRunLedgerEvent } from "@momo/core/lib/api";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import { isOpenRunPhase, isRunningPhase } from "@momo/core/features/agents/runPhase";
import {
  ledgerRows,
  type RunLedgerRow,
} from "@momo/core/features/agents/runLedger";
import {
  workToolRecord,
  type WorkToolRecord,
} from "@momo/core/features/agents/workTimeline";
import {
  runReportSummary,
  workActivityRecord,
  type RunReportSummary,
  type WorkActivityRecord,
} from "@momo/core/features/agents/workReport";
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
  /** 서버가 준 원장 행 그대로(건강 신호가 시각·종류를 직접 읽는다). 아직 못 읽었으면 빈 배열. */
  events: readonly AgentRunLedgerEvent[];
  /** 원장의 깨우는 신호(행이 없거나 아직 못 읽었으면 null). */
  doorbell: DoorbellFact | null;
  /**
   * 「oort 기록」 칸의 재료(oort가 직접 잰 도구 호출, #4654). 아직 읽은 원장이 없으면 null.
   * `supported`가 false면 이 서버는 `include=tools`를 모른다: 호출이 없다는 뜻이 아니다.
   */
  tools: WorkToolRecord | null;
  /**
   * 「에이전트 보고」 칸의 재료(에이전트가 스스로 알린 활동·계획, #4657). 아직 읽은 원장이 없으면 null.
   * `supported`가 false면 이 서버는 `include=activity`를 모른다: 보고가 없다는 뜻이 아니다.
   */
  activity: WorkActivityRecord | null;
  /**
   * 끝난 요청의 한 줄 요약 재료(「13분 · 단계 6 · 명령 12 · 에이전트 보고」). **에이전트가 말한 것만** 센다:
   * oort가 잰 도구 호출은 출처가 달라 섞지 않는다(#4654). 아직 읽은 원장이 없으면 null.
   */
  report: RunReportSummary | null;
  isLoading: boolean;
  /** 읽지 못했다(네트워크·5xx). 직전에 읽은 줄이 있으면 그대로 남는다. */
  isError: boolean;
  /** 그 읽기가 던진 오류 객체(#5279 B): 기록 줄이 실패의 원인(오프라인 / 서버에 닿지 못함 / 그 밖)을 말하는 데 쓴다. 실패가 아니면 `null`. */
  error?: unknown;
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
 * 깨우는 신호 행(`doorbell`, #3824)과 oort가 잰 도구 호출(`tools`, #4654), 에이전트가 알린 활동·계획
 * (`activity`, #4657)을 함께 달라고 묻는다. 그 값을 모르는 옛 서버는 쿼리를 읽지 않고 예전 원장을 주거나,
 * 400이면 가장 새 값부터 한 칸씩 물러서 다시 읽는다(`fetchAgentRunEvents`). 두 표면이 같은 캐시를 쓰므로
 * 묻는 값도 같다.
 */
export function runLedgerQueryOptions(workspaceId: string, runKey: string | null) {
  return {
    queryKey: ["agent-run-events", workspaceId, runKey] as const,
    queryFn: () =>
      fetchAgentRunEvents(workspaceId, runKey as string, {
        includeDoorbell: true,
        includeTools: true,
        includeActivity: true,
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
  facts: ServerRunFacts | null
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
  // 「에이전트 보고」 칸은 run이 열려 있는지(진행 중 활동을 진행 중으로 그려도 되는가)와 서버가 `running`이라
  // 말하는지(계획의 「지금 단계」를 세워도 되는가)에 따라 다르게 읽는다. 둘 다 서버의 사실이다.
  const working = facts !== null && isRunningPhase(facts.phase);
  const activity = useMemo(
    () => (query.data === undefined ? null : workActivityRecord(query.data, { open, working })),
    [query.data, open, working]
  );
  // 요약의 숫자는 에이전트가 말한 것만이다(단계·활동 합계). oort가 잰 호출 수는 출처가 달라 섞지 않는다(#4654).
  // 모르는 값(`activityTally` 부재)을 0이라고 말하지 않는 것은 코어가 지킨다.
  const report = useMemo(
    () => (query.data === undefined ? null : runReportSummary(query.data)),
    [query.data]
  );
  return {
    rows, events: query.data?.events ?? [], doorbell, tools, activity, report,
    isLoading: enabled && query.isLoading, isError: query.isError, error: query.error ?? null,
  };
}

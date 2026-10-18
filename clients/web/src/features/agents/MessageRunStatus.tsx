import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentRunProgress } from "@momo/core/lib/api";
import {
  doorbellFactOf,
  keepsRunReceipt,
  runStatusLine,
  runStatusText,
  wantsDoorbellFact,
} from "@momo/core/features/agents/runStatusLine";
import { isOpenRunPhase } from "@momo/core/features/agents/runPhase";
import { agentLabel, UNKNOWN_AGENT_NAME } from "@momo/core/features/agents/turnCopy";
import { useSession } from "@/app/session";
import { memberNameParts, type Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { useTickingNow } from "./agentWorkingSignal";
import { nudgeRunProgress } from "./agentRunProgressStore";
import { runLedgerQueryOptions, useRunLedgerFrames } from "./useRunLedger";
import { openWorkPanel } from "./workLogStore";

// =============================================================================
// 보낸 메시지 아래 상태 한 줄 (#3824).
//
//   그록봇 · 받았어요 → 깨우는 신호 보냄 → 가져감 → 작업 중 · 12분째 · 마지막 보고 1분 전
//
// 말은 core `runStatusLine`이 정하고, 여기는 그것을 메시지 행 아래에 그리는 일뿐이다.
// run 목록은 타임라인이 한 번 모아 행에 넘긴다(행이 스토어를 구독하지 않는다).
//
// #4020: 평소의 영수증(받았어요 → 가져감 → 완료)은 대화 타임라인 본 줄에서 뺐다. 진행은
// 컴포저 위 「답하는 중」이 말한다. 이 줄은 **사람이 알아야 하는 상태**(실패·시간 초과·
// 승인 대기·소식 끊김·깨우는 신호 불발)에만 선다 — 판정은 core `keepsRunReceipt`.
//
// 원장(깨우는 신호)은 아직 시작 전인 run에만 읽는다. 작업 패널과 같은 캐시 키라서 두
// 표면이 같은 순간에 다른 단계를 말하지 않는다. 진행 읽기를 싣지 않는 옛 서버에서는
// 타임라인이 넘길 run이 없으므로 이 줄은 그려지지 않는다 — 예전 화면 그대로다.
// =============================================================================

/** 내가 방금 보낸 메시지로 보는 시간. 이 안이면 진행을 한 번 당겨 읽는다. */
const FRESH_SEND_MS = 15_000;

export function MessageRunStatus({
  messageId,
  channelId,
  createdAtMs,
  runs,
  directory,
}: {
  messageId: string;
  channelId: string;
  createdAtMs: number;
  /** 이 메시지가 일으킨 run들(먼저 생긴 것이 위). 없으면 빈 배열. */
  runs: readonly AgentRunProgress[];
  directory: Directory;
}) {
  // 방금 보낸 메시지인데 아직 run이 없으면 진행을 한 번 당겨 읽는다. 프레임이 늦어도
  // 1초 안에 「받았어요」가 서게 하려는 것이다. 에이전트를 부르지 않은 메시지면 그 채널
  // 읽기가 빈 답을 줄 뿐이다.
  const fresh = Date.now() - createdAtMs < FRESH_SEND_MS;
  const empty = runs.length === 0;
  useEffect(() => {
    if (!fresh || !empty) return;
    nudgeRunProgress(channelId);
    // 메시지 id가 바뀌지 않는 한 한 번이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  if (runs.length === 0) return null;
  // 래퍼 없이 행만 낸다: 행이 모두 빠지면 DOM에 아무것도 남지 않아 자리(여백)도 없다.
  return (
    <>
      {runs.map((progress) => (
        <RunStatusRow
          key={progress.id}
          progress={progress}
          directory={directory}
          showName={true}
        />
      ))}
    </>
  );
}

function RunStatusRow({
  progress,
  directory,
  showName,
}: {
  progress: AgentRunProgress;
  directory: Directory;
  showName: boolean;
}) {
  const { workspaceId } = useSession();
  const key = progress.id.toLowerCase();
  const wants = wantsDoorbellFact(progress);
  // 시작 전이면 읽고, 시작 뒤에는 이미 읽은 캐시만 본다(`enabled: false`도 캐시는 준다).
  const ledger = useQuery({ ...runLedgerQueryOptions(workspaceId, key), enabled: wants });
  useRunLedgerFrames(wants ? key : null, ledger.refetch);
  const doorbell = useMemo(() => doorbellFactOf(ledger.data?.events), [ledger.data]);
  // 줄을 남기지 않는 run은 시계도 돌리지 않는다(행마다 1초 재렌더를 만들 이유가 없다).
  const keeps = keepsRunReceipt(progress, doorbell);
  const nowMs = useTickingNow(keeps && isOpenRunPhase(progress.phase));
  if (!keeps) return null;
  const line = runStatusLine(progress, doorbell, nowMs);
  const name = agentLabel(memberNameParts(directory, progress.agentMemberId, UNKNOWN_AGENT_NAME));
  const text = runStatusText(line);
  const chain = line.steps.map((step) => step.text).join(" → ");

  return (
    <button
      type="button"
      onClick={(event) =>
        openWorkPanel(
          {
            runId: progress.id,
            memberId: progress.agentMemberId,
            channelId: progress.channelId,
            origin: "message",
          },
          event.currentTarget
        )
      }
      // 이름을 명시한다: 자식에 맡기면 초마다 바뀌는 「n초째」가 접근성 이름에 들어간다.
      aria-label={`${name}: ${chain}. 진행 과정 열기`}
      title={text}
      data-testid="message-run-status-row"
      data-run-id={progress.id}
      data-phase={progress.phase}
      className="mt-1 flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 self-start rounded-sm text-left text-timestamp text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
    >
      {showName && <span className="shrink-0 text-agent">{name}</span>}
      <span
        className={cn("min-w-0 break-keep", line.needsHuman && "text-warn")}
        data-testid="message-run-status-steps"
      >
        {line.steps.map((step, index) => (
          <span key={step.key} data-step={step.key}>
            {index > 0 && <span aria-hidden="true"> → </span>}
            <span
              className={cn(
                index === line.steps.length - 1 && "font-medium text-ink",
                index === line.steps.length - 1 && line.needsHuman && "text-warn"
              )}
            >
              {step.text}
            </span>
          </span>
        ))}
      </span>
      {line.detail !== undefined && (
        <span className="min-w-0 break-keep" data-numeric data-testid="message-run-status-detail">
          {line.detail}
        </span>
      )}
    </button>
  );
}

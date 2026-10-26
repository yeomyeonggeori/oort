import { useContext, useEffect } from "react";
import { CircleAlert } from "lucide-react";
import type { AgentLiveness, AgentRunProgress } from "@momo/core/lib/api";
import {
  isUncollectedPastGrace,
  nextUncollectedDeadlineMs,
  runException,
  runExceptionText,
  type RunException,
} from "@momo/core/features/agents/runException";
import { serverFactsOf } from "@momo/core/features/agents/runPhase";
import { cancelWordingFor } from "@momo/core/features/agents/runCancel";
import { agentLabel, UNKNOWN_AGENT_NAME } from "@momo/core/features/agents/turnCopy";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { memberNameParts, type Directory } from "@/features/workspace/useWorkspace";
import { nudgeRunProgress } from "./agentRunProgressStore";
import { StopRunControl } from "./StopRunControl";
import { useAgentLivenessLookup } from "./useAgentLiveness";
import { useRerenderAt } from "./useRerenderAt";
import { WakeAgentButton } from "./WakeAgentButton";
import { openWorkPanel } from "./workLogStore";

// =============================================================================
// 보낸 메시지 아래 **예외 줄** (#4619 D, #4577 권장 D).
//
//   ! grok: 아직 받지 않았어요 · 다음 확인 때 가져가요(보통 15분 안)     [다시 깨우기] [취소]
//   ! grok: 실패 · 에이전트가 오류로 끝냈어요
//
// 평소의 진행(받았어요 → 깨우는 신호 보냄 → 가져감 → 작업 중 → 결과)은 이 자리에서 **없어졌다**.
// 실시간 상태는 입력창 레일(`ActivityRail`)이, 내가 부른 일이 어디까지 갔나는 메시지 머리의 칩
// (`TriggerChip`)이 말한다. 계속 떠 있는 문장 행이 대화를 어수선하게 한다는 owner의 판단(2026-10-26
// 「grok: 아직 받지 않았어요 · 깨웠지만 아직 안 가져감 · 15분째 기다려요 · 연결이 꺼져 있을 수
// 있어요」 캡처)이 이 변경의 이유다.
//
// 이 줄은 **사람이 움직여야 할 수 있는 상태**에만 선다: 못 가져감(유예 뒤), 실패, 시간 초과. 판정과
// 낱말은 코어 `runException`이 정하고 폰이 같은 모델을 쓴다. 줄은 서고 나면 가만히 있다(경과를 말하지
// 않으므로 시계가 없다): 「받음」이 「못 가져감」으로 넘어가는 유예 마감에 **한 번만** 다시 그린다.
//
// 행동은 기존 것을 그대로 쓴다. 새 길을 만들지 않았다:
//   다시 깨우기       `WakeAgentButton`(owner/admin, 켜진 연결일 때만 스스로 선다)
//   취소              `StopRunControl`(`cancelAgentRun`, 한 겹의 확인) — 줄 안에 서는 `inline` 판
//   에이전트 설정 열기 `OpenAgentProfileContext`(디렉터리·컴포저가 여는 같은 다이얼로그)
// 줄의 글은 그 run의 작업 패널(진행 과정)을 여는 입구다. 되지 않는 행동은 죽은 버튼으로 세우지 않는다.
//
// 루틴형 에이전트의 「다음 확인 때 가져가요(보통 N분 안)」는 서버가 확인 박자를 내려주는 날(#4621)
// 이 줄의 이유 자리에 선다. 그 값이 없는 동안 이 줄은 서버 생존 판정의 「연결이 꺼져 있을 수
// 있어요」를 근거가 있을 때만 말한다.
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
  // 방금 보낸 메시지인데 아직 run이 없으면 진행을 한 번 당겨 읽는다. 프레임이 늦어도 1초 안에
  // 칩(「받음」)이 서게 하려는 것이다. 에이전트를 부르지 않은 메시지면 그 채널 읽기가 빈 답을 줄 뿐이다.
  const fresh = Date.now() - createdAtMs < FRESH_SEND_MS;
  const empty = runs.length === 0;
  useEffect(() => {
    if (!fresh || !empty) return;
    nudgeRunProgress(channelId);
    // 메시지 id가 바뀌지 않는 한 한 번이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  // 유예 마감에 한 번 다시 그린다.
  const nowMs = useRerenderAt(nextUncollectedDeadlineMs(runs, Date.now()));
  // 서버의 생존 판정은 **유예를 넘은** 대기 run의 에이전트만 읽는다: 줄이 서기 전에는 쓸 데가 없다.
  const stuck = runs
    .filter((run) => isUncollectedPastGrace(serverFactsOf(run), nowMs))
    .map((run) => run.agentMemberId);
  const livenessFor = useAgentLivenessLookup(stuck);

  const lines: { run: AgentRunProgress; exception: RunException; liveness: AgentLiveness | null | undefined }[] = [];
  for (const run of runs) {
    const liveness = livenessFor(run.agentMemberId);
    const exception = runException(run, nowMs, { liveness });
    if (exception !== null) lines.push({ run, exception, liveness });
  }
  // 래퍼 없이 줄만 낸다: 줄이 모두 빠지면 DOM에 아무것도 남지 않아 자리(여백)도 없다.
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map(({ run, exception, liveness }) => (
        <ExceptionLine
          key={run.id}
          run={run}
          exception={exception}
          liveness={liveness}
          directory={directory}
        />
      ))}
    </>
  );
}

function ExceptionLine({
  run,
  exception,
  liveness,
  directory,
}: {
  run: AgentRunProgress;
  exception: RunException;
  liveness: AgentLiveness | null | undefined;
  directory: Directory;
}) {
  const { connStatus } = useSession();
  const openAgentProfile = useContext(OpenAgentProfileContext);
  const name = agentLabel(memberNameParts(directory, run.agentMemberId, UNKNOWN_AGENT_NAME));
  const text = runExceptionText(name, exception);
  // 사람 몫의 색은 하나다(`--warn`): 못 가져감·시간 초과는 신호 없음이지 오류가 아니다(ADR-0132: 부재를
  // 오류로 올리지 않는다). 서버가 실패로 끝낸 것만 `--danger`다.
  const iconTone = exception.kind === "failed" ? "text-danger" : "text-warn";
  const wants = (action: RunException["actions"][number]) => exception.actions.includes(action);

  return (
    <div
      className="mt-1 flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 self-start text-meta text-ink-muted"
      data-testid="run-exception"
      data-kind={exception.kind}
      data-run-id={run.id}
    >
      <button
        type="button"
        onClick={(event) =>
          openWorkPanel(
            {
              runId: run.id,
              memberId: run.agentMemberId,
              channelId: run.channelId,
              origin: "message",
            },
            event.currentTarget
          )
        }
        aria-label={`${text}. 진행 과정 열기`}
        title={text}
        data-testid="run-exception-open"
        className="flex min-w-0 items-center gap-1 rounded-sm text-left press hover:bg-surface-hover focus-visible:focus-ring"
      >
        <CircleAlert aria-hidden="true" className={cn("size-4 shrink-0", iconTone)} />
        <span className="min-w-0 break-keep" data-testid="run-exception-text">
          <span className="text-agent">{name}</span>
          {text.slice(name.length)}
        </span>
      </button>
      {wants("wake") && liveness !== null && liveness !== undefined && (
        <WakeAgentButton agentId={run.agentMemberId} state={liveness.state} />
      )}
      {wants("cancel") && (
        <StopRunControl
          runId={run.id}
          agentName={name}
          open={exception.open}
          live={connStatus === "connected"}
          wording={cancelWordingFor(serverFactsOf(run))}
          variant="inline"
        />
      )}
      {wants("settings") && openAgentProfile !== null && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="run-exception-settings"
          onClick={() => openAgentProfile(run.agentMemberId)}
        >
          에이전트 설정 열기
        </Button>
      )}
    </div>
  );
}

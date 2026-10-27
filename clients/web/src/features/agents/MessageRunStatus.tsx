import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleX } from "lucide-react";
import { uuidEq, type AgentLiveness, type AgentRunProgress } from "@momo/core/lib/api";
import {
  nextUncollectedDeadlineMs,
  runException,
  runExceptionText,
  type RunException,
} from "@momo/core/features/agents/runException";
import { isUncollected } from "@momo/core/features/agents/runWaiting";
import { serverFactsOf } from "@momo/core/features/agents/runPhase";
import { doorbellFactOf } from "@momo/core/features/agents/runStatusLine";
import { cancelWordingFor } from "@momo/core/features/agents/runCancel";
import { agentLabel, UNKNOWN_AGENT_NAME } from "@momo/core/features/agents/turnCopy";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { memberFor, memberNameParts, type Directory } from "@/features/workspace/useWorkspace";
import { nudgeRunProgress } from "./agentRunProgressStore";
import { StopRunControl } from "./StopRunControl";
import { useAgentLiveness } from "./useAgentLiveness";
import { useRerenderAt } from "./useRerenderAt";
import { runLedgerQueryOptions, useRunLedgerFrames } from "./useRunLedger";
import { WakeAgentButton } from "./WakeAgentButton";
import { openWorkPanel } from "./workLogStore";

// =============================================================================
// 에이전트를 부른 메시지 아래 **예외 줄** (#4619 D, #4577 권장 D).
//
//   ! grok: 아직 받지 않았어요 · 다음 확인 때 가져가요(보통 15분 안)     [다시 깨우기] [취소]
//   ! grok: 깨우는 신호가 닿지 않음                                      [다시 깨우기] [취소]
//   ! grok: 실패 · 에이전트가 오류로 끝냈어요
//
// 평소의 진행(받았어요 → 깨우는 신호 보냄 → 가져감 → 작업 중 → 결과)은 이 자리에서 **없어졌다**.
// 실시간 상태는 입력창 레일(`ActivityRail`)이, 부른 일이 어디까지 갔나는 메시지 머리의 칩
// (`TriggerChip`)이 말한다. 계속 떠 있는 문장 행이 대화를 어수선하게 한다는 owner의 판단(2026-10-26
// 「grok: 아직 받지 않았어요 · 깨웠지만 아직 안 가져감 · 15분째 기다려요 · 연결이 꺼져 있을 수
// 있어요」 캡처)이 이 변경의 이유다. 이 줄은 **누가 부른 요청이든** 선다(planner 결정 2): 칩이 남의
// 메시지에도 서는데 칩의 「실패」·「아직 받지 않았어요」를 풀어 줄 줄이 내 메시지에만 있으면 안 된다.
//
// **문장은 모두에게, 행동 단추는 요청자와 워크스페이스 owner/admin에게만** 선다(design-review r1 M2). 서버는 그 채널의
// 멤버 누구든 취소를 받지만 그것은 바닥이지 천장이 아니다: 남이 부른 요청마다 멤버 수만큼의 화면에 같은 단추 셋이 서면
// 어수선하고, 확인 문장(「취소하면 이 요청은 여기서 끝나요」)은 요청자에게 하는 말이다. 구경꾼도 줄의 글을 눌러 작업 패널
// (거기에는 채널 멤버 누구에게나 취소가 있다)로 갈 수 있다. 정책이므로 owner가 바꿀 수 있는 한 곳(`mayAct`)이다.
//
// 취소를 확정하면 run이 취소로 넘어가 줄은 사라지지만 **취소 영수증은 남는다**: 줄과 함께 결과 문장(`role="status"`)과 캐럿이
// 사라지면 키보드·보조기술 사용자가 확인을 받지 못한다(design-review r1 M9, #3854 H-1과 같은 종류).
//
// 이 줄은 **사람이 움직여야 할 수 있는 상태**에만 선다: 아직 받지 않았어요(유예 뒤), 깨우는 신호가 닿지
// 않음, 실패, 시간 초과. 판정과 낱말은 코어 `runException`이 정하고 폰이 같은 모델을 쓴다. 줄은 서고 나면
// 가만히 있다(경과를 말하지 않으므로 시계가 없다): 「받음」이 「아직 받지 않았어요」로 넘어가는 유예 마감에
// **한 번만** 다시 그린다.
//
// 행동은 기존 것을 그대로 쓴다. 새 길을 만들지 않았다:
//   다시 깨우기       `WakeAgentButton`(owner/admin, 켜진 연결일 때만 스스로 선다)
//   취소              `StopRunControl`(`cancelAgentRun`, 한 겹의 확인) — 줄 안에 서는 `inline` 판.
//                     서버는 이 run이 있는 채널의 멤버면 누구든 취소를 받는다
//   에이전트 설정 열기 `OpenAgentProfileContext`(디렉터리·컴포저가 여는 같은 다이얼로그)
// 줄의 글은 그 run의 작업 패널(진행 과정)을 여는 입구다. 되지 않는 행동은 죽은 버튼으로 세우지 않는다.
//
// 깨우는 신호의 사실은 원장(`?include=doorbell`)에서 읽는다 — 아직 아무도 가져가지 않은 요청에만. 작업
// 패널과 **같은 캐시 키**라서 두 표면이 같은 순간에 다른 말을 하지 않는다.
//
// 루틴형 에이전트의 「다음 확인 때 가져가요(보통 N분 안)」는 서버가 확인 박자를 내려주는 날(#4621)
// 이 줄의 이유 자리에 선다. 그 값이 없는 동안 이 줄은 서버 생존 판정의 「연결이 꺼져 있을 수
// 있어요」를 근거가 있을 때만 말한다.
// =============================================================================

/** 내가 방금 보낸 메시지로 보는 시간. 이 안이면 진행을 한 번 당겨 읽는다. */
const FRESH_SEND_MS = 15_000;

/**
 * 줄을 세울 수 있는 run인가(그 밖의 phase는 훅도 읽기도 없이 건너뛴다). `cancelled`는 줄을 세우지 않지만 **줄이 영수증으로
 * 남으려면** 대기에서 취소로 넘어가는 동안 같은 행이 마운트된 채여야 해서 포함한다(예외가 없으면 아무것도 그리지 않는다).
 */
function mayHaveException(run: AgentRunProgress): boolean {
  return (
    run.phase === "queued" ||
    run.phase === "failed" ||
    run.phase === "timed_out" ||
    run.phase === "cancelled"
  );
}

export function MessageRunStatus({
  messageId,
  channelId,
  createdAtMs,
  requesterId,
  runs,
  directory,
}: {
  messageId: string;
  channelId: string;
  createdAtMs: number;
  /** 이 메시지를 쓴(에이전트를 부른) 멤버. 행동 단추는 이 사람과 owner/admin에게만 선다. 모르면 owner/admin에게만. */
  requesterId?: string;
  /** 이 메시지가 일으킨 run들(먼저 생긴 것이 위). 없으면 빈 배열. */
  runs: readonly AgentRunProgress[];
  directory: Directory;
}) {
  // 방금 보낸 메시지인데 아직 run이 없으면 진행을 한 번 당겨 읽는다. 프레임이 늦어도 1초 안에
  // 칩(「받음」)이 서게 하려는 것이다. 에이전트를 부르지 않은 메시지면 그 채널 읽기가 빈 답을 줄 뿐이다.
  // (타임라인은 이 슬롯을 **내가 보낸** 메시지에만 빈 채로 세운다: 남의 새 메시지마다 읽기가 돌지 않는다.)
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
  // 래퍼 없이 줄만 낸다: 줄이 모두 빠지면 DOM에 아무것도 남지 않아 자리(여백)도 없다.
  return (
    <>
      {runs.filter(mayHaveException).map((run) => (
        <RunExceptionRow
          key={run.id}
          run={run}
          nowMs={nowMs}
          directory={directory}
          {...(requesterId !== undefined ? { requesterId } : {})}
        />
      ))}
    </>
  );
}

/**
 * run 하나의 줄. 훅(원장·생존 판정)이 run마다 있어야 해서 행으로 나눴다. 예외가 없으면 아무것도 그리지 않는다.
 */
function RunExceptionRow({
  run,
  nowMs,
  directory,
  requesterId,
}: {
  run: AgentRunProgress;
  nowMs: number;
  directory: Directory;
  requesterId?: string;
}) {
  const { workspaceId, session } = useSession();
  // 행동 단추를 낼 수 있는 사람: 요청자 본인, 또는 워크스페이스 owner/admin.
  const me = session?.member?.id;
  const role = me === undefined ? undefined : memberFor(directory, me)?.role;
  const mayAct =
    (requesterId !== undefined && me !== undefined && uuidEq(requesterId, me)) ||
    role === "owner" ||
    role === "admin";
  // 취소를 확정한 줄: run이 취소로 넘어가 예외가 없어져도 영수증은 남긴다.
  const last = useRef<RunException | null>(null);
  const [settled, setSettled] = useState(false);
  const queued = run.phase === "queued";
  const key = run.id.toLowerCase();
  // 깨우는 신호는 아직 아무도 가져가지 않은 요청에만 읽는다. 작업 패널과 같은 캐시 키다.
  const ledger = useQuery({ ...runLedgerQueryOptions(workspaceId, key), enabled: queued });
  useRunLedgerFrames(queued ? key : null, ledger.refetch);
  const doorbell = useMemo(() => doorbellFactOf(ledger.data?.events), [ledger.data]);
  // 서버의 생존 판정은 줄이 설 수 있는 요청의 에이전트만 읽는다: 줄이 서기 전에는 쓸 데가 없다.
  const candidate = queued && (isUncollected(serverFactsOf(run), nowMs) || doorbell?.failed === true);
  const { liveness } = useAgentLiveness(candidate ? run.agentMemberId : null, candidate);
  const exception = runException(run, nowMs, { liveness, doorbell });
  if (exception !== null) last.current = exception;
  const shown = exception ?? (settled ? last.current : null);
  if (shown === null) return null;
  return (
    <ExceptionLine
      run={run}
      exception={shown}
      liveness={liveness}
      directory={directory}
      mayAct={mayAct}
      receipt={exception === null}
      onSettled={() => setSettled(true)}
    />
  );
}

function ExceptionLine({
  run,
  exception,
  liveness,
  directory,
  mayAct,
  receipt,
  onSettled,
}: {
  run: AgentRunProgress;
  exception: RunException;
  liveness: AgentLiveness | null | undefined;
  directory: Directory;
  /** 행동 단추(다시 깨우기·취소·설정)를 낼 수 있는가: 요청자와 owner/admin. */
  mayAct: boolean;
  /** 예외는 이미 걷혔고(run이 취소로 넘어갔다) 취소 영수증만 남아 있다. */
  receipt: boolean;
  onSettled: () => void;
}) {
  const { connStatus } = useSession();
  const openAgentProfile = useContext(OpenAgentProfileContext);
  const name = agentLabel(memberNameParts(directory, run.agentMemberId, UNKNOWN_AGENT_NAME));
  const text = runExceptionText(name, exception);
  // 사람 몫의 색은 하나다(`--warn`): 아직 받지 않았어요·깨우는 신호가 닿지 않음·시간 초과는 신호 없음이지
  // 오류가 아니다(ADR-0132: 부재를 오류로 올리지 않는다). 서버가 실패로 끝낸 것만 `--danger`다.
  const iconTone = exception.kind === "failed" ? "text-danger" : "text-warn";
  // 모양도 같은 이유로 갈린다: 칩의 실패는 가위표라 줄도 같은 가위표다(주의 느낌표와 색으로만 갈리지 않는다, design-review r1 M7).
  const Icon = exception.kind === "failed" ? CircleX : CircleAlert;
  const wants = (action: RunException["actions"][number]) =>
    mayAct && !receipt && exception.actions.includes(action);

  return (
    <div
      className="mt-1 flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 self-start text-meta text-ink-muted"
      data-testid="run-exception"
      data-kind={exception.kind}
      data-run-id={run.id}
      data-receipt={receipt ? "" : undefined}
    >
      {!receipt && (
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
        <Icon aria-hidden="true" className={cn("size-4 shrink-0", iconTone)} />
        <span className="min-w-0 break-keep" data-testid="run-exception-text">
          <span className="text-agent">{name}</span>
          {text.slice(name.length)}
        </span>
      </button>
      )}
      {wants("wake") && liveness !== null && liveness !== undefined && (
        <WakeAgentButton agentId={run.agentMemberId} state={liveness.state} />
      )}
      {wants("settings") && openAgentProfile !== null && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="tap-target"
          data-testid="run-exception-settings"
          onClick={() => openAgentProfile(run.agentMemberId)}
        >
          에이전트 설정 열기
        </Button>
      )}
      {/* 취소는 맨 뒤다(위험한 행동은 마지막): 확인 줄이 열려 자기 줄로 내려가도 다른 행동이 그 아래 혼자 남지 않는다.
          영수증 모드에서는 이 단추만 남는다: 결과 문장과 캐럿이 줄과 함께 사라지지 않게 같은 자리에 마운트된 채 둔다. */}
      {(wants("cancel") || receipt) && (
        <StopRunControl
          runId={run.id}
          agentName={name}
          open={exception.open && !receipt}
          live={connStatus === "connected"}
          wording={cancelWordingFor(serverFactsOf(run))}
          variant="inline"
          onSettled={onSettled}
        />
      )}
    </div>
  );
}

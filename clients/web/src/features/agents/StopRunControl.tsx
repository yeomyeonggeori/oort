import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cancelAgentRun } from "@momo/core/lib/api";
import {
  CANCEL_ACTION_LABEL,
  CANCEL_BUSY_LABEL,
  CANCEL_COMMIT_LABEL,
  CANCEL_CONFIRM_SENTENCE,
  cancelFailureOutcome,
  cancelSucceeded,
  type CancelOutcome,
} from "@momo/core/features/agents/runCancel";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 작업 패널의 「중단」 (#3852, ADR-0132 D1 사람의 중단 권리).
//
// 부르는 길은 `POST …/agent-runs/{run}/cancel` 하나다. 작업 세션의 `kill`은 다른
// 일(호스트의 프로세스를 끝낸다)이고 이 버튼이 그 길을 타면 안 된다 — 이 run이
// 건드린 세션은 계속 돌고, 응답이 그 사실을 두 칸으로 말한다(영수증이 그대로 옮긴다).
//
// 판단은 여기 없다. 무엇을 보내고, 409를 어떻게 읽고, 실패를 무슨 문장으로 말할지는
// core `runCancel`이 갖고 폰 `StopTurnControl`도 같은 것을 쓴다.
//
// ## 확인은 한 겹이다
//
// 승인/거부의 「한 번 누르면 결정」(#3819)은 이 버튼에 오지 않는다. 승인은 누르기 전에
// 카드가 영향을 보여 주지만, 중단은 하던 일을 그 자리에서 끊는다. 그래서 첫 클릭은
// 묻고(이름이 「확인 필요」를 말한다), 두 번째가 보낸다. 자리에서 묻는 것은
// `WorkSessionDetail`의 세션 종료와 같은 문법이다.
//
// ## 언제 서는가
//
// 서버가 열린 run이라고 말할 때(`open`)와 실시간 연결이 살아 있을 때(`live`)만이다.
// 끊긴 화면에서 중단을 권하면 무엇을 멈추는지 모르는 채 누르게 된다(폰과 같은 규칙).
// 끝난 run에는 버튼이 없고, 방금 이 버튼이 낸 문장만 남는다.
// =============================================================================

/** 화면을 보지 않는 사람에게 첫 클릭이 묻기만 한다는 것을 말하는 이름. 보이는 낱말을 품는다. */
export const STOP_ARM_NAME = `실행 ${CANCEL_ACTION_LABEL}, 확인 필요`;

export function StopRunControl({
  runId,
  agentName,
  open,
  live,
}: {
  runId: string;
  /** 영수증이 부를 이름. 여러 에이전트의 일 옆에 서므로 누구의 실행인지 말한다. */
  agentName: string;
  /** 서버가 이 run을 아직 열린 phase로 말하는가. */
  open: boolean;
  /** 실시간 연결이 살아 있는가. */
  live: boolean;
}) {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CancelOutcome | null>(null);
  /** 같은 틱의 두 번째 클릭을 거르는 동기 문. state는 다음 렌더에야 바뀐다. */
  const sending = useRef(false);
  const armRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  /** 접은 뒤 캐럿을 돌려줄 곳이 무장 버튼인가. 처음 그릴 때는 옮기지 않는다. */
  const returnFocus = useRef(false);

  // 첫 클릭이 버튼을 확인 줄로 바꾼다. 누른 버튼이 사라지면 캐럿이 <body>로 떨어지므로
  // 안전한 쪽(그대로 두기)에 놓는다. 접히면 무장 버튼으로 돌려준다.
  useEffect(() => {
    if (armed) {
      keepRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      armRef.current?.focus();
    }
  }, [armed]);

  const dismiss = useCallback(() => {
    returnFocus.current = true;
    setArmed(false);
  }, []);

  const commit = useCallback(async () => {
    if (!armed || sending.current) return;
    sending.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await cancelAgentRun(workspaceId, runId);
      setArmed(false);
      setOutcome(cancelSucceeded(result, agentName));
      // 원장의 「취소됐어요」 줄을 바로 읽는다. 진행 칩은 서버의 run 프레임이 따라온다.
      void client.invalidateQueries({
        queryKey: ["agent-run-events", workspaceId, runId.toLowerCase()],
      });
    } catch (error) {
      const next = cancelFailureOutcome(error);
      // 이미 끝난 실행에는 더 물을 것이 없다. 확인 줄을 접는다.
      if (next.kind === "alreadyOver") setArmed(false);
      setOutcome(next);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }, [agentName, armed, client, runId, workspaceId]);

  // 이 버튼이 이미 답을 받았으면(중단됨·이미 끝남) 서버 칩이 따라오기 전이라도 다시
  // 권하지 않는다. 실패(`error`)만 다시 누를 수 있다.
  const settled = outcome !== null && outcome.kind !== "error";
  const offer = open && live && !settled;
  if (!offer && outcome === null) return null;

  return (
    <section
      aria-label="실행 중단"
      className="flex flex-col gap-2 border-b border-line px-4 py-2"
      data-testid="agent-work-panel-stop"
    >
      {offer &&
        (!armed ? (
          <div className="flex items-center">
            <Button
              ref={armRef}
              type="button"
              variant="secondary"
              size="sm"
              aria-label={STOP_ARM_NAME}
              onClick={() => setArmed(true)}
              data-testid="agent-work-panel-stop-arm"
            >
              {CANCEL_ACTION_LABEL}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2" data-testid="agent-work-panel-stop-confirm">
            <p className="break-keep text-meta text-ink" id={`stop-consequence-${runId}`}>
              {CANCEL_CONFIRM_SENTENCE}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                ref={keepRef}
                type="button"
                variant="ghost"
                size="sm"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) dismiss();
                }}
                data-testid="agent-work-panel-stop-keep"
              >
                그대로 두기
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                // 네이티브 disabled가 아니다: 보내는 동안 캐럿이 이 버튼에 남아야
                // 실패 문장이 선 뒤 바로 다시 누를 수 있다.
                aria-disabled={busy || undefined}
                aria-busy={busy || undefined}
                aria-describedby={`stop-consequence-${runId}`}
                onClick={() => void commit()}
                data-testid="agent-work-panel-stop-commit"
              >
                {busy && <Loader2 aria-hidden="true" className="spinner-busy" />}
                {busy ? CANCEL_BUSY_LABEL : CANCEL_COMMIT_LABEL}
              </Button>
            </div>
          </div>
        ))}
      {outcome !== null && (
        <p
          role={outcome.kind === "error" ? "alert" : "status"}
          className={cn(
            "break-keep text-meta",
            outcome.kind === "error" ? "text-danger" : "text-ink-muted"
          )}
          data-testid="agent-work-panel-stop-outcome"
          data-kind={outcome.kind}
        >
          {outcome.sentence}
        </p>
      )}
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cancelAgentRun } from "@momo/core/lib/api";
import {
  cancelSucceeded,
  STOP_WORDING,
  type CancelOutcome,
  type CancelWording,
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
export const STOP_ARM_NAME = STOP_WORDING.armName;

export function StopRunControl({
  runId,
  agentName,
  open,
  live,
  wording = STOP_WORDING,
  variant = "panel",
  onSettled,
}: {
  runId: string;
  /** 영수증이 부를 이름. 여러 에이전트의 일 옆에 서므로 누구의 실행인지 말한다. */
  agentName: string;
  /** 서버가 이 run을 아직 열린 phase로 말하는가. */
  open: boolean;
  /** 실시간 연결이 살아 있는가. */
  live: boolean;
  /**
   * 낱말·문장 한 벌(`cancelWordingFor`). 아직 아무도 가져가지 않은 요청은 「취소」, 가져간 뒤는
   * 「중단」이다(#4285). 호출·한 겹의 확인·409와 오류를 읽는 규칙은 둘이 같다.
   */
  wording?: CancelWording;
  /**
   * 어디에 서는가. `panel`은 작업 패널의 한 영역(경계선·여백이 있는 띠)이고, `inline`은 대화의
   * 한 줄 안(예외 줄의 행동 자리, #4619)이다: 띠의 경계선·여백을 걷어 줄의 다른 행동 곁에 선다.
   * 호출·한 겹의 확인·캐럿 규칙은 둘이 같다.
   */
  variant?: "panel" | "inline";
  /**
   * 취소·중단이 **받아들여졌거나 이미 끝나 있었다**는 답이 선 순간 한 번 부른다(오류는 부르지 않는다: 다시 누를 수 있다). 대화 줄 안의
   * 이 단추(#4619)는 run이 취소로 넘어가는 순간 줄과 함께 사라지는데, 그 안의 결과 문장(`role="status"`)과 캐럿도 같이 사라진다
   * (design-review r1 M9). 부르는 쪽이 이 신호로 줄을 영수증으로 남긴다.
   */
  onSettled?: () => void;
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
  const sectionRef = useRef<HTMLElement>(null);
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  /** 답(중단됨·이미 끝남)이 선 뒤 캐럿을 그 문장으로 옮길 것인가. */
  const focusOutcome = useRef(false);

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

  // 중단됨·이미 끝남이면 확정 버튼도 무장 버튼도 사라진다. 캐럿이 그 버튼에 있었다면
  // <body>로 떨어지므로, 방금 선 문장으로 옮긴다(#3854 design-review H-1). 실패는
  // 확정 버튼이 그대로 남아 캐럿도 그 자리에 있다.
  useEffect(() => {
    if (outcome === null || !focusOutcome.current) return;
    focusOutcome.current = false;
    outcomeRef.current?.focus();
  }, [outcome]);

  const dismiss = useCallback(() => {
    returnFocus.current = true;
    setArmed(false);
  }, []);

  const commit = useCallback(async () => {
    if (!armed || sending.current) return;
    sending.current = true;
    setBusy(true);
    setOutcome(null);
    // 원장을 다시 읽어 머리 칩이 방금 낸 문장과 같은 말을 하게 한다. 진행 칩은
    // 서버의 run 프레임도 따라온다.
    const rereadLedger = () =>
      void client.invalidateQueries({
        queryKey: ["agent-run-events", workspaceId, runId.toLowerCase()],
      });
    const caretInside = () =>
      sectionRef.current?.contains(document.activeElement) ?? false;
    try {
      const result = await cancelAgentRun(workspaceId, runId);
      focusOutcome.current = caretInside();
      setArmed(false);
      setOutcome(cancelSucceeded(result, agentName, wording));
      // 원장의 「취소됐어요」 줄을 바로 읽는다.
      rereadLedger();
    } catch (error) {
      // 실패 문장도 낱말 한 벌을 따른다: 「취소」 버튼 뒤에 「중단하지 못했어요」가 서지 않는다.
      const next = wording.failure(error);
      if (next.kind === "alreadyOver") {
        // 이미 끝난 실행에는 더 물을 것이 없다. 확인 줄을 접는다. 칩이 「작업 중」에
        // 머문 채 「이미 끝났어요」와 나란히 서지 않게 원장도 다시 읽는다.
        focusOutcome.current = caretInside();
        setArmed(false);
        rereadLedger();
      }
      setOutcome(next);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }, [agentName, armed, client, runId, wording, workspaceId]);

  // 이 버튼이 이미 답을 받았으면(중단됨·이미 끝남) 서버 칩이 따라오기 전이라도 다시
  // 권하지 않는다. 실패(`error`)만 다시 누를 수 있다.
  const settled = outcome !== null && outcome.kind !== "error";
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  useEffect(() => {
    if (settled) settledRef.current?.();
  }, [settled]);
  const offer = open && live && !settled;
  if (!offer && outcome === null) return null;

  return (
    <section
      ref={sectionRef}
      // 대화 줄 안(inline)에서는 영역(landmark)이 아니라 묶음이다: 메시지마다 「요청 취소」 영역이 서면
      // 보조기술의 영역 목록이 타임라인 길이만큼 늘어난다.
      role={variant === "inline" ? "group" : undefined}
      aria-label={wording.regionName}
      className={
        variant === "inline"
          ? // 확인 줄·결과 문장이 서면 같은 줄의 다른 행동 곁이 아니라 **자기 줄**(`basis-full`)을 쓴다: 문장 위에 단추가 쌓인
            // 두 겹 덩어리가 예외 줄 한가운데(`items-center`)에 떠 있으면 줄의 글이 그 덩어리의 한가운데로 밀려 어긋난다.
            cn("flex min-w-0 flex-col gap-2", (armed || outcome !== null) && "basis-full")
          : "flex flex-col gap-2 border-b border-line px-4 py-2"
      }
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
              // 폰 폭에서 44: 같은 확인 줄의 「취소 확정」은 이미 44(전역 규칙)라 안전한 쪽이 더 작은 표적이면 위험한 쪽이 더 크다.
              className="tap-target"
              aria-label={wording.armName}
              onClick={() => setArmed(true)}
              data-testid="agent-work-panel-stop-arm"
            >
              {wording.action}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2" data-testid="agent-work-panel-stop-confirm">
            <p className="break-keep text-meta text-ink" id={`stop-consequence-${runId}`}>
              {wording.consequence(undefined)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                ref={keepRef}
                type="button"
                variant="ghost"
                size="sm"
                className="tap-target"
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
                {busy ? wording.busy : wording.commit}
              </Button>
            </div>
          </div>
        ))}
      {outcome !== null && (
        <p
          ref={outcomeRef}
          // 캐럿이 머물 수 있는 문장이다(탭 순서에는 자리를 만들지 않는다).
          tabIndex={-1}
          role={outcome.kind === "error" ? "alert" : "status"}
          className={cn(
            "break-keep text-meta focus-visible:focus-ring",
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

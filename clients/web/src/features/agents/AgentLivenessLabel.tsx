import {
  livenessAccessibleName,
  livenessView,
  type LivenessTone,
} from "@momo/core/features/agents/liveness";
import { cn } from "@/design/lib/cn";
import { useAgentLiveness } from "./useAgentLiveness";
import { WakeAgentButton } from "./WakeAgentButton";

// =============================================================================
// 에이전트의 생존 라벨 (ADR-0200 D4, #3749). 멤버 목록·에이전트 헤더·사이드바 행·
// 작업 패널이 이 한 컴포넌트를 쓴다: 같은 에이전트에 대해 자리마다 다른 말을 하지
// 않게.
//
// 「연결됨」과 다른 사실이다. 라벨은 서버가 수령·읽기·run 이벤트·ping으로 **지금**
// 파생한 것이고, 서버가 모르는 에이전트(hosted가 아님)에는 아무것도 그리지 않는다.
// 점은 색만으로 상태를 말하지 않는다 — 낱말이 항상 곁에 있다(compact도 낱말이다).
// =============================================================================

const DOT_CLASS: Readonly<Record<LivenessTone, string>> = {
  ok: "bg-ok",
  neutral: "bg-ink-muted",
  warn: "bg-warn",
};

const TEXT_CLASS: Readonly<Record<LivenessTone, string>> = {
  ok: "text-ink-muted",
  neutral: "text-ink-muted",
  warn: "text-warn",
};

export function AgentLivenessLabel({
  agentId,
  variant = "full",
  className,
}: {
  agentId: string | null;
  /** `compact`는 사이드바 행처럼 폭이 좁은 자리의 한두 낱말이다. */
  variant?: "full" | "compact";
  className?: string;
}) {
  const { liveness, nowMs } = useAgentLiveness(agentId);
  if (liveness === null || liveness === undefined) return null;
  const view = livenessView(liveness, nowMs);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-timestamp",
        TEXT_CLASS[view.tone],
        className
      )}
      data-testid="agent-liveness"
      data-state={view.state}
      data-tone={view.tone}
      data-variant={variant}
      title={livenessAccessibleName(view)}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[view.tone])}
      />
      <span className="min-w-0 truncate">
        {variant === "compact" ? view.short : view.text}
      </span>
      <span className="sr-only">. {view.meaning}</span>
    </span>
  );
}

/**
 * 라벨과 「다시 깨우기」를 한 덩어리로(에이전트 헤더·작업 패널 머리). 버튼은 owner/admin이
 * 눌러도 되는 상태에서만 서고, 그렇지 않으면 라벨만 남는다.
 */
export function AgentLivenessBar({
  agentId,
  className,
}: {
  agentId: string | null;
  className?: string;
}) {
  const { liveness } = useAgentLiveness(agentId);
  if (agentId === null || liveness === null || liveness === undefined) return null;
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1", className)}
      data-testid="agent-liveness-bar"
    >
      <AgentLivenessLabel agentId={agentId} />
      <WakeAgentButton agentId={agentId} state={liveness.state} />
    </div>
  );
}

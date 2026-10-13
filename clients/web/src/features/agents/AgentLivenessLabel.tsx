import {
  livenessView,
  type LivenessTone,
} from "@momo/core/features/agents/liveness";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
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
  const { session, workspaceId } = useSession();
  const { directory } = useDirectory(workspaceId);
  if (liveness === null || liveness === undefined) return null;
  const view = livenessView(liveness, nowMs);
  // 경고색은 **사람이 할 수 있는 일이 있는 상태**의 색이다. 다시 깨울 수 있는 사람
  // (owner/admin)에게만 경고로 읽히고, 그 밖의 멤버에게는 같은 사실이 중립 낱말이다
  // (할 수 있는 일이 없는 경고는 소음이다, design-review U3 M-3).
  const role = memberFor(directory, session.member.id)?.role;
  const mayAct = role === "owner" || role === "admin";
  const tone: LivenessTone = view.tone === "warn" && !mayAct ? "neutral" : view.tone;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-timestamp",
        TEXT_CLASS[tone],
        className
      )}
      data-testid="agent-liveness"
      data-state={view.state}
      data-tone={tone}
      data-variant={variant}
      // 뜻은 마우스를 올린 사람의 것이고, 보조기술은 아래 숨은 글이 읽는다. 둘을 같은
      // 문장으로 주면 일부 보조기술이 뜻을 두 번 읽는다(design-review U3 M-6): 좁은
      // 자리에서는 title만 뜻을 갖고 숨은 글은 라벨 한 줄이다.
      title={variant === "compact" ? view.meaning : undefined}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[tone])}
      />
      <span className="min-w-0 truncate" aria-hidden={variant === "compact" || undefined}>
        {variant === "compact" ? view.short : view.text}
      </span>
      <span className="sr-only">
        {variant === "compact" ? view.text : `${view.text}. ${view.meaning}`}
      </span>
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

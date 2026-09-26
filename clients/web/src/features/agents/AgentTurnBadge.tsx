import { cn } from "@/design/lib/cn";
import type { AgentTurnState } from "./agentWorkingSignal";
import { TURN_STALE_SENTENCE } from "./turnCopy";

/**
 * A compact turn state whose color is evidence-sensitive.
 *
 * The realtime rail is the authority for whether a remembered working claim is
 * still live. Every surface uses this component so a disconnected roster never
 * looks more certain than the sidebar that supplied the same signal.
 */
export function AgentTurnBadge({
  state,
  text,
  label,
  live,
  testId,
}: {
  state: AgentTurnState;
  text: string;
  label: string;
  live: boolean;
  testId?: string;
}) {
  const accessibleLabel = live ? label : `${label} ${TURN_STALE_SENTENCE}`;
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1 text-timestamp",
        !live && "text-ink-muted",
        // 자기 그릇(agent-soft)을 가진 칩이라, 띠(노을띠) 사이드바 안에서도
        // 원래 글자 역할을 쓴다(DS2-6 `band-surface`). 그릇 없는 두 상태(테두리
        // 승인 대기, 흐린 기억)는 띠의 글자 역할을 그대로 받는다.
        live && state === "working" && "band-surface bg-agent-soft text-agent",
        live &&
          state === "awaiting_approval" &&
          "border border-warn text-warn"
      )}
      data-testid={testId}
      data-live={live ? "" : undefined}
      data-state={state}
      title={accessibleLabel}
    >
      <span className="sr-only">{accessibleLabel}</span>
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

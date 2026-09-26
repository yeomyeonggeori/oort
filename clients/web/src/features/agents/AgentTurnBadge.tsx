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
        // 띠(노을띠) 사이드바 안에서는 agent·agent-soft가 on-band와 띠 채움으로
        // 다시 묶인다(tokens.css 띠 범위, DS2-6). 띠 위에 옅은 파랑 그릇을 세우지
        // 않는다(themes-2.0 §3).
        live && state === "working" && "bg-agent-soft text-agent",
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

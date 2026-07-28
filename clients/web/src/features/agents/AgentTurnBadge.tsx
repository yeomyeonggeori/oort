import { cn } from "@/design/lib/cn";
import type { AgentTurnState } from "./agentWorkingSignal";

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
  const accessibleLabel = live
    ? label
    : `${label} 연결이 끊겨 갱신이 멈췄습니다. 마지막으로 확인된 상태입니다.`;
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1 text-timestamp",
        !live && "text-ink-muted",
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

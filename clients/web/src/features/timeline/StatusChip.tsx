import { cn } from "@/design/lib/cn";
import {
  APPROVAL_STATUS_LABEL,
  TURN_STATUS_LABEL,
  type AgentTurnStatus,
  type ApprovalStatus,
} from "./agentCardModel";

// =============================================================================
// The one status chip vocabulary for agent surfaces (R-1 §4).
//
// It lives in its own file because two cards now speak it: AgentCard, and the
// artifact card that outranks AgentCard for a diff. A diff produced by a run
// that FAILED has to wear the same 실패 chip in the same token colour as the
// tool card it replaced, or the same run says two different things depending on
// what its body happened to look like.
//
// Only the status goes in, and the label and tone come out together: passing
// them separately is how a card ends up with a green tone on a failed label.
//
// Text first, one token status colour, no pulse: a chip that animates forever
// is decoration pretending to be information (design-taste-web §8).
// =============================================================================

const TURN_CHIP_CLASS: Readonly<Record<AgentTurnStatus, string>> = {
  queued: "bg-surface-hover text-ink-muted",
  thinking: "bg-surface-hover text-warn",
  streaming: "bg-surface-hover text-warn",
  "awaiting-approval": "bg-accent-soft text-accent",
  done: "bg-surface-hover text-ok",
  error: "bg-surface-hover text-danger",
  stalled: "bg-surface-hover text-warn",
  cancelled: "bg-surface-hover text-ink-muted",
};

const APPROVAL_CHIP_CLASS: Readonly<Record<ApprovalStatus, string>> = {
  pending: "bg-accent-soft text-accent",
  approved: "bg-surface-hover text-ok",
  rejected: "bg-surface-hover text-danger",
  expired: "bg-surface-hover text-ink-muted",
  cancelled: "bg-surface-hover text-ink-muted",
};

const CHIP_CLASS = "shrink-0 rounded-sm px-2 py-px text-timestamp font-medium";

/** Agent turn lifecycle chip: queued / thinking / streaming / done / error … */
export function TurnChip({ status }: { status: AgentTurnStatus }) {
  return (
    <span
      data-testid="agent-status-chip"
      data-status={status}
      className={cn(CHIP_CLASS, TURN_CHIP_CLASS[status])}
    >
      {TURN_STATUS_LABEL[status]}
    </span>
  );
}

/** Approval lifecycle chip, verbatim from the `approval_status` PG enum. */
export function ApprovalChip({ status }: { status: ApprovalStatus }) {
  return (
    <span
      data-testid="agent-status-chip"
      data-status={status}
      className={cn(CHIP_CLASS, APPROVAL_CHIP_CLASS[status])}
    >
      {APPROVAL_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * The live caret. Streaming gets a caret, never a shimmer skeleton, and the
 * blink is guarded by prefers-reduced-motion in tokens.css.
 */
export function StreamCaret() {
  return (
    <span
      aria-hidden="true"
      data-testid="stream-caret"
      className="caret-stream ml-px inline-block h-3 w-px shrink-0 bg-accent align-middle"
    />
  );
}

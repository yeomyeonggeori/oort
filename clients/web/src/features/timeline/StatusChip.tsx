import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";
import {
  APPROVAL_STATUS_LABEL,
  TURN_STATUS_LABEL,
  type AgentTurnStatus,
  type ApprovalStatus,
} from "@momo/core/features/timeline/agentCardModel";
import {
  loginHandoffStatusLabel,
  type LoginHandoffCard,
  type LoginHandoffOutcome,
  type LoginHandoffPhase,
} from "@momo/core/features/timeline/loginHandoffCard";
import {
  COMPLETION_OUTCOME_LABEL,
  COMPLETION_OUTCOME_TONE,
  type CompletionOutcome,
} from "@momo/core/features/timeline/completionReportCard";
import { COMPLETION_TONE_CLASS } from "./completionTone";

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
 * 로그인 핸드오프 칩 (LIVE-4).
 *
 * 색이 국면이 아니라 **결과**를 따른다. 「개입 완료」와 「완료 불확실」이 같은 옷을
 * 입으면 카드가 애써 갈라 둔 두 사실이 화면에서 다시 붙고, 그 붙음의 값은
 * 에이전트가 로그인되지 않은 화면 위에서 다음 단계를 밟는 것이다.
 *
 * `expired`가 `warn`이지 `danger`가 아닌 이유는 ADR-0132의 규칙 그대로다: 신호가
 * 없는 것은 실패가 아니다. `session_ended`와 `stopped`는 둘 다 조용한 종결이라
 * 중성이고, `waiting`만 대기 승인과 같은 호박색을 든다 — 사람이 할 일이 남아
 * 있다는 뜻의 색은 이 제품에서 하나여야 한다.
 */
const LOGIN_HANDOFF_CHIP_CLASS: Readonly<
  Record<LoginHandoffOutcome | LoginHandoffPhase, string>
> = {
  waiting: "bg-accent-soft text-accent",
  returned: "bg-surface-hover text-ok",
  expired: "bg-surface-hover text-warn",
  session_ended: "bg-surface-hover text-ink-muted",
  stopped: "bg-surface-hover text-ink-muted",
  // 결과 없이 `resolved`인 카드는 코어의 판정에서 나오지 않는다. 그래도 총체적인
  // 표로 두는 이유는 rowModel의 `NOTE_COPY`와 같다: 어휘가 하나 늘면 여기서
  // 타입 검사가 깨져야지, 남의 문장을 조용히 물려받으면 안 된다.
  resolved: "bg-surface-hover text-ink-muted",
};

export function LoginHandoffChip({ card }: { card: LoginHandoffCard }) {
  const key = card.outcome ?? card.phase;
  return (
    <span
      data-testid="agent-status-chip"
      data-status={key}
      className={cn(CHIP_CLASS, LOGIN_HANDOFF_CHIP_CLASS[key])}
    >
      {loginHandoffStatusLabel(card)}
    </span>
  );
}

/**
 * 작업 완료 리포트 칩 (UXC-A).
 *
 * 국면이 아니라 **결과 하나**만 말한다: 게이트가 전부 통과했으면 `clean`, 하나라도
 * 실패했으면 `attention`. `attention` 이 `danger` 가 아니라 `warn` 인 이유는
 * 로그인 핸드오프의 `expired` 가 `warn` 인 것과 같은 규칙이다 — 리포트를 낸 턴은
 * 성공했고, 실패한 것은 표 안의 한 게이트다. 그 붉은색은 그 셀에만 있고, 머리 칩은
 * 「여기 볼 것이 있다」를 말한다. 「사람이 할 일이 남아 있다」의 색은 이 제품에서
 * 하나여야 한다(`--warn`).
 *
 * 색은 인라인 리터럴이 아니라 **코어의 역할표**(`COMPLETION_OUTCOME_TONE`)를 이
 * 팔레트의 클래스(`COMPLETION_TONE_CLASS`)로 옮겨 칠한다 — 게이트 셀과 같은 다리다
 * (L1). 그래야 `attention: text-danger` 같은 한 글자 오타가 `completionTone.test`
 * 의 tokens 락에 걸린다.
 */
export function CompletionReportChip({ outcome }: { outcome: CompletionOutcome }) {
  return (
    <span
      data-testid="agent-status-chip"
      data-status={outcome}
      className={cn(
        CHIP_CLASS,
        "bg-surface-hover",
        COMPLETION_TONE_CLASS[COMPLETION_OUTCOME_TONE[outcome]]
      )}
    >
      {COMPLETION_OUTCOME_LABEL[outcome]}
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

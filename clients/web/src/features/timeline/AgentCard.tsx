import { useState } from "react";
import { ShieldQuestion, Terminal, Zap } from "lucide-react";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import {
  formatCount,
  formatMicroUsd,
  resolveApprovalStatus,
  type AgentApprovalCard,
  type AgentCardModel,
  type AgentToolCard,
  type AgentTurnCard,
  type ApprovalStatus,
  type PayloadDetail,
} from "./agentCardModel";
import { ApprovalChip, StreamCaret, TurnChip } from "./StatusChip";
import { ApprovalActions, type Armed } from "./ApprovalActions";

// =============================================================================
// Agent card (R-1 §4). Structured, calm, dense: a title row (icon, name, status
// chip), then typed key/value rows, then a disclosure, then the ledger action.
//
// It is the BODY of an agent message, not a floating panel: MessageRow keeps
// the shared grid, avatar and typography, and this only fills the body slot
// (design-taste-web §9, "same grid, same typography").
//
// Two primitives are deliberately not Radix, each for a stated reason:
//   - the disclosure is native <details>/<summary>. That IS the platform
//     disclosure primitive: it already ships the open state and the Space/Enter
//     keyboard path, so Radix Collapsible would only re-implement it behind a
//     dependency.
//   - the approve/reject confirmation is an inline two-step row rather than
//     AlertDialog, which is not in this client's dependency set. The guard the
//     rule actually asks for is intact (no decision fires on a single
//     unguarded click), and keeping the confirmation in the row keeps it next
//     to the evidence the human is judging instead of covering it with a modal.
// =============================================================================

/** One typed key/value row. Never a raw JSON blob (design-taste-web §8). */
function LabeledRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-baseline gap-2 px-3 py-1"
      data-testid={testId}
    >
      <dt className="shrink-0 text-meta text-ink-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-body text-ink">
        {children}
      </dd>
    </div>
  );
}

/**
 * Numeric row: mono, tabular, right aligned so the column reads down. Values
 * change at data speed, there is no count-up animation.
 */
function NumericRow({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  testId?: string;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-3 px-3 py-1"
      data-testid={testId}
    >
      <dt className="shrink-0 text-meta text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right">
        <span data-numeric className="font-mono text-meta text-ink">
          {value}
        </span>
        {note && <span className="ml-2 text-meta text-ink-muted">{note}</span>}
      </dd>
    </div>
  );
}

/**
 * Disclosure over the payload. What is behind it is the PUBLIC field set plus
 * an honest count of what the server sent and this client will not interpret.
 * Tool arguments, execution paths, grants and credentials never render, folded
 * or not (ADR-0112 basic mode, design-taste-web §9).
 */
function PayloadDisclosure({ detail }: { detail: PayloadDetail }) {
  if (detail.rows.length === 0 && detail.withheld === 0) return null;
  return (
    <details className="border-t border-line" data-testid="agent-payload">
      <summary className="cursor-pointer px-3 py-2 text-meta text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        원본 데이터 보기
      </summary>
      <dl className="pb-2">
        {detail.rows.map((row) => (
          <LabeledRow key={row.label} label={row.label}>
            {row.value}
          </LabeledRow>
        ))}
      </dl>
      <p className="px-3 pb-2 text-meta text-ink-muted">
        {detail.withheld > 0 && (
          <span data-numeric data-testid="agent-payload-withheld">
            숨김 {formatCount(detail.withheld)}개.{" "}
          </span>
        )}
        도구 인자, 실행 경로, 자격증명은 서버가 공개하지 않으므로 표시하지
        않습니다.
      </p>
    </details>
  );
}

function timeLabel(atMs: number): string {
  const d = new Date(atMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

/**
 * Short ledger handle for the audit trail line (R-1 §4): the settled row reads
 * "누가 · 언제 · 원장 #xxxx", which is the visible end of the hash-chained
 * approval audit rather than a decoration.
 */
function ledgerHandle(approvalId: string): string {
  return approvalId.replace(/-/g, "").slice(0, 4).toLowerCase();
}

function ApprovalBody({
  card,
  directory,
}: {
  card: AgentApprovalCard;
  directory: Directory;
}) {
  const [local, setLocal] = useState<{
    status: ApprovalStatus;
    decidedAtMs?: number;
    decidedByMemberId?: string;
    note?: string;
  } | null>(null);
  const [armed, setArmed] = useState<Armed>(null);

  const status = resolveApprovalStatus(local?.status ?? null, card.status);
  const settled = status !== "pending";
  const decidedAtMs = local?.decidedAtMs ?? card.decidedAtMs;
  const decidedById = local?.decidedByMemberId ?? card.decidedByMemberId;
  const decidedBy = decidedById ? memberFor(directory, decidedById) : null;

  return (
    <CardFrame
      icon={<ShieldQuestion className="size-4" aria-hidden="true" />}
      title={card.title}
      chip={<ApprovalChip status={status} />}
      status={status}
      kind="approval"
      note={
        local?.note ? (
          <p
            role="status"
            data-testid="approval-note"
            className="px-3 pb-2 text-meta text-ink-muted"
          >
            {local.note}
          </p>
        ) : undefined
      }
      keyboard={!settled && !card.isResumeOffer}
      onApprove={() => setArmed("approve")}
      onReject={() => setArmed("reject")}
      detail={card.detail}
      footer={
        card.isResumeOffer ? (
          <p
            className="border-t border-line px-3 py-2 text-meta text-ink-muted"
            data-testid="resume-offer-note"
          >
            git 계보만 새 호스트로 이어집니다. 이전 호스트의 터미널 상태와
            커밋하지 않은 변경은 옮겨지지 않습니다. 작업 세션 패널의 내
            세션에서 온라인 호스트를 선택하세요.
          </p>
        ) : !settled && card.approvalId !== null ? (
          <ApprovalActions
            approvalId={card.approvalId}
            className="border-t border-line"
            armed={armed}
            setArmed={setArmed}
            onSettled={(outcome) => {
              const next: {
                status: ApprovalStatus;
                decidedAtMs?: number;
                decidedByMemberId?: string;
                note?: string;
              } = { status: outcome.status ?? "pending" };
              if (outcome.decidedAtMs !== undefined) {
                next.decidedAtMs = outcome.decidedAtMs;
              }
              if (outcome.decidedByMemberId !== undefined) {
                next.decidedByMemberId = outcome.decidedByMemberId;
              }
              if (outcome.note !== undefined) next.note = outcome.note;
              setLocal(next);
            }}
          />
        ) : null
      }
    >
      {card.summary && <LabeledRow label="요청">{card.summary}</LabeledRow>}
      {card.isReversible !== undefined && (
        <LabeledRow label="영향" testId="approval-impact">
          {card.isReversible
            ? "되돌릴 수 있습니다."
            : "되돌릴 수 없습니다."}
        </LabeledRow>
      )}
      {card.estimatedMicroUsd !== undefined && (
        <NumericRow
          label="예상 비용"
          value={formatMicroUsd(card.estimatedMicroUsd)}
          note="추정"
          testId="approval-estimate"
        />
      )}
      {settled && (decidedBy || decidedAtMs !== undefined) && (
        <LabeledRow label="승인" testId="approval-ledger">
          <span data-numeric>
            {[
              decidedBy?.displayName,
              decidedAtMs !== undefined ? timeLabel(decidedAtMs) : null,
              card.approvalId
                ? `원장 #${ledgerHandle(card.approvalId)}`
                : null,
            ]
              .filter((part): part is string => Boolean(part))
              .join(" · ")}
          </span>
        </LabeledRow>
      )}
    </CardFrame>
  );
}

function ToolBody({ card }: { card: AgentToolCard }) {
  const live = card.status === "thinking" || card.status === "streaming";
  return (
    <CardFrame
      icon={<Terminal className="size-4" aria-hidden="true" />}
      title={card.title}
      chip={<TurnChip status={card.status} />}
      status={card.status}
      kind="tool"
      detail={card.detail}
    >
      {card.frame.object && (
        <LabeledRow label="대상">{card.frame.object}</LabeledRow>
      )}
      <LabeledRow label="결과" testId="agent-frame">
        {card.frame.outcome ?? (live ? "실행 중입니다." : "결과가 없습니다.")}
        {live && <StreamCaret />}
      </LabeledRow>
      {card.errorNote && (
        // Same rule as the turn card: silence is not failure, so a stalled run
        // gets the server note without the 오류 label and without the danger
        // colour (ADR-0132).
        <LabeledRow
          label={card.status === "stalled" ? "마지막 신호" : "오류"}
          testId="tool-error"
        >
          {card.status === "stalled" ? (
            card.errorNote
          ) : (
            <span className="text-danger">{card.errorNote}</span>
          )}
        </LabeledRow>
      )}
    </CardFrame>
  );
}

function TurnBody({ card }: { card: AgentTurnCard }) {
  const live = card.status === "thinking" || card.status === "streaming";
  const cost = card.cost;
  return (
    <CardFrame
      icon={<Zap className="size-4" aria-hidden="true" />}
      title={card.title}
      chip={<TurnChip status={card.status} />}
      status={card.status}
      kind="turn"
      detail={card.detail}
    >
      {live && (
        <LabeledRow label="진행">
          응답을 받는 중입니다.
          <StreamCaret />
        </LabeledRow>
      )}
      {card.status === "stalled" && (
        <LabeledRow label="상태" testId="turn-stalled">
          아직 응답이 없습니다. 실패로 확정되지 않았습니다.
        </LabeledRow>
      )}
      {card.errorNote &&
        // A stalled turn gets the same server note WITHOUT the failure label
        // and without the danger color: painting silence red is the false
        // story the stalled state exists to prevent (ADR-0132).
        (card.status === "stalled" ? (
          <LabeledRow label="마지막 신호" testId="turn-signal">
            {card.errorNote}
          </LabeledRow>
        ) : (
          <LabeledRow label="오류" testId="turn-error">
            <span className="text-danger">{card.errorNote}</span>
          </LabeledRow>
        ))}
      {cost?.model && <LabeledRow label="모델">{cost.model}</LabeledRow>}
      {cost &&
        (cost.promptTokens !== undefined ||
          cost.completionTokens !== undefined) && (
          <NumericRow
            label="토큰"
            testId="turn-tokens"
            value={`${formatCount(cost.promptTokens ?? 0)} in / ${formatCount(
              cost.completionTokens ?? 0
            )} out`}
          />
        )}
      {cost?.costMicroUsd !== undefined && (
        <NumericRow
          label="비용"
          testId="turn-cost"
          value={formatMicroUsd(cost.costMicroUsd)}
          {...(cost.estimated ? { note: "추정" } : {})}
        />
      )}
    </CardFrame>
  );
}

/**
 * Shared shell. Focusable so the card carries its own keyboard path: Y arms an
 * approval, N arms a rejection, and both still route through the confirm step
 * (R-1 §4 "확인 경유"). Space toggles the disclosure natively on <summary>.
 */
function CardFrame({
  icon,
  title,
  chip,
  status,
  kind,
  detail,
  children,
  note,
  footer,
  keyboard = false,
  onApprove,
  onReject,
}: {
  icon: React.ReactNode;
  title: string;
  chip: React.ReactNode;
  status: string;
  kind: string;
  detail: PayloadDetail;
  /** Typed rows. Only dt/dd pairs: this slot is the inside of a <dl>. */
  children: React.ReactNode;
  /** Quiet prose that must sit OUTSIDE the <dl> to stay valid HTML. */
  note?: React.ReactNode;
  footer?: React.ReactNode;
  keyboard?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  return (
    <section
      data-testid="agent-card"
      data-card-kind={kind}
      data-status={status}
      tabIndex={0}
      aria-label={title}
      {...(keyboard ? { "aria-keyshortcuts": "y n" } : {})}
      onKeyDown={(event) => {
        if (!keyboard) return;
        // Only when the card itself holds focus: a keystroke inside a button or
        // the disclosure belongs to that control.
        if (event.target !== event.currentTarget) return;
        const key = event.key.toLowerCase();
        if (key === "y") {
          event.preventDefault();
          onApprove?.();
        } else if (key === "n") {
          event.preventDefault();
          onReject?.();
        }
      }}
      // max-w-pane-lg: the card has a measure. Let it run the full timeline
      // width and the numeric column ends up a screen away from its label,
      // which stops reading as a card and starts reading as a banner.
      className="mt-2 max-w-pane-lg rounded-md border border-line bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="shrink-0 text-ink-muted">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
          {title}
        </span>
        {chip}
      </div>
      <dl className="py-1">{children}</dl>
      {note}
      <PayloadDisclosure detail={detail} />
      {footer}
    </section>
  );
}

export function AgentCard({
  card,
  directory,
}: {
  card: AgentCardModel;
  directory: Directory;
}) {
  if (card.kind === "approval") {
    return <ApprovalBody card={card} directory={directory} />;
  }
  if (card.kind === "tool") return <ToolBody card={card} />;
  return <TurnBody card={card} />;
}

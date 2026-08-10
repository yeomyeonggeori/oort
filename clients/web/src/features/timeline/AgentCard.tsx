import { useState } from "react";
import { Check, ShieldQuestion, Terminal, Zap } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { useOffline } from "@/features/common/useOffline";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import {
  approvalCardNote,
  type ApprovalCardNote,
} from "@momo/core/features/timeline/approvalNote";
// 영수증 문장은 **인박스와 같은 함수**가 짓는다 (design-review M-3). 이 카드가
// 결정한 뒤 말할 문장은 인박스 목록이 같은 원장 응답에 대해 말하는 문장과 같아야
// 하고, 그 판정은 이미 거기 landing 해 있다(원장에 적힌 **방향**까지 말한다:
// 내가 승인을 눌렀는데 원장에 거부가 적혀 있을 수 있다). 앞 판의 이 카드는
// `outcome.note` 만 읽었는데 그 필드는 409(이미 결정됨)에만 실리므로, **성공한
// 결정에는 영수증이 아예 없었다** — 리뷰가 「가장 값어치 있는 문장」이라 부른 그
// 줄이 웹에서는 그려지지도 않고 있었다.
import { decisionNote } from "@/features/inbox/approvalsPanel";
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
} from "@momo/core/features/timeline/agentCardModel";
import { spawnHostGate } from "@momo/core/features/timeline/spawnHostChoice";
import { ApprovalChip, StreamCaret, TurnChip } from "./StatusChip";
import { ApprovalActions, type Armed } from "./ApprovalActions";
import { FoldedValue } from "./FoldToggle";
import {
  isSurfaceProvided,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";

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
      <summary className="cursor-pointer px-3 py-2 text-meta text-ink-muted hover:bg-surface-hover focus-visible:focus-ring">
        원본 데이터 보기
      </summary>
      <dl className="pb-2">
        {detail.rows.map((row) => (
          <LabeledRow key={row.label} label={row.label}>
            {/* 값에는 예산이 붙는다 (U4-e · 진단 H-8 「에이전트 카드 값 무제한」).
                행의 **개수**가 아닌 이유는 코어의 `payloadDetail`이 이름 붙은
                필드만 만들어 개수가 이미 유한하기 때문이다 — 무한한 축은 값의
                길이이고, 여러 줄짜리 결정 사유 하나가 카드를 본문보다 크게
                만든다 (fold.ts `CARD_FOLD`). */}
            <FoldedValue text={row.value} testId="agent-payload-fold" />
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

/**
 * 재개 제안이 설명할 것. 승인이 아니라 **다음에 무엇이 일어나는가**의 안내이므로
 * 가장 조용한 격을 쓴다(`guidance`).
 */
const RESUME_OFFER_COPY =
  "git 계보만 새 호스트로 이어집니다. 이전 호스트의 터미널 상태와 커밋하지 않은 변경은 옮겨지지 않습니다. 작업 세션 패널의 내 세션에서 온라인 호스트를 선택하세요.";

/**
 * 카드의 한 줄을 **격에 맞는 옷으로** 그린다 (design-review M-3).
 *
 * 리뷰: *"세 문장이 전부 같은 옷을 입는다. (…) 카드에서 가장 값어치 있는 문장인
 * 영수증이 가장 조용한 차림으로 나온다."* 웹도 같았다 — 영수증·재개 안내·원장
 * 없음 고지가 전부 `text-meta text-ink-muted` 한 벌이었다.
 *
 * 격은 코어가 정하고(`APPROVAL_NOTE_TONE_ORDER`) 이 함수가 옷을 입힌다:
 *
 *   * `receipt` — 본문 크기의 `text-ink`. 카드 안에서 크기로 올라오는 유일한
 *     문장이고, 그 이유는 이것이 **방금 내가 한 되돌릴 수 없는 행동의 기록**이기
 *     때문이다. 앞에 체크 아이콘이 서서 훑는 눈이 이 줄을 먼저 잡는다.
 *   * `blocked` — `text-warn`. 위험이 아니라 **때**의 문제이므로 danger가 아니고,
 *     조용한 안내에 묻히면 사람이 버튼을 계속 누르므로 muted도 아니다. 컴포저의
 *     오프라인 줄과 같은 톤이라 한 화면에서 두 자리가 같은 사실을 같은 색으로 말한다.
 *   * `guidance` — 앞과 같은 `text-ink-muted`. 이 톤은 바뀌지 않았다: 길 안내는
 *     원래 이 격이 맞았고, 문제는 나머지 둘이 여기까지 내려와 있던 것이었다.
 *
 * `role`도 격을 따른다. 영수증만 `status` 다 — 방금 일어난 일을 보조기술에 알려야
 * 하는 것은 그 줄 하나이고, 나머지 둘은 화면에 서 있는 조건이지 방금 일어난 일이
 * 아니다.
 */
function ApprovalNoteLine({ note }: { note: ApprovalCardNote }) {
  const receipt = note.tone === "receipt";
  return (
    <p
      role={receipt ? "status" : undefined}
      data-testid={`approval-note-${note.kind}`}
      data-tone={note.tone}
      className={cn(
        "border-t border-line px-3 py-2",
        receipt && "text-body text-ink",
        note.tone === "blocked" && "text-meta text-warn",
        note.tone === "guidance" && "text-meta text-ink-muted"
      )}
    >
      {/* 인라인이고 `align-text-bottom`이다: flex로 세우면 두 줄로 접히는 문장에서
          아이콘이 첫 줄이 아니라 상자 전체를 기준으로 서고, 세로 오프셋을 손으로
          주는 것은 이 레포의 고정 스케일 밖 값이 된다(U4-4R W-1: 스케일 밖 클래스는
          컴파일되지 않는다). */}
      {receipt && (
        <Check
          className="mr-2 inline size-4 align-text-bottom"
          aria-hidden="true"
        />
      )}
      {note.text}
    </p>
  );
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
  const approvalsProvided = isSurfaceProvided("approvals");
  // 결정은 REST POST로 나간다. 「레일이 붙어 있는가」와 「이 요청이 나갈 수 있는가」는
  // 다른 질문이고, 승인에는 기한이 있으므로 후자를 물어야 한다 — 웹소켓이 잠깐
  // 끊겼다는 이유로 컨트롤을 감추면 할 수 있는 결정을 못 하고 만료될 수 있다.
  // 폰의 `useOnline.ts` 가 같은 판단을 NetInfo로 한다.
  const offline = useOffline();

  const status = resolveApprovalStatus(local?.status ?? null, card.status);
  const settled = status !== "pending";
  const decidedAtMs = local?.decidedAtMs ?? card.decidedAtMs;
  const decidedById = local?.decidedByMemberId ?? card.decidedByMemberId;
  const decidedBy = decidedById ? memberFor(directory, decidedById) : null;

  // 카드가 컨트롤 대신 말할 줄. 판정도 순서도 코어가 진다 (design-review M-3).
  // 이 파일이 삼항 사슬로 들고 있던 동안 폰이 자기 파일에 같은 사슬을 갖고 있었고,
  // **웹에는 오프라인 갈래가 아예 없었다** — 끊긴 채로 버튼이 서 있고 누르면 실패
  // 행 하나가 남았다.
  const note = approvalCardNote({
    receiptNote: local?.note ?? null,
    isResumeOffer: card.isResumeOffer,
    resumeOfferText: RESUME_OFFER_COPY,
    settled,
    hasTarget: card.approvalId !== null,
    // 이 표면은 대기 승인 목록을 구독하지 않는다(폰의 타임라인 카드는 한다).
    // 아는 것이 스냅샷뿐이므로, 스냅샷이 대기이면 여기서는 대기다.
    pendingHere: !settled,
    offline,
    approvalsProvided,
    unsupportedText: `${serverSurface("approvals").absentReason} ${
      serverSurface("approvals").fallback
    }`,
  });

  return (
    <CardFrame
      icon={<ShieldQuestion className="size-4" aria-hidden="true" />}
      title={card.title}
      chip={<ApprovalChip status={status} />}
      status={status}
      kind="approval"
      // 오프라인에서는 y/n 단축키도 꺼진다. 켜 두면 키가 무장까지 하고 확정이
      // 나가지 않는, 화면이 설명하지 못하는 상태가 만들어진다.
      keyboard={note === null}
      // 이슈 1114: `y`도 버튼과 같은 문을 지난다. 자격 있는 호스트가 없으면 승인은
      // 무장하지 않는다 — 단축키만 통과시키면 꺼진 버튼 옆에서 키보드로는 열리는,
      // 화면이 설명하지 못하는 두 번째 문이 생긴다. `n`은 그대로다.
      onApprove={() => {
        if (spawnHostGate(card.execution).canApprove) setArmed("approve");
      }}
      onReject={() => setArmed("reject")}
      detail={card.detail}
      footer={
        note !== null ? (
          <ApprovalNoteLine note={note} />
        ) : card.approvalId !== null ? (
          <ApprovalActions
            approvalId={card.approvalId}
            className="border-t border-line"
            armed={armed}
            setArmed={setArmed}
            execution={card.execution}
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
              next.note = decisionNote(outcome).text;
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
      // goal B8 H2: the message body is one Korean sentence for the reader
      // scrolling past, and this is the second layer for the one who stopped.
      // Folded, because "what do I do about it" is a question only some readers
      // are asking, and open by default it would be a paragraph on every failed
      // turn in the channel.
      note={
        card.failure && (
          // Ruled like the disclosure below it (`PayloadDisclosure`): two
          // sibling folds where only one carries a separator read as one
          // control and one stray line.
          <details className="border-t border-line" data-testid="turn-failure-detail">
            <summary className="cursor-pointer px-3 py-2 text-meta text-ink-muted hover:bg-surface-hover focus-visible:focus-ring">
              자세히
            </summary>
            {/* 실패 상세도 같은 예산을 쓴다 (진단 H-8: 「실패 상세도 별도
                무제한」). 프로바이더가 스택 트레이스를 통째로 보내는 경우가
                이 자리이고, 그때 이 접힘 하나가 카드 전체보다 길어진다. */}
            <div className="break-keep px-3 pb-2 text-meta text-ink-muted">
              <FoldedValue
                text={card.failure.detail}
                testId="turn-failure-fold"
              />
            </div>
          </details>
        )
      }
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
      {card.failure && card.status !== "stalled" && (
        // Our sentence, from the server's machine code. It replaces what used
        // to be the provider's own English error text under an 오류 label.
        <LabeledRow label="상태" testId="turn-failure">
          <span className="text-danger">{card.failure.label}</span>
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
      className="mt-2 max-w-pane-lg rounded-md border border-line bg-surface-raised focus-visible:focus-ring"
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

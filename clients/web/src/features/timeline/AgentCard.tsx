import { useState } from "react";
import {
  Check,
  ClipboardCheck,
  KeyRound,
  ShieldQuestion,
  Terminal,
  Zap,
} from "lucide-react";
import { Button } from "@/design/ui/button";
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
import {
  LOGIN_HANDOFF_DECISION,
  LOGIN_HANDOFF_DEPLOYMENT_COPY,
  loginHandoffNote,
  loginHandoffOutcomeDetail,
  loginHandoffStoppedCopy,
  loginHandoffWaitingCopy,
  type LoginHandoffCard,
  type LoginHandoffNote,
} from "@momo/core/features/timeline/loginHandoffCard";
import {
  COMPLETION_CHECK_OUTCOME_LABEL,
  COMPLETION_CHECK_TONE,
  COMPLETION_GATE_SURFACE_LABEL,
  completionCellChecks,
  completionCheckCounts,
  completionGateColumns,
  formatElapsed,
  WORKED_ELAPSED_LABEL,
  type CompletionCheck,
  type CompletionCheckOutcome,
  type CompletionReportCard,
} from "@momo/core/features/timeline/completionReportCard";
import { COMPLETION_TONE_CLASS } from "./completionTone";
import { spawnHostGate } from "@momo/core/features/timeline/spawnHostChoice";
import {
  ApprovalChip,
  CompletionReportChip,
  LoginHandoffChip,
  StreamCaret,
  TurnChip,
} from "./StatusChip";
import { ApprovalActions, type Armed } from "./ApprovalActions";
import { APPROVAL_NOTE_TONE_CLASS } from "./approvalNoteTone";
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
 * 격은 코어가 정하고(`APPROVAL_NOTE_TONE_ORDER`) 이 함수가 옷을 입힌다. **어느
 * 옷인지는 이 파일이 아니라 `approvalNoteTone.ts`가 답한다** (#1429): 그 표가
 * 코어의 역할(`APPROVAL_NOTE_TONE_SPEC`)을 이 팔레트의 토큰으로 옮기고,
 * `approvalNoteTone.test.ts`가 `tokens.css`를 파싱해 그 옮김이 옳은지 잰다.
 *
 *   * `receipt` — 본문 크기의 `text-ink`. 카드 안에서 크기로 올라오는 유일한
 *     문장이고, 그 이유는 이것이 **방금 내가 한 되돌릴 수 없는 행동의 기록**이기
 *     때문이다. 앞에 체크 아이콘이 서서 훑는 눈이 이 줄을 먼저 잡는다.
 *   * `blocked` — `text-warn`. 위험이 아니라 **때**의 문제이므로 danger가 아니고,
 *     조용한 안내에 묻히면 사람이 버튼을 계속 누르므로 muted도 아니다. 컴포저의
 *     오프라인 줄과 같은 톤이라 한 화면에서 두 자리가 같은 사실을 같은 색으로 말한다.
 *
 *     이 클라 **안에서만** 성립하는 논거다. 폰은 같은 톤을 본문 잉크로 그리고 그것도
 *     옳다 — 이 팔레트에서 「사람이 할 일이 남아 있다」를 지는 것은 `--accent`라
 *     `--warn`이 「안정 상태가 아니다」(저하·유동 포함 — thinking/streaming 턴 칩이
 *     그 사례)로 비어 있는 반면, 폰에서는 그 두 역할이
 *     `warn` 한 토큰에 겹친다. 판정과 근거는 코어 `approvalNote.ts` §색 계약.
 *   * `guidance` — 앞과 같은 `text-ink-muted`. 이 톤은 바뀌지 않았다: 길 안내는
 *     원래 이 격이 맞았고, 문제는 나머지 둘이 여기까지 내려와 있던 것이었다.
 *
 * `role`도 격을 따른다. 영수증만 `status` 다 — 방금 일어난 일을 보조기술에 알려야
 * 하는 것은 그 줄 하나이고, 나머지 둘은 화면에 서 있는 조건이지 방금 일어난 일이
 * 아니다.
 */
function ApprovalNoteLine({
  note,
  testIdPrefix = "approval-note",
}: {
  note: ApprovalCardNote | LoginHandoffNote;
  /**
   * 로그인 핸드오프 카드가 같은 격 체계를 쓰되 자기 이름으로 지목되게 한다.
   * 한 타임라인에 두 카드가 함께 서 있을 때 훅 하나가 두 요소에 답하면 안 된다
   * (`ApprovalActions`의 `testIdPrefix`와 같은 이유).
   */
  testIdPrefix?: string;
}) {
  const receipt = note.tone === "receipt";
  return (
    <p
      role={receipt ? "status" : undefined}
      data-testid={`${testIdPrefix}-${note.kind}`}
      data-tone={note.tone}
      className={cn(
        "border-t border-line px-3 py-2",
        APPROVAL_NOTE_TONE_CLASS[note.tone]
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

/**
 * 로그인 핸드오프 카드 (LIVE-4 / ADR-0004 증보 3).
 *
 * 승인 카드와 **같은 뼈대**를 쓴다: 같은 `CardFrame`, 같은 y/n 키 경로, 같은
 * 결정 컨트롤(`ApprovalActions`, 낱말만 재개/중단). 판정은 전부 코어가 지고
 * 이 파일은 옷만 입힌다.
 *
 * ## 어포던스 부재 원칙
 *
 * 이 빌드에는 채팅에서 화면을 여는 버튼이 없다. 그래서 그 자리에 **비활성
 * 버튼을 세우지 않고** 문장 하나만 둔다(`LOGIN_HANDOFF_DEPLOYMENT_COPY`).
 * 영원히 눌리지 않는 버튼은 사람에게 「내가 뭘 잘못했나」를 묻게 하고, 그것은
 * 화면이 거짓을 말하는 가장 조용한 형태다. 대신 실제로 있는 문 하나 — 작업 세션
 * 상세 — 는 진짜 버튼으로 서고, 그 세션 화면은 세션 상세가 그린다.
 */
function LoginHandoffBody({
  card,
  directory,
  onOpenWorkSession,
}: {
  card: LoginHandoffCard;
  directory: Directory;
  onOpenWorkSession?: (sessionId: string) => void;
}) {
  const [local, setLocal] = useState<{
    status: ApprovalStatus;
    decidedAtMs?: number;
    decidedByMemberId?: string;
    note?: string;
  } | null>(null);
  const [armed, setArmed] = useState<Armed>(null);
  const approvalsProvided = isSurfaceProvided("approvals");
  const offline = useOffline();

  // 로컬 영수증이 스냅샷보다 새로울 수 있는 것은 승인 카드와 같다. 다만 국면은
  // 코어가 정했으므로, 여기서는 **아직 대기인가**만 로컬로 뒤집는다.
  const settled = local !== null || card.phase !== "waiting";
  const underControl =
    card.control !== null && card.control.endedAtMs === null;
  const decidedById = local?.decidedByMemberId ?? card.decidedByMemberId;
  const decidedAtMs = local?.decidedAtMs ?? card.decidedAtMs;
  const decidedBy = decidedById ? memberFor(directory, decidedById) : null;

  // note 슬롯에 설 수 있는 두 조각. 이름을 붙여 두는 이유는 래퍼가 이 둘의 합을
  // 조건으로 져야 하기 때문이다 (아래 `note=`).
  const showDeployment = !settled;
  const showOpenSession =
    card.sessionId !== null && onOpenWorkSession !== undefined;

  const note = loginHandoffNote({
    receiptNote: local?.note ?? null,
    hasTarget: card.approvalId !== null,
    settled,
    underControl,
    decidableHere: true,
    offline,
    approvalsProvided,
    unsupportedText: `${serverSurface("approvals").absentReason} ${
      serverSurface("approvals").fallback
    }`,
  });

  return (
    <CardFrame
      icon={<KeyRound className="size-4" aria-hidden="true" />}
      title={card.title}
      chip={<LoginHandoffChip card={card} />}
      status={card.outcome ?? card.phase}
      kind="login_handoff"
      keyboard={note === null && !settled}
      onApprove={() => setArmed("approve")}
      onReject={() => setArmed("reject")}
      detail={card.detail}
      // 슬롯 **자체가** 조건을 진다 (design-review L1). 안의 두 조각이 모두
      // 조건부인데 래퍼만 무조건이면, 끝난 카드에 세션 딥링크까지 없을 때
      // `border-t` 와 `py-2` 만 남아 아무것도 말하지 않는 띠가 선다 — 카드에
      // 한 줄이 더 있다고 읽히는데 읽을 것이 없다.
      note={
        showDeployment || showOpenSession ? (
          <div className="border-t border-line px-3 py-2">
            {showDeployment && (
              <p
                className="text-meta text-ink-muted"
                data-testid="handoff-deployment"
              >
                {LOGIN_HANDOFF_DEPLOYMENT_COPY}
              </p>
            )}
            {showOpenSession && (
              // 수제 컨트롤이었다 (design-review H1): 경계가 `--line` 이라
              // surface 위 1.32/1.43:1 로 WCAG 1.4.11 의 3:1 에 못 미쳤다.
              // `outline` 변형이 같은 모양으로 `--line-strong`(3.59/3.56:1)을
              // 들고 있고, 프리미티브에 없어서 남긴 것은 위 여백 하나뿐이다.
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                data-testid="handoff-open-session"
                onClick={() => onOpenWorkSession?.(card.sessionId!)}
              >
                작업 세션 열기
              </Button>
            )}
          </div>
        ) : null
      }
      footer={
        note !== null ? (
          <ApprovalNoteLine note={note} testIdPrefix="handoff-note" />
        ) : card.approvalId !== null && !settled ? (
          <ApprovalActions
            approvalId={card.approvalId}
            className="border-t border-line"
            armed={armed}
            setArmed={setArmed}
            testIdPrefix="handoff"
            lead={LOGIN_HANDOFF_DECISION.lead}
            verbs={{
              approve: LOGIN_HANDOFF_DECISION.resume,
              reject: LOGIN_HANDOFF_DECISION.stop,
              approveCommit: LOGIN_HANDOFF_DECISION.resumeCommit,
              rejectCommit: LOGIN_HANDOFF_DECISION.stopCommit,
              approveConfirm: LOGIN_HANDOFF_DECISION.resumeConfirm,
              rejectConfirm: LOGIN_HANDOFF_DECISION.stopConfirm,
            }}
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
      {card.reason && <LabeledRow label="사유">{card.reason}</LabeledRow>}
      {!settled && (
        <LabeledRow label="상태" testId="handoff-waiting">
          {/* 창이 이미 닫혔는데 아직 대기인 갈래에서 한 문장이 더 붙는다
              (freeze M1). 국면은 승인 원장의 것이라 뒤집지 않고, 화면이
              「지금도 조작 중」이라고 읽히는 것만 막는다. 문장도 조건도
              코어가 답한다. */}
          {loginHandoffWaitingCopy(card)}
        </LabeledRow>
      )}
      {/* 경계 사실. 증보 3 D3이 에이전트에게 허락한 것과 같은 것만 그린다 —
          정지 시각, 재개 시각, 그리고 어떻게 끝났는지. 프레임도 키도 여기 없고,
          담을 칸조차 없다는 것이 이 세 행의 뜻이다. */}
      {card.control !== null && (
        <LabeledRow label="정지" testId="handoff-control-started">
          <span data-numeric>{timeLabel(card.control.startedAtMs)}</span>
        </LabeledRow>
      )}
      {card.control?.endedAtMs != null && (
        <LabeledRow label="재개" testId="handoff-control-ended">
          <span data-numeric>{timeLabel(card.control.endedAtMs)}</span>
        </LabeledRow>
      )}
      {/* 「지금 누가 잡고 있다」는 행이 여기 있었고, 지웠다.
          컨트롤 자리에 서는 `in-control` 줄이 같은 사실을 이미 말하고,
          거기에 **다음에 무엇을 하면 되는지**까지 붙는다. 한 카드가 같은
          사실을 두 번 말하면 읽는 사람은 두 가지가 일어났다고 읽는다. */}
      {card.outcome !== null && (
        <LabeledRow label="결과" testId="handoff-outcome">
          {/* 표를 그대로 인덱싱하지 않는다 (freeze M2): 창 없이 `returned` 인
              카드는 「화면을 돌려주었습니다」라고 말할 수 없다 — 이 배포에서는
              아무도 잡은 적이 없고, 실행기가 모델에게 하는 말도 그렇다. */}
          {loginHandoffOutcomeDetail(card)}
        </LabeledRow>
      )}
      {card.phase === "stopped" && (
        <LabeledRow label="결과" testId="handoff-stopped">
          {/* 「실패」가 아니다. 사람이 멈춘 것은 사고가 아니므로 danger를 입지
              않는다 (ADR-0132의 규칙, 침묵과 같은 계열).

              문장도 조건도 코어가 답한다 (design-review H2·M1). 앞 판은 두
              문장을 인라인으로 붙여 두었고, 그래서 창이 있었던 stopped 카드에서
              바로 윗줄의 「정지」 행과 모순됐다. */}
          {loginHandoffStoppedCopy(card)}
        </LabeledRow>
      )}
      {settled && (decidedBy || decidedAtMs !== undefined) && (
        <LabeledRow label="결정" testId="handoff-ledger">
          <span data-numeric>
            {[
              decidedBy?.displayName,
              decidedAtMs !== undefined ? timeLabel(decidedAtMs) : null,
              card.approvalId ? `원장 #${ledgerHandle(card.approvalId)}` : null,
            ]
              .filter((part): part is string => Boolean(part))
              .join(" · ")}
          </span>
        </LabeledRow>
      )}
    </CardFrame>
  );
}

/**
 * 한 칸의 결과. 세부(`896 통과`)가 있으면 그것이 글자이고, 없으면 결과 낱말(`통과`)
 * 이 선다. 색은 결과가 지고, 세부가 낱말을 대신할 때는 보조기술을 위해 결과 낱말을
 * 숨은 글자로 함께 싣는다 — 「896 통과」만 읽어서는 통과인지 실패인지 소리로 알 수
 * 없기 때문이다.
 *
 * `<td>` 가 아니라 값(`<span>`) 하나다: 한 (표면,라벨) 셀에 겹친 칸이 여럿일 수
 * 있어(중복 라벨), 그것들이 **한 칸 안에 쌓인다**(H1). `data-outcome` 은 각 값에
 * 붙어 실패 칸이 초록에 접혀 사라지지 않는다.
 */
function GateCellValue({ check }: { check: CompletionCheck }) {
  const toneClass = COMPLETION_TONE_CLASS[COMPLETION_CHECK_TONE[check.outcome]];
  const label = COMPLETION_CHECK_OUTCOME_LABEL[check.outcome];
  return (
    <span className="block" data-outcome={check.outcome}>
      <span className={cn("text-meta", toneClass)}>{check.detail ?? label}</span>
      {check.detail !== undefined && <span className="sr-only"> {label}</span>}
    </span>
  );
}

/**
 * 표면 × 게이트 표. 커서 벤치마크의 「Surface × Lint/Test/Build/Run」을 우리
 * 원장에 실린 표면별 게이트 목록에서 재구성한다. 열(`completionGateColumns`)은
 * **처음 본 순서**의 게이트 이름 합집합이고, 어떤 표면이 그 게이트를 안 돌렸으면
 * 칸은 가운뎃점 하나로 비운다(없는 결과를 통과로도 실패로도 짓지 않는다).
 *
 * 한 (표면,라벨)에 칸이 여럿이면(중복 라벨) `completionCellChecks` 가 **전부**
 * 돌려주고 이 셀이 그것들을 쌓는다 — 최악 톤이 앞이라 실패가 절대 접히지 않는다
 * (H1). 열·셀 판정을 코어가 지므로 웹 표가 폰·집계와 같은 칸 집합을 그린다.
 *
 * 넓어질 수 있는 표라 자기 컨테이너 안에서 가로로 스크롤한다 — 페이지 몸통은
 * 절대 가로로 밀리지 않는다(design-taste-web 반응형 규칙).
 */
function CompletionGateTable({ card }: { card: CompletionReportCard }) {
  const columns = completionGateColumns(card.gates);
  const counts = completionCheckCounts(card.gates);
  const tally: Array<{ outcome: CompletionCheckOutcome; count: number }> = (
    ["pass", "fail", "skip", "pending", "unknown"] as CompletionCheckOutcome[]
  )
    .map((outcome) => ({ outcome, count: counts[outcome] }))
    .filter((entry) => entry.count > 0);
  // 상한에 걸려 그리지 않은 것들(M3). 조용히 자르지 않고 개수를 말한다.
  const omittedParts: string[] = [];
  if (card.omitted.gates > 0)
    omittedParts.push(`표면 ${formatCount(card.omitted.gates)}개 더`);
  if (card.omitted.checks > 0)
    omittedParts.push(`게이트 ${formatCount(card.omitted.checks)}개 더`);

  return (
    <div className="border-t border-line" data-testid="completion-gates">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th
                scope="col"
                className="px-3 py-1 text-left text-meta font-medium text-ink-muted"
              >
                {COMPLETION_GATE_SURFACE_LABEL}
              </th>
              {columns.map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="px-3 py-1 text-left text-meta font-medium text-ink-muted"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {card.gates.map((row, rowIndex) => (
              // 표면 이름이 겹쳐도 key 가 충돌하지 않게 index 를 함께 짠다(H1).
              <tr
                key={`${row.surface}::${rowIndex}`}
                data-testid="completion-gate-row"
              >
                <th
                  scope="row"
                  className="px-3 py-1 text-left text-body font-medium text-ink"
                >
                  {row.surface}
                </th>
                {columns.map((col) => {
                  const cellChecks = completionCellChecks(row, col);
                  if (cellChecks.length === 0) {
                    return (
                      <td
                        key={col}
                        className="px-3 py-1 text-meta text-ink-muted"
                        aria-hidden="true"
                      >
                        ·
                      </td>
                    );
                  }
                  return (
                    <td key={col} className="px-3 py-1 align-baseline">
                      {/* 겹친 칸은 한 셀 안에서 한 줄씩 쌓인다. 틈은 닫힌 간격
                          스케일의 1px 실선(`gap-px`)이다 — `gap-0.5`(2px)는 스케일
                          밖이라 `--spacing: initial` 아래서 조용히 0px 로 죽는다. */}
                      <span className="flex flex-col gap-px">
                        {cellChecks.map((check, i) => (
                          <GateCellValue
                            key={`${row.surface}::${col}::${i}`}
                            check={check}
                          />
                        ))}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tally.length > 0 && (
        <p className="px-3 py-2 text-meta text-ink-muted" data-testid="completion-tally">
          {tally.map((entry, index) => (
            <span key={entry.outcome}>
              {index > 0 && " · "}
              {COMPLETION_CHECK_OUTCOME_LABEL[entry.outcome]}{" "}
              <span data-numeric>{formatCount(entry.count)}</span>
            </span>
          ))}
        </p>
      )}
      {omittedParts.length > 0 && (
        <p
          className="px-3 pb-2 text-meta text-ink-muted"
          data-testid="completion-omitted"
        >
          {omittedParts.join(" · ")}
        </p>
      )}
    </div>
  );
}

/**
 * 작업 완료 리포트 카드 (UXC-A / 커서 웹 ADE 벤치마크 §3-A).
 *
 * 에이전트가 긴 작업을 끝내고 자기가 무엇을 했는지 설명하는 카드다. 승인 카드
 * 가족의 `CardFrame` 을 그대로 쓰되 결정 컨트롤이 없다 — 끝난 일의 기록이라
 * 승인·거부할 것이 없다. 그래서 키보드 y/n 도, footer 도 서지 않는다.
 *
 * 읽는 순서는 벤치마크 그대로다: ①한 문단 요약 ②경과 시간 ③무엇을 했는가(왜까지)
 * ④표면×게이트 표. 판정은 전부 코어가 지고(요약/불릿/표는 파싱, 결과는 집계) 이
 * 파일은 옷만 입힌다.
 */
function CompletionReportBody({ card }: { card: CompletionReportCard }) {
  const elapsed = card.elapsedMs !== undefined ? formatElapsed(card.elapsedMs) : "";
  return (
    <CardFrame
      icon={<ClipboardCheck className="size-4" aria-hidden="true" />}
      title={card.title}
      chip={<CompletionReportChip outcome={card.outcome} />}
      status={card.outcome}
      kind="completion_report"
      detail={card.detail}
      // 표는 <dl> 밖에 서야 유효한 HTML 이다(테이블은 dl 안에 들 수 없다). note
      // 슬롯이 정확히 그 자리다 — dl(요약·시간·불릿) 다음, 숨김 개수 앞.
      note={card.gates.length > 0 ? <CompletionGateTable card={card} /> : null}
    >
      {card.summary && (
        <LabeledRow label="요약" testId="completion-summary">
          {card.summary}
        </LabeledRow>
      )}
      {elapsed !== "" && (
        // 성과의 단위(벤치마크 차용 C). 숫자와 한글 단위가 섞이므로 자릿폭 고정을
        // 걸지 않는다 — 걸면 음절 사이가 벌어진다(코어 `formatElapsed` 독스트링).
        // 낱말은 코어의 것이다: 작업 세션 정보의 같은 줄이 같은 상수를 쓴다(#1468).
        <LabeledRow label={WORKED_ELAPSED_LABEL} testId="completion-elapsed">
          {elapsed}
        </LabeledRow>
      )}
      {card.actions.length > 0 && (
        <LabeledRow label="한 일" testId="completion-actions">
          <ul className="list-disc space-y-1 pl-4 marker:text-ink-muted">
            {card.actions.map((action, index) => (
              <li key={index}>
                {action.text}
                {action.note && (
                  // 왜. 커서의 「pinned 1.83 couldn't build it」 자리다. 가장 조용한
                  // 격으로 — 읽으면 좋고 안 읽어도 무엇을 했는지는 위 줄이 말한다.
                  <span className="mt-px block text-meta text-ink-muted">
                    {action.note}
                  </span>
                )}
              </li>
            ))}
            {card.omitted.actions > 0 && (
              // 상한에 걸려 그리지 않은 불릿(M3). 조용히 자르지 않는다.
              <li className="text-ink-muted" data-testid="completion-actions-omitted">
                그 밖에 {formatCount(card.omitted.actions)}개 더
              </li>
            )}
          </ul>
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
  onOpenWorkSession,
}: {
  card: AgentCardModel;
  directory: Directory;
  /**
   * 작업 세션 상세로 가는 문. 로그인 핸드오프 카드만 쓴다. 없으면 딥링크 자체가
   * 그려지지 않는다 — 없는 방으로 가는 문을 그리지 않는다는 이 레포의 규율.
   */
  onOpenWorkSession?: (sessionId: string) => void;
}) {
  if (card.kind === "approval") {
    return <ApprovalBody card={card} directory={directory} />;
  }
  if (card.kind === "login_handoff") {
    return (
      <LoginHandoffBody
        card={card}
        directory={directory}
        {...(onOpenWorkSession !== undefined ? { onOpenWorkSession } : {})}
      />
    );
  }
  if (card.kind === "completion_report") {
    return <CompletionReportBody card={card} />;
  }
  if (card.kind === "tool") return <ToolBody card={card} />;
  return <TurnBody card={card} />;
}

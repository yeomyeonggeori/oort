import { Check, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import type { FeedItem } from "@momo/core/features/inbox/model";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import {
  WORK_JOBS_COPY,
  type WorkJobResultKind,
  type WorkJobRow,
} from "@momo/core/features/workbench/workJobs";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useApprovalBlockedLine } from "@/features/common/blockedLines";
import { CHIP_CLASS } from "@/features/common/chip";
import { useOffline } from "@/features/common/useOffline";
import { inboxTargetPath } from "@/features/inbox/anchor";
import { InboxApprovalActions } from "@/features/inbox/InboxApprovalActions";
import { approvalRowControl, awaitedApprovalId, settledStatusLine } from "@/features/inbox/approvalsPanel";
import type { DecidableApproval } from "@/features/inbox/useNeedsMe";
import { useSettledApproval } from "@/features/timeline/settledApprovals";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { ApprovalCardLink, JobPrLink, ReportedTag } from "./WorkJobParts";

// =============================================================================
// 「작업」 줄의 결과 칸 (ADR-0202 D1, 증보 2026-11-11 #5640).
//
// 한 작업 = 한 덩어리. 결과 칸 머리의 꼬리표가 이 줄이 무엇을 말하는지 먼저 말한다(owner 2026-11-11): 「승인 요청」 · 「권한 요청」 ·
// 「에이전트 보고」, 꼬리표 없는 PR 번호 · 「결과 없음」. 종류는 코어 `workJobResultKind` 한 판정이다. 꼬리표 아래 내용은 서버가 준 사실
// 그대로다(승인 원장의 행·서버가 쓴 카드 문장). 서버가 안 준 것은 지어내지 않는다: 맥 세션의 권한 요청은 목록 응답에 도구·미리보기가
// 없어서(#5639 계약) 내용 없이 꼬리표만 서고, 답은 그 세션의 승인 카드에서 한다.
//
// 칸은 두 층이다. 줄 단추 안의 글(`JobResultCell`)과, 단추 밖에 같은 열로 내려앉는 컨트롤(`JobResultActions`: 승인·거부, 열기, 카드
// 링크, PR 링크). 단추 안에 단추를 둘 수 없어서 나뉘지만 같은 열·같은 덩어리 안에 선다.
//
// 그 자리 결정(ADR-0202 증보 2026-11-11): 「응답 필요」 구간의 내 run 줄에서, 그 승인의 결정자 본인에게만 인박스·대화 카드와 **같은 결정
// 부품**(`InboxApprovalActions` → `ApprovalActions`: 같은 원장·같은 라우트·같은 영수증)을 세운다. 자격은 인박스 한 판정
// (`approvalRowControl`)이고, 화면이 다시 계산하지 않는다. 카드를 열어서 결정하는 승인(`open`)은 「열기」 하나다.
// =============================================================================

/** 승인 요청 줄이 아는 사실(호출자가 원장·run 진행에서 모은다). */
export interface JobApprovalFacts {
  /**
   * 이 줄에서 내가 결정할 승인(인박스와 같은 판정, 서버가 「못 한다」고 한 것은 빠졌다). 「응답 필요」 구간의 줄에만 있다 — 없으면 이 줄에
   * 단추가 서지 않는다.
   */
  decision: DecidableApproval | null;
  /** 그 승인의 원장 행(인박스가 그리는 행). 내용 요약·기한의 재료다. 원장의 내 결정 목록에 없으면 null. */
  item: FeedItem | null;
  /** 서버가 쓴 카드 문장(run 진행 bundle의 `intent`, 대기 중에만). 모르면 null. */
  intent: string | null;
  /** 결정자가 아닐 때의 대기 줄(카드와 같은 문장). 원장이 아직 답하지 않았으면 null — 「원장에 없다」를 지어내지 않는다. */
  waiting: string | null;
  /**
   * 방금 이 줄에서 결정해 그 자리에 붙든 동안의 영수증(받은함과 같은 「승인을 기록했어요.」·「거부를 기록했어요.」, 수리 4회차). 있으면
   * 결과 칸은 이 한 줄이 먼저다. `decision`이 없으면 이 한 줄뿐이다(결정 전의 꼬리표·되돌릴 수 없음·만료를 말하지 않는다).
   */
  receipt: string | null;
  /**
   * 붙든 줄에 같은 run의 새 요청이 섰을 때 그 요청의 원장 행과 카드 문장(수리 5회차 M3). 새 요청은 영수증 **아래 새 줄**에 서고(`decision`이
   * 그 요청), 누른 자리에는 영수증이 남는다.
   */
  nextAsk?: { item: FeedItem | null; intent: string | null } | null;
}

/**
 * 영수증 한 줄. `asControl`이면 결정 단추가 서 있던 층에 **단추와 같은 높이**로 선다(`InboxApprovalActions`의 `py-1` + 단추 `h-control-sm`,
 * 좁은 폭은 손가락 44px `tap-target`) — 누른 자리에 결과가 서고 줄 높이가 바뀌지 않는다.
 */
function ReceiptLine({ text, asControl = false }: { text: string; asControl?: boolean }) {
  const line = (
    <span
      className={cn(
        "min-w-0 break-keep text-meta text-ink",
        asControl && "flex min-h-control-sm tap-target items-center"
      )}
      data-testid="work-job-approval-settled"
    >
      <Check className="me-1 inline size-4 shrink-0 align-text-bottom" aria-hidden="true" />
      {text}
    </span>
  );
  return asControl ? <span className="flex py-1">{line}</span> : line;
}

type RowControl = ReturnType<typeof approvalRowControl>;

/** 결정 컨트롤이 그 줄의 승인·거부인가(카드를 열어 결정하는 「열기」·끊김·영수증이 아니다). */
function decidesHere(control: RowControl): boolean {
  return control.kind === "decide";
}

/**
 * 이 승인을 목록의 그 줄에서 바로 결정하는가(승인·거부가 선다). 서랍이 「승인은 그 카드에서 해요」 대신 사실을 말하는 데 쓴다
 * (#5640 수리 3회차, 검수 질문 ③). 끊김은 묻지 않는다 — 배지와 같이 할 일이 사라지지 않는다.
 */
// eslint-disable-next-line react-refresh/only-export-components -- 결과 칸과 한 판정을 나누는 함수다(서랍이 같은 판정을 읽는다).
export function decidesInRow(decision: DecidableApproval): boolean {
  return decidesHere(approvalRowControl(decision.item, { offline: false }));
}

function KindTag({ label, testId }: { label: string; testId: string }) {
  return (
    <span
      className={cn(CHIP_CLASS, "inline-flex shrink-0 items-center gap-1 self-start bg-muted-soft text-ink")}
      data-testid={testId}
    >
      <ShieldCheck aria-hidden className="size-3 shrink-0 text-warn" />
      {label}
    </span>
  );
}

/** 승인 요청 한 건이 말하는 줄들: 꼬리표 · 무엇을 승인하는가 · 되돌릴 수 없음 · 기한 · (결정자가 아니면) 대기 줄. */
function ApprovalAskLines({ item, intent, waiting }: { item: FeedItem | null; intent: string | null; waiting: string | null }) {
  const formatMessage = useFormatMessage();
  // 무엇을 승인하는가: 서버가 쓴 카드 문장이 먼저, 없으면 원장 행의 문장(인박스 행과 같은 말). 둘 다 없으면 꼬리표만.
  const summary = intent ?? item?.predicate ?? null;
  const note = item?.note ?? null;
  const timeLabel = item?.timeLabel ?? null;
  return (
    <>
      <KindTag label={formatMessage("desktop.workJobs.tagApproval")} testId="work-job-approval-tag" />
      {summary !== null && (
        <span className="min-w-0 break-keep text-meta text-ink" data-testid="work-job-approval-summary">
          {summary}
        </span>
      )}
      {/* 「되돌릴 수 없음」은 받은함(`InboxDetail`의 `text-meta text-warn`)과 같은 무게로 따로 선다 — 한 번 누르면 끝나는 단추 바로 위다
          (#5640 수리 3회차, 검수 M5). 기한은 옅은 글자 그대로. */}
      {note !== null && (
        <span className="min-w-0 break-keep text-meta text-warn" data-testid="work-job-approval-note">
          {note}
        </span>
      )}
      {timeLabel !== null && <span className="min-w-0 break-keep text-timestamp text-ink-muted">{timeLabel}</span>}
      {waiting !== null && (
        <span className="min-w-0 break-keep text-timestamp text-ink-muted" data-testid="work-job-approval-waiting">
          {waiting}
        </span>
      )}
    </>
  );
}

/**
 * 줄 단추 안의 결과 칸 글. 좁은 폭에서는 같은 글이 첫 열 아래(`data-narrow`)에도 선다 — 상태가 없는 글이라 두 번 그려도 갈라지지 않는다.
 */
export function JobResultCell({
  row,
  kind,
  reported,
  approval,
  inApp,
}: {
  row: WorkJobRow;
  kind: WorkJobResultKind;
  reported: string | null;
  approval: JobApprovalFacts | null;
  /** 권한 요청 줄, 브라우저에서만: 허락을 보낼 곳(폰·데스크탑 앱). */
  inApp: string | null;
}) {
  const formatMessage = useFormatMessage();
  if (kind === "approval" && approval?.receipt) {
    // 붙든 줄(방금 결정함)은 결정된 모습만 말한다(수리 4회차, 검수 2회차 M2): 꼬리표·되돌릴 수 없음·만료는 걷고 무엇을 결정했는지(요약)만
    // 남긴다. 걷은 줄의 자리는 비워 둔다 — 줄 높이가 그대로라 누른 점 밑으로 다른 줄이 올라오지 않는다. 영수증은 단추가 있던 층에 선다.
    // 같은 run의 새 요청이 와도 이 칸은 그대로다(새 요청은 영수증 아래 새 줄, `JobResultActions`).
    const item = approval.item;
    const summary = approval.intent ?? item?.predicate ?? null;
    return (
      <span className="flex min-w-0 flex-col gap-1" data-testid="work-job-result" data-kind={kind} data-held="">
        <span aria-hidden className={cn(CHIP_CLASS, "invisible inline-flex shrink-0 items-center gap-1 self-start")}>
          <ShieldCheck className="size-3 shrink-0" />
          {formatMessage("desktop.workJobs.tagApproval")}
        </span>
        {summary !== null && <span className="min-w-0 break-keep text-meta text-ink">{summary}</span>}
        {item?.note && (
          <span aria-hidden className="invisible min-w-0 break-keep text-meta">
            {item.note}
          </span>
        )}
        {item?.timeLabel && (
          <span aria-hidden className="invisible min-w-0 break-keep text-timestamp">
            {item.timeLabel}
          </span>
        )}
      </span>
    );
  }
  if (kind === "approval") {
    return (
      <span className="flex min-w-0 flex-col gap-1" data-testid="work-job-result" data-kind={kind}>
        <ApprovalAskLines item={approval?.item ?? null} intent={approval?.intent ?? null} waiting={approval?.waiting ?? null} />
      </span>
    );
  }
  if (kind === "permission") {
    return (
      <span className="flex min-w-0 flex-col gap-1" data-testid="work-job-result" data-kind={kind}>
        <KindTag label={formatMessage("desktop.workJobs.tagPermission")} testId="work-job-permission-tag" />
        {inApp !== null && (
          <span className="min-w-0 break-keep text-timestamp text-ink-muted" data-testid="work-job-permission-in-app">
            {inApp}
          </span>
        )}
      </span>
    );
  }
  if (kind === "reported" && reported !== null) {
    return (
      <span
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
        data-testid="work-job-result"
        data-kind={kind}
        title={formatMessage("desktop.workJobs.reportedTitle", { summary: reported })}
      >
        <ReportedTag />
        <span className="min-w-0 break-keep text-meta text-ink">{reported}</span>
      </span>
    );
  }
  if (kind === "pr" && row.pr !== null) {
    return (
      <span className="min-w-0 truncate text-meta text-ink" data-testid="work-job-result" data-kind={kind}>
        {row.pr.number}
      </span>
    );
  }
  return (
    <span className="min-w-0 truncate text-meta text-ink-muted" data-testid="work-job-result" data-kind="none">
      {row.finished ? WORK_JOBS_COPY.noResultReported : WORK_JOBS_COPY.noResultYet}
    </span>
  );
}

/**
 * 결과 칸 아래층의 컨트롤. 줄 단추 밖이라 단추 안에 단추가 생기지 않는다.
 *
 * - 승인 요청, 내가 결정자: 인박스와 같은 판정(`approvalRowControl`)이 준 컨트롤 — 승인·거부(`decide`), 카드를 열어서 결정하는 승인은
 *   「열기」(`open`), 끊겼으면 막힌 이유 한 줄, 이 클라이언트가 이미 결정했으면 영수증 한 줄.
 * - 승인 요청, 결정자가 아님: 그 카드로 가는 링크만(대기 줄은 위 칸이 말한다).
 * - 권한 요청, 데스크탑 앱: 「열어서 답하기」 하나 — 줄의 Enter와 같은 길(그 세션의 칸을 열고 승인 카드에 초점). 목록이 요청 내용을
 *   싣지 않아 내용 없이 허락 단추를 세우지 않는다. 브라우저에는 컨트롤이 없다(위 칸의 안내 한 줄).
 * - PR이 있으면 PR 링크.
 */
export function JobResultActions({
  row,
  kind,
  approval,
  desktop,
  onOpenPermission,
  onDecided,
  focusRow,
}: {
  row: WorkJobRow;
  kind: WorkJobResultKind;
  approval: JobApprovalFacts | null;
  desktop: boolean;
  onOpenPermission: () => void;
  onDecided: (outcome: DecisionOutcome, approvalId: string) => void;
  /** 결정이 닿아 눌린 단추가 사라질 때 캐럿을 받을 줄 단추. */
  focusRow: () => void;
}) {
  const formatMessage = useFormatMessage();
  return (
    <span className="flex min-w-0 flex-col items-start gap-1" data-testid="work-job-actions">
      {kind === "approval" &&
        (approval?.receipt ? (
          <>
            <ReceiptLine text={approval.receipt} asControl />
            {approval.decision && (
              // 같은 run의 새 요청(수리 5회차 M3): 방금 누른 자리에는 영수증이 남고, 새 요청과 그 단추는 영수증 **아래 새 줄**에 선다.
              <span className="flex min-w-0 flex-col items-start gap-1 pt-1" data-testid="work-job-next-ask">
                <ApprovalAskLines
                  item={approval.nextAsk?.item ?? approval.decision.item}
                  intent={approval.nextAsk?.intent ?? null}
                  waiting={null}
                />
                <JobDecision title={row.title} decision={approval.decision} onDecided={onDecided} focusRow={focusRow} />
              </span>
            )}
          </>
        ) : approval?.decision ? (
          <JobDecision
            title={row.title}
            decision={approval.decision}
            onDecided={onDecided}
            focusRow={focusRow}
          />
        ) : (
          <ApprovalCardLink channelId={row.channelId} channel={row.channel} />
        ))}
      {kind === "permission" && desktop && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onOpenPermission}
          data-testid="work-job-permission-open"
        >
          {formatMessage("desktop.workJobs.openToAnswer")}
        </Button>
      )}
      {row.pr !== null && <JobPrLink pr={row.pr} />}
    </span>
  );
}

function JobDecision({
  title,
  decision,
  onDecided,
  focusRow,
}: {
  title: string;
  decision: DecidableApproval;
  onDecided: (outcome: DecisionOutcome, approvalId: string) => void;
  focusRow: () => void;
}) {
  const formatMessage = useFormatMessage();
  const offline = useOffline();
  const blockedLine = useApprovalBlockedLine();
  // 이 클라이언트가 이미 결정한 승인(#5092): 원장이 다시 답하기 전에도 같은 `approvalId`를 들고 있는 동안 두 번째 결정이 나가지 않게
  // 컨트롤 대신 영수증이 선다 — 받은함 상세(`InboxDetail`)와 같은 판정·같은 문장.
  const receipt = useSettledApproval(decision.approvalId);
  const settledLine = receipt === null ? null : settledStatusLine(receipt.status);
  const control = approvalRowControl(decision.item, { offline, settled: settledLine !== null });
  const decideHere = decidesHere(control);
  const awaited = awaitedApprovalId(control);
  // 열기를 `kind === "open"`으로 묻지 않는 것은 받은함과 같은 이유다(직접 문구 장부가 영어 낱말 리터럴도 센다): id를 싣는데 `decide`가 아니면 열기다.
  const opensOnCard = !decideHere && awaited !== null;
  if (decideHere && awaited !== null) {
    return (
      <InboxApprovalActions
        approvalId={awaited}
        execution={decision.item.execution}
        lead=""
        className="px-0 py-1"
        testIdPrefix="work-job-approval"
        decisionLabel={title}
        onSettled={(outcome) => {
          // 눌린 단추는 이 렌더에서 영수증 줄로 바뀌며 사라진다. 캐럿이 body로 떨어지지 않게 그 줄이 받는다.
          focusRow();
          onDecided(outcome, awaited);
        }}
      />
    );
  }
  if (opensOnCard) {
    return (
      <Button asChild size="sm" variant="secondary">
        <Link
          to={inboxTargetPath(decision.item)}
          data-testid="work-job-approval-open"
        >
          {formatMessage("inbox.approval.open")}
        </Link>
      </Button>
    );
  }
  if (settledLine !== null) {
    return (
      <p className="text-meta text-ink" data-testid="work-job-approval-settled">
        <Check className="me-1 inline size-4 align-text-bottom" aria-hidden="true" />
        {settledLine}
      </p>
    );
  }
  if (control.kind === "offline") {
    return (
      <p className="break-keep text-meta text-ink-muted" data-testid="work-job-approval-offline">
        {blockedLine}
      </p>
    );
  }
  return null;
}

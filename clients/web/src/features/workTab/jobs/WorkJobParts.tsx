import { Bot, GitPullRequest, ShieldCheck } from "lucide-react";
import type { AgentReportedResult } from "@momo/core/lib/api";
import {
  WORK_JOBS_COPY,
  nextActionText,
  resultKindText,
  testsText,
  toolCountsText,
} from "@momo/core/features/workbench/workJobs";
import { Link } from "react-router-dom";
import { CHIP_CLASS } from "@/features/common/chip";
import { cn } from "@/design/lib/cn";
import { isDesktop, openExternalUrl } from "@/lib/tauri";

// =============================================================================
// 「작업」 줄과 서랍이 같이 쓰는 작은 부분 (ADR-0202 D1, U1 #3842).
//
// 에이전트가 스스로 알린 결과(ADR-0162 증보 5 C1·C2)는 **언제나 「에이전트 보고」 꼬리표와
// 함께** 그린다. 서버가 잰 사실(PR 주소 모양 검증, diff 숫자)과 같은 칸에 섞지 않는다: 꼬리표가
// 붙은 덩어리만이 에이전트의 말이다.
// =============================================================================

export function ReportedTag() {
  return (
    <span
      className={cn(CHIP_CLASS, "inline-flex shrink-0 items-center gap-1 bg-muted-soft font-medium text-ink")}
      data-testid="work-job-reported-tag"
    >
      <Bot aria-hidden className="size-3 shrink-0" />
      {WORK_JOBS_COPY.reportedTag}
    </span>
  );
}

/** 서랍의 「에이전트 보고」 절: 닫힌 칸만 키-값으로. 값은 서버가 닫힌 목록으로 검증한 것뿐이다. */
export function ReportedFacts({ reported }: { reported: AgentReportedResult }) {
  const rows: [string, string][] = [];
  if (reported.resultKind !== null) rows.push(["한 일", resultKindText(reported.resultKind)]);
  if (reported.tests !== null) rows.push(["테스트", testsText(reported.tests)]);
  if (reported.nextAction !== null) {
    const next = nextActionText(reported.nextAction);
    if (next !== null) rows.push(["다음 할 일", next]);
  }
  if (reported.commitSha !== null) rows.push(["커밋", reported.commitSha.slice(0, 12)]);
  if (reported.toolCounts !== null) rows.push(["작업 환경 안", toolCountsText(reported.toolCounts)]);
  return (
    <section aria-labelledby="work-job-reported" data-testid="work-job-reported">
      <h3
        id="work-job-reported"
        className="flex items-center gap-2 px-4 pt-3 pb-1 text-meta font-semibold text-ink-muted"
      >
        <ReportedTag />
        <span className="font-normal">에이전트가 스스로 알린 값이에요</span>
      </h3>
      <dl className="flex flex-col gap-1 px-4 pb-2 text-body">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-baseline gap-3">
            <dt className="shrink-0 text-meta text-ink-muted">{label}</dt>
            <dd
              className={cn("min-w-0 break-keep text-ink", label === "커밋" && "font-mono text-meta")}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 줄 아래의 PR 링크(줄 전체가 단추라 안에 둘 수 없어 형제로 둔다). */
export function JobPrLink({ pr }: { pr: { number: string; repo: string; href: string } }) {
  return (
    <a
      href={pr.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="work-job-pr"
      onClick={(event) => {
        // 데스크탑 셸(wry)에서는 target="_blank"가 죽은 컨트롤이다: OS 브라우저로 넘긴다.
        if (!isDesktop()) return;
        event.preventDefault();
        void openExternalUrl(pr.href);
      }}
      className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-md px-1 py-1 text-timestamp text-ink-muted press hover:text-ink focus-visible:focus-ring"
    >
      <GitPullRequest aria-hidden className="size-3 shrink-0" />
      <span className="truncate">
        {pr.number} · {pr.repo}
      </span>
      <span className="sr-only">새 탭에서 열기</span>
    </a>
  );
}

/**
 * 승인 대기 줄의 길: 카드가 있는 채널로 간다. 「작업」 화면은 승인 단추를 따로 갖지 않는다
 * (ADR-0202 D1·D5). 결정은 그 카드에서, 그 권한자가 한다.
 */
export function ApprovalCardLink({ channelId, channel }: { channelId: string; channel: string }) {
  return (
    <Link
      to={`/c/${channelId}`}
      data-testid="work-job-approval-link"
      className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-md px-1 py-1 text-timestamp font-medium text-ink press hover:bg-surface-hover focus-visible:focus-ring"
    >
      <ShieldCheck aria-hidden className="size-3 shrink-0 text-warn" />
      <span className="truncate">
        {WORK_JOBS_COPY.approvalAction} · {channel}
      </span>
    </Link>
  );
}

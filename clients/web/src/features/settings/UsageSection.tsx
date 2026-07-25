import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
// The one cost formatter in this client. A second rounding rule would mean two
// different answers to "how much did this cost" on two surfaces.
import { formatCount, formatMicroUsd } from "@/features/timeline/agentCardModel";
import { ApiError } from "@/lib/api";
import { fetchUsageSummary } from "./api";
import { errorMessage } from "./model";
import { SectionShell, StatusChip } from "./SettingsFields";
import {
  USAGE_BUCKETS,
  USAGE_PERIODS,
  barShare,
  budgetGrainLabel,
  budgetStatus,
  costConfidence,
  formatBucketStart,
  formatClock,
  formatIsoDay,
  formatRange,
  largestCost,
  parseUsageSummary,
  peakBucket,
  recallUsage,
  rememberUsage,
  usageErrorCopy,
  usageQuery,
  usageView,
  type UsageBucketUnit,
  type UsagePeriodId,
  type UsageSummary,
} from "./usageModel";

// =============================================================================
// 설정 > 사용량 (AX-7 1층, MOMO-616).
//
// Reading this as: a settings panel for internal team users on web+Tauri,
// density 7/10, motion 0/10.
//
// Costs are the one number in this product a person checks to decide whether to
// keep an agent running, so the panel is a dense ledger, not a dashboard: flat
// rows with a proportional bar, one grouped block for the totals, and no card
// per model. The bars are native <progress> elements because CSP is
// style-src 'self' and a data-driven width cannot come from an inline style;
// the platform control draws it from value/max.
//
// Everything on screen is server-reported. The client does not add up the
// ledger, does not decide which side of a budget limit the workspace is on, and
// does not turn an estimate into a bill: `estimatedMicroUsd` is stated as its
// own figure so the confidence of the total is visible rather than implied.
// =============================================================================

export function UsageSection({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const [period, setPeriod] = useState<UsagePeriodId>("30d");
  const [bucket, setBucket] = useState<UsageBucketUnit>("day");

  const query = useQuery({
    // The workspace id is lower-cased in the key: the same workspace arriving
    // upper-cased from a different surface must not open a second cache entry.
    queryKey: ["settings", "usage", workspaceId.toLowerCase(), period, bucket],
    queryFn: async () =>
      parseUsageSummary(
        await fetchUsageSummary(
          workspaceId,
          usageQuery(period, bucket, Date.now())
        )
      ),
    retry: false,
  });

  // Every successful answer becomes the fallback for the next failed one.
  useEffect(() => {
    if (query.data) {
      rememberUsage(workspaceId, query.data, query.dataUpdatedAt || Date.now());
    }
  }, [query.data, query.dataUpdatedAt, workspaceId]);

  const view = usageView({
    pending: query.isPending,
    data: query.data ?? null,
    dataUpdatedAtMs: query.dataUpdatedAt,
    errorMessage: query.isError
      ? usageErrorCopy(
          query.error instanceof ApiError ? query.error.status : null,
          errorMessage(query.error)
        )
      : null,
    offline,
    lastKnown: recallUsage(workspaceId),
    nowMs: Date.now(),
  });

  const lines = [
    "이 워크스페이스에서 에이전트가 쓴 비용과 토큰입니다.",
    "워크스페이스 멤버라면 누구나 볼 수 있습니다.",
  ];

  return (
    <SectionShell title="사용량" lines={lines}>
      <div
        className="flex flex-wrap items-center gap-4"
        data-testid="usage-controls"
      >
        <Segmented
          name="usage-period"
          label="기간"
          options={USAGE_PERIODS.map((p) => ({ id: p.id, label: p.label }))}
          value={period}
          onChange={(id) => setPeriod(id as UsagePeriodId)}
        />
        <Segmented
          name="usage-bucket"
          label="단위"
          options={USAGE_BUCKETS.map((b) => ({ id: b.id, label: b.label }))}
          value={bucket}
          onChange={(id) => setBucket(id as UsageBucketUnit)}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          data-testid="usage-refresh"
        >
          {query.isFetching ? "불러오는 중" : "새로 고치기"}
        </Button>
      </div>

      {view.kind === "loading" && <SkeletonRows rows={5} />}

      {view.kind === "error" && (
        <InlineBanner
          message={view.message}
          actionLabel="다시 시도"
          onAction={() => void query.refetch()}
          testId="usage-error"
        />
      )}

      {view.kind === "last-known" && (
        <div className="flex min-w-0 flex-col gap-3" data-testid="usage-last-known">
          {/* P15 durability layer: the cached answer keeps rendering, undimmed,
              with the instant it was confirmed stated next to it. */}
          <InlineBanner
            tone="neutral"
            message={view.notice}
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="usage-last-known-banner"
          />
          {/* The cached answer can cover a different range from the one the
              selector now shows, so the range is stated here as well as inside
              the block below. */}
          <p className="text-meta text-ink-muted">
            마지막 확인{" "}
            <time dateTime={new Date(view.checkedAtMs).toISOString()}>
              {formatClock(view.checkedAtMs)}
            </time>{" "}
            · {formatRange(view.summary.range)}
          </p>
          <UsageBody
            summary={view.summary}
            empty={view.empty}
            period={period}
            onWiden={() => setPeriod("30d")}
            onRetry={() => void query.refetch()}
          />
        </div>
      )}

      {view.kind === "ready" && (
        <UsageBody
          summary={view.summary}
          empty={view.empty}
          period={period}
          onWiden={() => setPeriod("30d")}
          onRetry={() => void query.refetch()}
        />
      )}
    </SectionShell>
  );
}

// ---- the panel body, shared by the fresh and the last-known views ------------

function UsageBody({
  summary,
  empty,
  period,
  onWiden,
  onRetry,
}: {
  summary: UsageSummary;
  empty: boolean;
  period: UsagePeriodId;
  onWiden: () => void;
  onRetry: () => void;
}) {
  if (empty) {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="usage-body">
        <p className="text-meta text-ink-muted">{formatRange(summary.range)}</p>
        <EmptyInvite
          headline="이 기간에 기록된 사용량이 없습니다."
          detail="에이전트가 실행되면 모델별, 에이전트별 비용이 여기에 쌓입니다."
          testId="usage-empty"
          actions={
            period === "7d" ? (
              <Button variant="outline" size="sm" onClick={onWiden}>
                30일로 보기
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onRetry}>
                다시 불러오기
              </Button>
            )
          }
        />
      </div>
    );
  }

  const confidence = costConfidence(summary.totals);
  const peak = peakBucket(summary.buckets);
  const modelMax = largestCost(summary.byModel);
  const agentMax = largestCost(summary.byAgent);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="usage-body">
      <div
        className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface-raised p-4"
        data-testid="usage-totals"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-meta text-ink-muted">{formatRange(summary.range)}</p>
          {confidence.allSettled ? (
            <StatusChip tone="ok">확정 값</StatusChip>
          ) : (
            <StatusChip tone="warn">추정 포함</StatusChip>
          )}
        </div>

        <p
          className="font-mono text-display font-semibold text-ink"
          data-numeric=""
          data-testid="usage-total-cost"
        >
          {formatMicroUsd(summary.totals.costMicroUsd)}
        </p>
        <p className="text-meta text-ink-muted">
          {confidence.allSettled
            ? "provider가 확정한 청구 값입니다."
            : "provider가 아직 확정하지 않은 부분이 있어 두 값을 나눠 적습니다."}
        </p>

        <dl className="flex min-w-0 flex-col gap-2">
          {!confidence.allSettled && (
            <>
              <NumberRow
                term="확정"
                value={formatMicroUsd(confidence.settledMicroUsd)}
              />
              <NumberRow
                term="추정"
                value={`${formatMicroUsd(confidence.estimatedMicroUsd)} (${confidence.estimatedPercent}%)`}
                testId="usage-estimated"
              />
            </>
          )}
          <NumberRow
            term="입력 토큰"
            value={formatCount(summary.totals.promptTokens)}
          />
          <NumberRow
            term="출력 토큰"
            value={formatCount(summary.totals.completionTokens)}
          />
          {peak && (
            <NumberRow
              term={`가장 비쌌던 ${bucketNoun(summary.range.bucket)}`}
              value={`${formatBucketStart(peak.start, summary.range.bucket)} · ${formatMicroUsd(peak.costMicroUsd)}`}
            />
          )}
        </dl>
      </div>

      <BudgetBlock summary={summary} />

      <Breakdown
        title="모델별"
        testId="usage-model"
        emptyCopy="이 기간에 기록된 모델이 없습니다."
        rows={summary.byModel.map((row) => ({
          key: row.model,
          label: row.model,
          costMicroUsd: row.costMicroUsd,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          share: barShare(row.costMicroUsd, modelMax),
        }))}
      />

      <Breakdown
        title="에이전트별"
        testId="usage-agent"
        emptyCopy="이 기간에 기록된 에이전트가 없습니다."
        rows={summary.byAgent.map((row) => ({
          key: row.agentMemberId,
          label: row.displayName || row.agentMemberId,
          costMicroUsd: row.costMicroUsd,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          share: barShare(row.costMicroUsd, agentMax),
        }))}
      />

      {summary.buckets.length > 0 && (
        <details className="min-w-0 rounded-md border border-line" data-testid="usage-buckets">
          <summary className="cursor-pointer px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            기간별 자세히 ({summary.buckets.length}개 구간)
          </summary>
          <ul className="max-h-pane overflow-y-auto border-t border-line">
            {summary.buckets.map((row) => (
              <li
                key={row.start}
                className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line px-3 py-1 last:border-b-0"
                data-testid="usage-bucket-row"
              >
                <span className="min-w-0 truncate text-meta text-ink">
                  {formatBucketStart(row.start, summary.range.bucket)}
                </span>
                <span
                  className="shrink-0 font-mono text-meta text-ink"
                  data-numeric=""
                >
                  {formatMicroUsd(row.costMicroUsd)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function bucketNoun(bucket: UsageBucketUnit): string {
  if (bucket === "week") return "주";
  if (bucket === "month") return "달";
  return "날";
}

// ---- parts ------------------------------------------------------------------

/** One dense key/value line. dt left and muted, dd right and monospaced. */
function NumberRow({
  term,
  value,
  testId,
}: {
  term: string;
  value: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="min-w-0 truncate text-meta text-ink-muted">{term}</dt>
      <dd
        className="shrink-0 font-mono text-meta text-ink"
        data-numeric=""
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}

interface BreakdownRow {
  key: string;
  label: string;
  costMicroUsd: number;
  promptTokens: number;
  completionTokens: number;
  share: number;
}

/**
 * Flat rows with a bar, not a card per row. The bar is relative to the largest
 * row rather than to the total, so the second and third lines stay readable
 * when one model dominates, and it is aria-hidden because the exact figure is
 * already text on the same line.
 */
function Breakdown({
  title,
  rows,
  emptyCopy,
  testId,
}: {
  title: string;
  rows: BreakdownRow[];
  emptyCopy: string;
  testId: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-body font-medium text-ink">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-meta text-ink-muted">{emptyCopy}</p>
      ) : (
        <ul className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line">
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex min-w-0 flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0"
              data-testid={`${testId}-row`}
            >
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-body text-ink">
                  {row.label}
                </span>
                <span
                  className="shrink-0 font-mono text-body text-ink"
                  data-numeric=""
                >
                  {formatMicroUsd(row.costMicroUsd)}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-3">
                <progress
                  className="progress-bar min-w-0 flex-1"
                  value={row.share}
                  max={100}
                  aria-hidden="true"
                />
                <span className="shrink-0 text-timestamp text-ink-muted">
                  입력{" "}
                  <span className="font-mono" data-numeric="">
                    {formatCount(row.promptTokens)}
                  </span>{" "}
                  · 출력{" "}
                  <span className="font-mono" data-numeric="">
                    {formatCount(row.completionTokens)}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Budget state as the server projected it. No enforcement is claimed here. */
function BudgetBlock({ summary }: { summary: UsageSummary }) {
  const budget = summary.budget;
  if (!budget) {
    return (
      <p className="text-meta text-ink-muted" data-testid="usage-budget-none">
        이 워크스페이스에는 설정된 예산이 없습니다. 합계는 계속 기록됩니다.
      </p>
    );
  }

  const status = budgetStatus(budget, formatMicroUsd);

  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface-raised p-4"
      data-testid="usage-budget"
      data-budget-state={budget.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-body font-medium text-ink">예산</h3>
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
      </div>
      <progress
        className="progress-bar"
        value={status.usedPercent}
        max={100}
        aria-hidden="true"
      />
      <p
        className={cn(
          "text-meta",
          status.tone === "danger" ? "text-danger" : "text-ink-muted"
        )}
      >
        {status.detail}
      </p>
      <dl className="flex min-w-0 flex-col gap-2">
        <NumberRow term="적용 범위" value={budgetGrainLabel(budget.grain)} />
        <NumberRow
          term="사용"
          value={formatMicroUsd(budget.spentMicroUsd)}
        />
        <NumberRow
          term="예약"
          value={formatMicroUsd(budget.reservedMicroUsd)}
        />
        <NumberRow term="한도" value={formatMicroUsd(budget.limitMicroUsd)} />
        {budget.periodStart && (
          <NumberRow
            term="예산 기간 시작"
            value={formatIsoDay(budget.periodStart)}
          />
        )}
      </dl>
    </section>
  );
}

/**
 * Segmented choice on native radios: the browser already gives one tab stop for
 * the group, arrow-key roving inside it, and the grouping a screen reader
 * announces. The input stays focusable and drives the label through `peer`, so
 * nothing about the keyboard path is reimplemented in JS.
 */
function Segmented({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const labelId = `${name}-label`;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span id={labelId} className="text-meta text-ink-muted">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex overflow-hidden rounded-sm border border-line"
      >
        {options.map((option) => (
          <label
            key={option.id}
            className="border-l border-line first:border-l-0"
            data-testid={`${name}-${option.id}`}
          >
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
              className="peer sr-only"
            />
            <span className="block cursor-pointer px-3 py-1 text-meta text-ink-muted hover:bg-surface-hover peer-checked:bg-accent-soft peer-checked:text-ink peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-accent">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
